// Ledger + bundle-verifier regression suite. Builds a chain of real envelopes
// (from the captured fixtures), then proves the chain detects every class of
// tampering: content edits, deletions, reordering, and post-anchor rewrites.
//
// Run: node test/ledger.test.js

const fs = require('fs');
const path = require('path');
const adapters = require('../lib/turn-adapters.js');
const evidence = require('../lib/evidence-envelope.js');
const ledgerLib = require('../lib/evidence-ledger.js');
const { verifyBundle } = require('../tools/verify-bundle.js');

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

async function buildRealLedger() {
  // Envelopes from the four chatgpt lineage turns — a realistic mixed chain.
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chatgpt-lineage.json'), 'utf8'));
  const ledger = [];
  let n = 0;
  for (const capture of fixtures.filter(c => adapters.chatgpt.isCompletion(c))) {
    const turn = adapters.chatgpt.parseCompletion(capture);
    const env = evidence.buildTurnEnvelope({
      turn, capture,
      actor: { type: 'user', id: 'ext-test-device' },
      extensionVersion: '0.3.0-test',
      evidenceId: `00000000-0000-4000-8000-00000000000${++n}`,
      createdAt: '2026-07-02T00:00:00Z',
    });
    env.integrity.envelopeHash = { alg: 'SHA-256', hex: await evidence.envelopeHashHex(env) };
    env.proofs = [{ type: 'rfc3161', tsrBase64: 'dGVzdC10c3I=' }];
    ledger.push(await ledgerLib.makeRecord(ledger.at(-1) ?? null, env));
  }
  return ledger;
}

function bundleOf(ledger, anchors) {
  return {
    format: 'sigill-evidence-bundle',
    formatVersion: '1',
    exportedAt: '2026-07-02T00:00:00Z',
    extensionVersion: '0.3.0-test',
    ledger,
    anchors,
  };
}

async function main() {
  console.log('\nchain construction');
  const ledger = await buildRealLedger();
  check('four records chained', ledger.length === 4);
  check('genesis prevHash', ledger[0].prevHash === ledgerLib.GENESIS);
  check('links: each prevHash = predecessor recordHash',
    ledger.every((r, i) => i === 0 || r.prevHash === ledger[i - 1].recordHash));
  const intact = await ledgerLib.verifyChain(ledger);
  check('intact chain verifies', intact.ok, intact.problems.join('; '));

  const anchors = [{
    seq: 3,
    headHash: ledger[3].recordHash,
    anchoredAt: '2026-07-02T01:00:00Z',
    proof: { type: 'rfc3161', tsrBase64: 'dGVzdC1hbmNob3I=' },
  }];

  console.log('\nverifier: intact bundle');
  const good = await verifyBundle(bundleOf(clone(ledger), clone(anchors)));
  check('intact bundle verifies', good.ok, good.problems.join('; '));

  console.log('\ntamper: envelope content edited');
  {
    const t = clone(ledger);
    t[1].envelope.output.inline = 'Dog, elephant, TAMPERED.';
    const res = await verifyBundle(bundleOf(t, clone(anchors)));
    check('detected', !res.ok);
    check('names both envelope and chain', res.problems.some(p => p.includes('envelope hash mismatch')) &&
      res.problems.some(p => p.includes('recordHash mismatch')), res.problems.join('; '));
  }

  console.log('\ntamper: record deleted from the middle');
  {
    const t = clone(ledger);
    t.splice(1, 1);
    const res = await verifyBundle(bundleOf(t, clone(anchors)));
    check('detected', !res.ok, res.problems.join('; '));
  }

  console.log('\ntamper: records reordered');
  {
    const t = clone(ledger);
    [t[1], t[2]] = [t[2], t[1]];
    const res = await verifyBundle(bundleOf(t, clone(anchors)));
    check('detected', !res.ok, res.problems.join('; '));
  }

  console.log('\ntamper: chain fully rebuilt after anchoring (delete + re-chain)');
  {
    // Adversary deletes record 1 and rebuilds a *valid* chain from the rest —
    // envelope hashes and links all hold. Only the anchor exposes it.
    const envs = ledger.map(r => clone(r.envelope));
    envs.splice(1, 1);
    const rebuilt = [];
    for (const env of envs) rebuilt.push(await ledgerLib.makeRecord(rebuilt.at(-1) ?? null, env));
    const chainOnly = await ledgerLib.verifyChain(rebuilt);
    check('rebuilt chain is internally valid (the attack is plausible)', chainOnly.ok);
    const res = await verifyBundle(bundleOf(rebuilt, clone(anchors)));
    check('anchor exposes the rewrite', !res.ok, res.problems.join('; '));
  }

  console.log('\ntamper: proof stripped');
  {
    const t = clone(ledger);
    delete t[0].envelope.proofs;
    // proofs are outside the envelope hash by design — chain still verifies,
    // but the verifier must flag the missing proof.
    const res = await verifyBundle(bundleOf(t, clone(anchors)));
    check('detected', !res.ok && res.problems.some(p => p.includes('no RFC 3161 proof')), res.problems.join('; '));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
