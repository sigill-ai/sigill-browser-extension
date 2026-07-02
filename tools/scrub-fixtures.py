#!/usr/bin/env python3
"""Sanitize test fixtures for public release.

The fixtures under test/fixtures/ are real captured traffic (the author's own
throwaway conversations — intentionally published as the adapter regression
suite). This script removes everything account-linked or location-derived
while preserving the structure the tests assert on. Idempotent; run after
adding a new fixture and re-run the test suites to confirm nothing broke:

  python3 tools/scrub-fixtures.py && node test/adapters.test.js

Transforms, exhaustively:
  - Claude organization UUIDs in URLs        -> fixed placeholder UUID
  - conversation-LIST captures (titles of    -> dropped entirely
    unrelated conversations)                    (chat_conversations_v2)
  - JWT-shaped tokens (resume tokens etc.)   -> "REDACTED.JWT.REDACTED"
  - IP-derived locations + map-tile URLs     -> "Oslo, Norway" / redacted
  - Gemini session ids (f.sid, _reqid)       -> zeroed
  - Gemini contrib-service upload refs       -> token tail redacted
  - signed-URL auth params (sig=, ts=, c=)   -> redacted (host/path/filename
                                                kept — adapters assert those)
  - provider trace/request ids               -> redacted
  - ChatGPT custom-instructions profile      -> value replaced (the platform
    (about_user_message + quoted copies)        embeds the user's own bio in
                                                system messages in the stream)
  - base64 blobs in widget URL fragments     -> redacted
  - remaining city/region mentions           -> "Oslo"
"""
import glob
import json
import re

ORG_PLACEHOLDER = 'cccccccc-0000-4000-8000-cccccccccccc'

RE_ORG = re.compile(r'(organizations/)[0-9a-f-]{36}')
RE_JWT = re.compile(r'eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){1,2}')
RE_FSID = re.compile(r'(f\.sid=)-?\d+')
RE_REQID = re.compile(r'(_reqid=)\d+')
RE_SIG = re.compile(r'([?&]sig=)[0-9a-f]+')
RE_TS = re.compile(r'([?&]ts=)\d+')
RE_C_TOKEN = re.compile(r'([?&]c(?:=|\\\\u003d))[A-Za-z0-9_-]{20,}')
RE_CONTRIB = re.compile(r'(/contrib_service/ttl_1d/)[A-Za-z0-9_-]{20,}')
RE_TRACE = re.compile(r'("trace_id"\s*:\s*")[0-9a-f]{16,}(")')
RE_REQUEST_ID = re.compile(r'("request_id"\s*:\s*")req_[A-Za-z0-9]+(")')
RE_MAPS = re.compile(r'(google\.com/maps/vt/data=)[A-Za-z0-9_-]+')
RE_LOCATION = re.compile(r'(Malvik|Trondheim), Norway')
# ChatGPT embeds the user's custom instructions in system messages, in
# several fields: "about_user_message" and "user_profile" (the bio) and
# "user_instructions" (response preferences — can contain emails, employer
# names, anything the user typed). Redact all three values wholesale, plus
# the quoted "User profile" fenced block inside system message text.
RE_ABOUT_USER = re.compile(r'("(?:about_user_message|user_profile|user_instructions)"\s*:\s*")(?:[^"\\]|\\.)*(")')
RE_PROFILE_BLOCK = re.compile(r'(User profile:\\n```)(?:[^`]|`(?!``))*(```)')
RE_URL_FRAGMENT_B64 = re.compile(r'(#)eyJ[A-Za-z0-9+/=_-]{20,}')
RE_CITY = re.compile(r'Trondheim|Tr[oø]ndelag|Malvik')
RE_EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@(?!sigill\.ai)[A-Za-z0-9.-]+\.[A-Za-z]{2,}')


def scrub_text(s: str, orgs=()) -> str:
    # Org ids appear in more than one URL shape (organizations/<id>,
    # /api/<id>/files/... thumbnails) — purge every occurrence of ids
    # collected from anywhere in the file.
    for org in orgs:
        s = s.replace(org, ORG_PLACEHOLDER)
    s = RE_ORG.sub(r'\g<1>' + ORG_PLACEHOLDER, s)
    s = RE_JWT.sub('REDACTED.JWT.REDACTED', s)
    s = RE_FSID.sub(r'\g<1>0', s)
    s = RE_REQID.sub(r'\g<1>0', s)
    s = RE_SIG.sub(r'\g<1>REDACTED', s)
    s = RE_TS.sub(r'\g<1>0', s)
    s = RE_C_TOKEN.sub(r'\g<1>REDACTED', s)
    s = RE_CONTRIB.sub(r'\g<1>REDACTED', s)
    s = RE_TRACE.sub(r'\g<1>REDACTED\g<2>', s)
    s = RE_REQUEST_ID.sub(r'\g<1>req_REDACTED\g<2>', s)
    s = RE_MAPS.sub(r'\g<1>REDACTED', s)
    s = RE_LOCATION.sub('Oslo, Norway', s)
    s = RE_ABOUT_USER.sub(r'\g<1>REDACTED\g<2>', s)
    s = RE_PROFILE_BLOCK.sub(r'\g<1>REDACTED\g<2>', s)
    s = RE_URL_FRAGMENT_B64.sub(r'\g<1>REDACTED', s)
    s = RE_CITY.sub('Oslo', s)
    s = RE_EMAIL.sub('redacted@example.com', s)
    return s


def scrub_capture(capture: dict, orgs=()) -> dict:
    for key in ('url', 'requestBody'):
        if isinstance(capture.get(key), str):
            capture[key] = scrub_text(capture[key], orgs)
    for chunk in capture.get('chunks') or []:
        if isinstance(chunk.get('text'), str):
            chunk['text'] = scrub_text(chunk['text'], orgs)
    return capture


def main() -> None:
    for path in sorted(glob.glob('test/fixtures/*.json')):
        raw = open(path).read()
        # Claude org ids appear as organizations/<id> and as /api/<id>/files
        # (thumbnails) — collect from both so re-runs stay idempotent even
        # after the canonical context is already scrubbed.
        orgs = {
            o
            for pattern in (r'organizations/([0-9a-f-]{36})', r'/api/([0-9a-f-]{36})/')
            for o in re.findall(pattern, raw.replace('\\/', '/'))
            if o != ORG_PLACEHOLDER
        }
        fixtures = json.loads(raw)
        # Conversation-list responses leak titles of unrelated conversations
        # and are not consumed by any adapter — drop the captures outright.
        kept = [c for c in fixtures if 'chat_conversations_v2' not in (c.get('url') or '')]
        dropped = len(fixtures) - len(kept)
        kept = [scrub_capture(c, orgs) for c in kept]
        json.dump(kept, open(path, 'w'), indent=1)
        note = f' (dropped {dropped} conversation-list capture(s))' if dropped else ''
        print(f'scrubbed {path}{note}')


if __name__ == '__main__':
    main()
