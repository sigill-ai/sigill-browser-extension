# Sigill Browser Extension

[![tests](https://github.com/sigill-ai/sigill-browser-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/sigill-ai/sigill-browser-extension/actions/workflows/ci.yml)

Verifiable records of your AI conversations on **claude.ai**, **chatgpt.com**
and **gemini.google.com**, sealed and timestamped turn by turn with
[Sigill](https://sigill.ai). Only digests leave your browser.

Install from the
[Chrome Web Store](https://chromewebstore.google.com/detail/behfnnjgaoacljokaeadabniafanfgbp)
or load this repo unpacked.

## What it does

Every completed conversation turn is captured from the platform's **own API
stream** — real message IDs, the actual model identifier, and true completion
events, not screen scraping. Each conversation is recorded as one
[Agent Evidence Profiles v1](https://github.com/sigill-ai/sigill-dotnet/blob/main/spec/agent-profiles-common-v1.md)
run, under the
[client-observed conventions](https://github.com/sigill-ai/sigill-dotnet/blob/main/spec/agent-client-observed-v1.md):

- **Before** — a Control Artifact seals what the recorder does and its settings.
- **Each turn** — one event with the prompt, attached files and the answer as
  SHA-256 digests, chained to the previous event by its signature, sealed by
  Sigill and timestamped (RFC 3161).
- **Generated files** — files the assistant produces are recorded by digest
  when you download them.
- **After** — a conversation idle for 30 minutes is closed with a timestamped
  final event, which freezes the run. A later turn starts a new segment.

Runs appear under **Evidence** in Sigill. Export a run and anyone can verify it
at [sigill.ai/verify-run](https://sigill.ai/verify-run) or with the
[.NET](https://github.com/sigill-ai/sigill-dotnet) and
[Python](https://github.com/sigill-ai/sigill-python) SDKs — the same format the
Sigill plugin for Claude Code and the SDKs record.

**Sign-in.** *Sign in with Sigill* (OAuth with PKCE) connects the extension to
your organisation with one permission: record conversations. There is no API
key, and the extension never reads your sigill.ai session. Disconnect in the
popup or under Settings → Connected apps.

Recording uses the organisation's **agent evidence** quota, separate from
document seals. Runs are sealed with the Sigill Platform Seal unless you choose
one of your organisation's own certificates in the popup.

## What it proves — and what it doesn't

- **Proves:** the recorded prompts, answers and files (by digest) are
  unchanged since they were sealed and timestamped, in the recorded order,
  under one signer, and the recorder's control basis was sealed before the
  first turn.
- **Does not prove:** that every turn was recorded (the extension may have
  been off, or a turn unparseable — incomplete turns are never sealed), that
  the platform produced exactly what the browser received, or which model
  answered beyond what the platform reported. This is *client-observed*
  evidence: it attests what reached the browser. For runtime-controlled
  capture, record with the Sigill SDKs server-side.

Versions before 0.6 kept a local hash-chained ledger with RFC 3161 stamps
(`AiEvidenceEnvelopeV1`). That ledger is kept read-only and is still exported;
[`tools/verify-bundle.js`](tools/verify-bundle.js) verifies it offline.

## Privacy

Conversation content is processed and stored **locally on your device**. What
leaves the browser, exhaustively, to `api.sigill.ai`: SHA-256 digests, the
signed evidence envelopes (identifiers, times, the model a platform reported,
and digests — never content, never your platform account or conversation ids,
which appear only as one-way references) and the sign-in exchange. No
analytics, no telemetry. Full details:
[extension privacy policy](https://sigill.ai/browser-extension-policy).

## Architecture

```
page (MAIN world)                ISOLATED world            service worker
┌───────────────────┐ postMessage ┌──────────┐ sendMessage ┌──────────────────┐
│ interceptor.js    │ ──────────► │ relay.js │ ──────────► │ worker.js        │
│ observes fetch/   │             │ validate │             │ adapters → turn  │
│ XHR streams, tees │             │ + batch  │             │ → run event →    │
│ never modifies    │             └──────────┘             │ seal (MCP)       │
└───────────────────┘                                      └──────────────────┘
```

- [`content/interceptor.js`](content/interceptor.js) — wraps `fetch`/XHR at
  `document_start`, tees response streams. Pure observer: the page always
  receives the original bytes.
- [`lib/turn-adapters.js`](lib/turn-adapters.js) — per-platform stream parsers
  producing normalized TurnRecords. Designed to **fail loudly**: unknown
  stream shapes surface as warnings and incomplete turns are never stamped.
- [`lib/agent-evidence.js`](lib/agent-evidence.js) — Agent Evidence Profiles
  envelopes, JCS, binding digests and the structural check of each seal's
  timestamp; [`lib/conversation-recorder.js`](lib/conversation-recorder.js) —
  conversation → run, crash-safe commit, idle closure, indexing.
- [`lib/sigill-auth.js`](lib/sigill-auth.js) /
  [`lib/sigill-mcp.js`](lib/sigill-mcp.js) — sign-in (PKCE, single-use refresh)
  and Sigill's recording tools.
- [`lib/evidence-envelope.js`](lib/evidence-envelope.js) /
  [`lib/evidence-ledger.js`](lib/evidence-ledger.js) — the read-only v1 ledger.
- [`docs/network-capture.md`](docs/network-capture.md) — the full design log.

## Development

```sh
# run the regression suites (pure Node, no browser needed)
node test/adapters.test.js
node test/envelope.test.js
node test/ledger.test.js
node test/agent-evidence.test.js

# build the distribution zip (runs the suites first, strips dev tooling)
tools/pack.sh
```

The fixtures in [`test/fixtures/`](test/fixtures/) are **real captured
traffic** — the author's own throwaway conversations, sanitized by
[`tools/scrub-fixtures.py`](tools/scrub-fixtures.py). They are the contract:
the central assertion is that answer text reconstructed from a completion
*stream* byte-equals what the platform's own *history endpoint* reports for
the same message ID. When a platform changes its wire format, a fixture
export reproduces the failure and becomes the regression test — that loop has
already caught one serving change in the wild.

Dev builds (any checkout with `version_name: "x.y.z-dev"` in the manifest,
i.e. this repo loaded unpacked) get extra tooling: an in-page capture debug
overlay (`Alt+Shift+D`), a fixture recorder, and a Developer section in the
popup. `tools/pack.sh` strips all of it from the public build.

To develop against live sites: load the repo unpacked at
`chrome://extensions`, browse a supported platform, and watch the overlay.
The manifest's `key` gives the unpacked build the store ID, so Sigill sign-in
works unchanged; remove or disable the store version first (one ID, one
install). `tools/pack.sh` strips the key from the store build.
To add a fixture: popup → Developer → Export, drop the file in
`test/fixtures/`, run the scrubber, write assertions.

## License

[Apache 2.0](LICENSE) © Sigill AS
