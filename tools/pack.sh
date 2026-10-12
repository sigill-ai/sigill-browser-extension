#!/usr/bin/env bash
# Build the public distribution zip for the Sigill browser extension.
#
#   tools/pack.sh [output.zip]
#
# Ships only runtime files and strips the "-dev" version_name from the
# manifest — that suffix is what enables the developer tooling (debug overlay,
# fixture recorder, popup Developer section), so the public build must not
# carry it. Runs the test suites first; refuses to pack on failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist/sigill-browser-extension.zip}"

cd "$ROOT"
node test/adapters.test.js > /dev/null
node test/envelope.test.js > /dev/null
node test/ledger.test.js > /dev/null
node test/agent-evidence.test.js > /dev/null
node test/claude-rpc.test.js > /dev/null
echo "tests: all green"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -r background content lib popup icons "$STAGE/"

# Strip the dev marker — this is the dev/prod switch.
python3 - "$ROOT/manifest.json" "$STAGE/manifest.json" <<'EOF'
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest.pop('version_name', None)
# The public key only pins the extension ID for unpacked dev builds; the store
# assigns the ID itself.
manifest.pop('key', None)
json.dump(manifest, open(sys.argv[2], 'w'), indent=2)
EOF

# Sanity: the packed build must identify as production.
if grep -q '"version_name"\|"key"' "$STAGE/manifest.json"; then
  echo "ERROR: version_name or key survived packing" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" .)

VERSION="$(python3 -c "import json;print(json.load(open('$STAGE/manifest.json'))['version'])")"
echo "packed v$VERSION -> $OUT"
unzip -l "$OUT" | tail -1
