#!/usr/bin/env node
// Verify a Sigill evidence bundle (the extension's Export file) with no Sigill
// dependency:
//
//   node tools/verify-bundle.js <bundle.json> [--dump-tsr <dir>]
//
// Checks, in order of what they prove:
//   1. Envelope integrity — every envelope's canonical hash (RFC 8785, hash
//      and proofs stripped) matches its recorded integrity.envelopeHash.
//   2. Chain integrity — seq continuity, prevHash links, recordHash of every
//      ledger record. Any edit, deletion, or reordering breaks this.
//   3. Anchor consistency — every anchor's headHash equals the recordHash of
//      the record at its seq, so the anchor's RFC 3161 stamp covers the whole
//      chain up to that point.
//   4. Proof presence — each turn proof and anchor proof carries a TSR.
//      Cryptographic TSR verification is delegated to OpenSSL (instructions
//      printed; --dump-tsr writes the .tsr files).

const fs = require('fs');
const path = require('path');
const evidence = require('../lib/evidence-envelope.js');
const ledgerLib = require('../lib/evidence-ledger.js');

async function verifyBundle(bundle) {
  const problems = [];
  const notes = [];

  if (bundle.format !== 'sigill-evidence-bundle') {
    problems.push(`unexpected format: ${bundle.format}`);
  }
  const records = Array.isArray(bundle.ledger) ? bundle.ledger : [];
  const anchors = Array.isArray(bundle.anchors) ? bundle.anchors : [];

  // 1. envelope hashes
  for (const r of records) {
    const env = r.envelope ?? {};
    const recorded = env.integrity?.envelopeHash?.hex;
    if (!recorded) {
      problems.push(`record ${r.seq}: envelope has no integrity.envelopeHash`);
      continue;
    }
    const recomputed = await evidence.envelopeHashHex(env);
    if (recomputed !== recorded) {
      problems.push(`record ${r.seq}: envelope hash mismatch — envelope content was altered`);
    }
    if (!env.proofs?.some(p => p.type === 'rfc3161' && p.tsrBase64)) {
      problems.push(`record ${r.seq}: no RFC 3161 proof attached`);
    }
  }

  // 2. chain
  const chain = await ledgerLib.verifyChain(records);
  problems.push(...chain.problems);

  // 3. anchors
  const bySeq = new Map(records.map(r => [r.seq, r]));
  for (const [i, a] of anchors.entries()) {
    const rec = bySeq.get(a.seq);
    if (!rec) {
      problems.push(`anchor ${i}: no ledger record at seq ${a.seq}`);
      continue;
    }
    if (rec.recordHash !== a.headHash) {
      problems.push(`anchor ${i}: headHash does not match record ${a.seq} — chain rewritten after anchoring`);
    }
    if (!a.proof?.tsrBase64) problems.push(`anchor ${i}: no RFC 3161 proof`);
  }
  if (!anchors.length && records.length) {
    notes.push('no anchors present — per-turn stamps hold, but chain order is only self-attested');
  }

  return { ok: problems.length === 0, problems, notes, counts: { records: records.length, anchors: anchors.length } };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/verify-bundle.js <bundle.json> [--dump-tsr <dir>]');
    process.exit(2);
  }
  const dumpIdx = args.indexOf('--dump-tsr');
  const dumpDir = dumpIdx !== -1 ? args[dumpIdx + 1] : null;

  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = await verifyBundle(bundle);

  console.log(`bundle: ${file}`);
  console.log(`records: ${result.counts.records}, anchors: ${result.counts.anchors}`);
  for (const n of result.notes) console.log(`note: ${n}`);
  if (result.ok) {
    console.log('\nVERIFIED — envelope hashes, chain links, and anchor consistency all hold.');
  } else {
    console.log('\nFAILED:');
    for (const p of result.problems) console.log(`  - ${p}`);
  }

  if (dumpDir) {
    fs.mkdirSync(dumpDir, { recursive: true });
    let n = 0;
    for (const r of bundle.ledger ?? []) {
      for (const [i, p] of (r.envelope?.proofs ?? []).entries()) {
        if (!p.tsrBase64) continue;
        fs.writeFileSync(path.join(dumpDir, `turn-seq${r.seq}-proof${i}.tsr`), Buffer.from(p.tsrBase64, 'base64'));
        fs.writeFileSync(path.join(dumpDir, `turn-seq${r.seq}-hash.txt`), r.envelope.integrity.envelopeHash.hex);
        n += 1;
      }
    }
    for (const [i, a] of (bundle.anchors ?? []).entries()) {
      if (!a.proof?.tsrBase64) continue;
      fs.writeFileSync(path.join(dumpDir, `anchor-${i}.tsr`), Buffer.from(a.proof.tsrBase64, 'base64'));
      fs.writeFileSync(path.join(dumpDir, `anchor-${i}-hash.txt`), a.headHash);
      n += 1;
    }
    console.log(`\nwrote ${n} TSR files to ${dumpDir}. Verify a timestamp independently with:`);
    console.log('  openssl ts -reply -in <file>.tsr -text        # inspect asserted time + message imprint');
    console.log('  # the messageImprint digest must equal the matching *-hash.txt content');
  }

  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(2); });
module.exports = { verifyBundle };
