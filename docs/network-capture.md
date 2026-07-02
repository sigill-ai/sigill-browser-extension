# Network-layer capture

Goal: move evidence capture from the rendered DOM (heuristic, silently lossy) to
the platform's own API traffic (event-based, fails loudly).

**Status — network stamping is live (phase 2a).** Finished captures are parsed
by `lib/turn-adapters.js` in the worker; complete turns are mapped onto
AiEvidenceEnvelopeV1 by `lib/evidence-envelope.js` (real model string, message
IDs, `processingMetadata`, capture-method disclosure in `output.metadata`,
dedup by platform message ID, stable pseudonymous `actor.id` when no Sigill
identity is connected), hashed, stamped, and logged. The worker then notifies
the tab and a badge is placed (by `data-message-id` on ChatGPT,
last-assistant-element elsewhere). The DOM pipeline no longer stamps unless the
popup's "Stamp from network capture" toggle is switched off. Tests:
`node test/adapters.test.js` and `node test/envelope.test.js`.

**Phase 2b — chained ledger + anchors (done).** Envelopes are stored wrapped
in chained records (`lib/evidence-ledger.js`: `{seq, prevHash, envelope,
recordHash}`); a legacy flat log migrates automatically. A `chrome.alarms` job
stamps the chain head hourly (skipped when unchanged) — one RFC 3161 stamp
bounds tampering of everything before it. Export and Seal both produce a
self-contained evidence bundle (records + anchors); `tools/verify-bundle.js`
validates one offline: envelope hashes, chain links, anchor consistency, and
TSR extraction for OpenSSL. `node test/ledger.test.js` proves tamper detection
(edits, deletions, reordering, and full post-anchor chain rewrites).

**Phase 3a — attachments (done).** Files the user attaches (file picker,
drag-drop, paste) are SHA-256-hashed in the content script — bytes never leave
the page — and wait per-tab (`pendingAttachments`, 60-min TTL) until the next
completion turn claims them as hash-only `inputs` payloadRefs. Adapters report
`attachmentCount` where the request declares it (Claude: `attachments`+`files`
arrays; ChatGPT: `metadata.attachments` when present; Gemini: unknown), so a
declared 0 provably detaches pending files from the wrong turn, and any
declared-vs-observed mismatch lands in the envelope's capture warnings.
All three platforms declare attachments in their requests (ChatGPT:
`metadata.attachments` with id+name+size; Claude: `files` uuids; Gemini:
`f.req[0][3]` with contrib-service ref + filename + mime, explicit null on
text-only turns). Each locally hashed file is bound to the platform's own
file id — match passes strongest-first: exact size, exact filename, then the
unambiguous 1:1 case — so `inputs[].metadata.platformFileId` ties the local
hash to the asset the provider processed. Verified live 2026-07-02 (bundle
with image upload passed `tools/verify-bundle.js`).

**Phase 3b — generated files (built, pending live verification).** Three
observation points cooperate: the interceptor hashes Blobs at
`URL.createObjectURL` time (the only moment client-built file bytes are
observable); ChatGPT's `/interpreter/download` call (now full-captured) ties
message_id + sandbox_path + signed URL to the upcoming download; and
`chrome.downloads` provides the completed download to match against both.
Matched downloads become **artifact envelopes** chained into the ledger,
linked to the parent turn via `activity.parentEvidenceId`, in three disclosed
honesty classes (`metadata.hashSource`): `blob-observed` (bytes hashed at
creation — strongest), `refetch` (immediate second fetch of the same signed
URL on a permitted host, size-checked against the browser's downloaded size —
corroborates, does not byte-verify), `none` (download event only, inline
metadata that says so). Unattributable downloads are ignored entirely.
Verified live 2026-07-02: ChatGPT interpreter downloads use direct signed URLs
(`/backend-api/estuary/content`), so `refetch` is their expected class; the
`/interpreter/download` response also binds `metadata.file_id` into the record.

**Turns declare their generated files at stamp time** (verified on all three
platforms): ChatGPT via `sandbox:` links in the answer, Claude via
`present_files` tool results (file_path + mime_type), Gemini via signed
`usercontent.google.com/download?...&filename=` URLs in the snapshots. The
declarations go into the stamped turn (`output.metadata.generatedFiles`,
signed URLs excluded) and into the local artifact-link store, so a later
download matches by exact storage token (Gemini `c=`), signed-URL base
(ChatGPT), or sandbox filename (Claude/ChatGPT) — and links back to the exact
parent envelope. Claude's `wiggle/download-file` URL also embeds the
conversation id as a parent fallback. Gemini downloads from
`*.usercontent.google.com` are only ever attributed via a stream-declared
token match — never by host.

**Ship prep (v0.5.0, 2026-07-02).** The DOM-scraping pipeline is gone:
`content/claude.js` / `chatgpt.js` / `gemini.js` deleted, `content/shared.js`
reduced to badge display. Placement is a convergent ensure-loop, not one-shot
— platforms (Claude especially) re-render messages after streaming completes
and wipe injected nodes, so the loop re-injects whenever a badge disappears.
Resolution: by `data-message-id` (ChatGPT), by position index (Claude — the
worker parses the captured history GET, walks the current branch, and sends
the tab ledger-matched placements as `BADGE_POSITIONS`), or last-assistant
element within 30s of stamping (live fallback; Gemini is live-only).
`GET_STAMPED_TURNS` returns only IDs — no conversation content flows to
content scripts. Network capture is the only stamping source, no toggle. All developer tooling (debug overlay, debug log, fixture recorder,
popup Developer section) is gated on dev builds — detected via
`!chrome.runtime.getManifest().update_url`, i.e. unpacked = dev, store install
= production. The API key moved from `storage.sync` (synced plaintext) to
`storage.local` with automatic migration; the popup reads/writes it via
worker messages (`GET_API_KEY` / `SET_API_KEY`).

Remaining ideas (post-ship): hash-only privacy mode, badge-by-ID on
Claude/Gemini (currently last-assistant-element fallback), capture-health
canary UI, schema 1.1 `capture` block.

## Architecture

```
page (MAIN world)                 ISOLATED world              service worker
┌────────────────────┐  postMessage  ┌──────────┐  sendMessage  ┌─────────────┐
│ interceptor.js     │ ────────────► │ relay.js │ ────────────► │ worker.js   │
│ wraps fetch + XHR, │               │ validate │               │ fixture     │
│ tees streams,      │               │ + batch  │               │ store       │
│ never modifies     │               └──────────┘               └─────────────┘
└────────────────────┘                    │ 'sigill:debug' DOM events
                                          ▼
                                   debug overlay (Alt+Shift+D)
```

- **`content/interceptor.js`** (MAIN world, `document_start`) — patches
  `window.fetch` and `XMLHttpRequest` before the app's JS captures references.
  For matching endpoints it clones the request body and tees the response
  stream via `Response.clone()`; the page always receives the original,
  untouched. WebSocket/EventSource construction is logged (URL only, no
  payloads) as a canary in case a platform moves chat off fetch/XHR.
- **`content/relay.js`** (ISOLATED world, `document_start`) — bridge to
  `chrome.runtime`. Treats the MAIN world as semi-trusted: shape-validates and
  size-caps every event before forwarding. Dispatches `sigill:debug` events so
  the overlay shows `net_start` / `net_end` / `net_transport` rows live.
- **`background/worker.js`** — assembles events into one fixture per request
  (URL, method, request body, status, timed response chunks) and persists
  completed captures to `chrome.storage.local` under `fixtures` (last 20
  captures / 20 MB, oldest dropped).

## Endpoints captured

Matchers test the URL pathname only — query strings like `?conversation_id=…`
false-positive on substring tests.

| Platform | Full capture (body + stream) | Metadata only |
|---|---|---|
| claude.ai | `/completion`, `/retry_completion`, `*/chat_conversations*` | — |
| chatgpt.com | `/backend-api[/f]/conversation` (completion POST), `/backend-api/conversation/<uuid>` (history GET) | other `/backend-*` paths containing `conversation` (init, prepare, stream_status, textdocs, autocompletions) |
| gemini.google.com | `*StreamGenerate*` (XHR) | `*batchexecute*` |

Auth headers and cookies are never recorded — only URL, method, content-type,
request body, and response text. Autocompletion endpoints (draft keystrokes)
are deliberately metadata-only.

## The fixture loop

1. Load the extension unpacked (`chrome://extensions` → Developer mode →
   Load unpacked). "Record fixtures" in the popup is on by default.
2. On each platform, run one conversation exercising the hard cases: a normal
   turn, a regenerated answer, an edited prompt, extended thinking / "Thought
   for…", a file upload, an artifact/canvas response.
3. Popup → Network capture → **Export** downloads `sigill-fixtures-*.json`.
4. The debug overlay (Alt+Shift+D) shows capture health in real time: a
   `net_start` with no matching `net_end`, zero chunks on a chat turn, or a
   `net_transport` (WebSocket) row on chatgpt.com all indicate the matcher or
   transport assumptions need adjusting.

Fixtures drive Phase 2: protocol adapters that turn each captured stream into a
normalized TurnRecord (conversation ID, message ID, parent ID, real model
string, stop reason, timings) which maps ~1:1 onto `AiEvidenceEnvelopeV1`
(`processingMetadata`, `model`, `inputs`, `outputArtifacts`).

**Status: the adapters exist** — `lib/turn-adapters.js`, pure functions with no
chrome.* dependencies, loadable from the worker (importScripts) and Node
(require). `node test/adapters.test.js` runs them against the captured traffic
in `test/fixtures/`; the central check is that stream-reconstructed answer text
exactly matches the platform's own history endpoint for the same message ID.
Stream shapes per platform:

- **chatgpt** — SSE `delta_encoding: v1`, patch-op deltas (`o`/`p`/`v`),
  lifecycle events with a `type` field; the answer is the message flagged by
  `message_marker: final_channel`; `message_stream_complete` is terminal.
  Regenerate = `action: "variant"` (no new user message); edit = new user
  message forking the tree. History GET `mapping` is lineage ground truth.
- **claude** — standard Anthropic SSE; `message_start` carries uuid + real
  model string; typed content blocks separate thinking from text
  (incl. `thinking_summary_delta`); `message_delta.stop_reason` +
  `message_stop`. Conversation GET lists messages with `parent_message_uuid`.
- **gemini** — XHR, anti-XSSI `)]}'` prefix, length-prefixed `wrb.fr` frames,
  each a *cumulative snapshot* (last one = full answer). IDs: `c_`
  (conversation), `r_` (response), `rc_` (candidate/draft). No model string in
  the stream; the `bl=` build label is the closest version marker.

## Known limits (by design, this phase)

- Stamping still runs off the DOM pipeline; nothing network-captured is stamped yet.
- If the service worker is restarted mid-stream, the capture resumes as a stub
  flagged `resumedWithoutStart: true` (late chunks are kept, the request body is lost).
- Fixtures contain your own conversation content in cleartext, stored locally
  only and exported only by explicit click. Review before sharing.
- Requests made from web workers or service workers of the platform would be
  invisible to a MAIN-world patch; none of the three platforms do this today —
  the overlay canary is how we'd notice.
