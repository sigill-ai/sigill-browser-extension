# Sigill Browser Extension

[![tests](https://github.com/sigill-ai/sigill-browser-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/sigill-ai/sigill-browser-extension/actions/workflows/ci.yml)

Tamper-evident, cryptographically timestamped records of your AI conversations
on **claude.ai**, **chatgpt.com**, and **gemini.google.com**. Only hashes leave
your browser.

Built by [Sigill](https://sigill.ai). Install from the
[download page](https://sigill.ai/browser-extension) or load this repo unpacked.

## What it does

Every completed conversation turn is captured from the platform's **own API
stream** — real message IDs, the actual model identifier, and true completion
events, not screen scraping. Each turn becomes an
[`AiEvidenceEnvelopeV1`](spec/ai-evidence-envelope.v1.json): canonicalized with
RFC 8785 (JCS), hashed with SHA-256, and timestamped by an RFC 3161 Timestamp
Authority via [api.sigill.ai](https://sigill.ai).

- **Chained ledger** — envelopes are stored locally in a hash-chained log;
  an hourly anchor stamp over the chain head bounds tampering of everything
  before it. Deleting, editing, or reordering records is detectable.
- **Files, both directions** — attachments are SHA-256-hashed locally (bytes
  never leave the page) and bound to the platform's own file IDs; files the AI
  generates are stamped at download time with their provenance disclosed.
- **Offline verification** — the exported evidence bundle is validated by
  [`tools/verify-bundle.js`](tools/verify-bundle.js) with no Sigill dependency,
  down to `openssl ts` on the raw timestamp tokens.
- **Sealing (CAdES)** — one click signs the whole evidence bundle with a
  detached CAdES signature under your Sigill certificate (qualified
  certificates supported). The bundle is hashed locally and only the hash is
  signed — sealing never uploads conversation content. The result is a
  portable bundle + `.p7s` pair that any standard signature validator accepts,
  turning "my local log" into a signed document attributable to you.

## What it proves — and what it doesn't

Precision about claims is the product, so, precisely:

- **Proves:** the recorded conversation content existed at the asserted time
  (RFC 3161 timestamp over the envelope hash), and that the local log has not
  been reordered or rewritten since its last anchor (hash chain + anchor
  stamps).
- **Discloses:** every envelope carries its capture method
  (`capture.method: "network"`, extension version, adapter warnings) and file
  hashes state their provenance class (`blob-observed`, `refetch`, or `none`).
- **Does not prove:** this is *client-observed* evidence. It attests what the
  browser received from the platform — it cannot rule out manipulation by the
  party operating the browser. For runtime-controlled capture, use the Sigill
  SDK or gateway server-side.

## Privacy

Conversation content is processed and stored **locally on your device**. What
leaves the browser, exhaustively: SHA-256 hashes and your API key to
`api.sigill.ai`. No analytics, no telemetry. Full details:
[extension privacy policy](https://sigill.ai/browser-extension-policy).

## Architecture

```
page (MAIN world)                ISOLATED world            service worker
┌───────────────────┐ postMessage ┌──────────┐ sendMessage ┌──────────────────┐
│ interceptor.js    │ ──────────► │ relay.js │ ──────────► │ worker.js        │
│ observes fetch/   │             │ validate │             │ adapters → turn  │
│ XHR streams, tees │             │ + batch  │             │ → envelope →     │
│ never modifies    │             └──────────┘             │ stamp → ledger   │
└───────────────────┘                                      └──────────────────┘
```

- [`content/interceptor.js`](content/interceptor.js) — wraps `fetch`/XHR at
  `document_start`, tees response streams. Pure observer: the page always
  receives the original bytes.
- [`lib/turn-adapters.js`](lib/turn-adapters.js) — per-platform stream parsers
  producing normalized TurnRecords. Designed to **fail loudly**: unknown
  stream shapes surface as warnings and incomplete turns are never stamped.
- [`lib/evidence-envelope.js`](lib/evidence-envelope.js) /
  [`lib/evidence-ledger.js`](lib/evidence-ledger.js) — envelope construction
  per the [schema](spec/ai-evidence-envelope.v1.json), JCS canonicalization,
  and the hash chain.
- [`docs/network-capture.md`](docs/network-capture.md) — the full design log.

## Development

```sh
# run the regression suites (pure Node, no browser needed)
node test/adapters.test.js
node test/envelope.test.js
node test/ledger.test.js

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
To add a fixture: popup → Developer → Export, drop the file in
`test/fixtures/`, run the scrubber, write assertions.

## License

[Apache 2.0](LICENSE) © Sigill AS
