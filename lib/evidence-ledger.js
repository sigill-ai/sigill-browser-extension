// Chained evidence ledger. Envelopes are schema-pure AiEvidenceEnvelopeV1
// objects (the schema deliberately has no prev-hash field — one envelope
// proves one turn); sequence integrity is the ledger's job. Each record wraps
// an envelope and links to its predecessor:
//
//   { seq, prevHash, envelope, recordHash }
//   recordHash = SHA-256( JCS({ seq, prevHash, envelope }) )
//
// Deleting, reordering, or editing any record breaks every recordHash after
// it. An RFC 3161 stamp on the current head (see the worker's hourly anchor
// alarm) therefore bounds tampering of the whole prefix: one stamp per hour
// covers every record before it.
//
// Pure functions, no chrome.* — loadable via importScripts() (after
// evidence-envelope.js) and via require() for tests and the verifier.

const SigillLedger = (() => {
  const _evidence = (typeof module !== 'undefined' && typeof require !== 'undefined')
    ? require('./evidence-envelope.js')
    : SigillEvidence;

  const GENESIS = '0'.repeat(64);

  async function sha256Hex(text) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function recordBody(seq, prevHash, envelope) {
    return _evidence.jcs({ seq, prevHash, envelope });
  }

  async function recordHashHex(record) {
    return sha256Hex(recordBody(record.seq, record.prevHash, record.envelope));
  }

  // Build the next record in the chain. prevRecord is null for the genesis.
  async function makeRecord(prevRecord, envelope) {
    const seq = prevRecord ? prevRecord.seq + 1 : 0;
    const prevHash = prevRecord ? prevRecord.recordHash : GENESIS;
    const recordHash = await sha256Hex(recordBody(seq, prevHash, envelope));
    return { seq, prevHash, envelope, recordHash };
  }

  // Verify sequence continuity, prev-hash links, and every recordHash.
  // Returns { ok, problems: [] }. Does NOT re-verify envelope content hashes —
  // that's the verifier's job (it needs the envelope-hash rules).
  async function verifyChain(ledger) {
    const problems = [];
    for (let i = 0; i < ledger.length; i += 1) {
      const r = ledger[i];
      if (r.seq !== i) problems.push(`record ${i}: seq is ${r.seq}, expected ${i}`);
      const expectedPrev = i === 0 ? GENESIS : ledger[i - 1].recordHash;
      if (r.prevHash !== expectedPrev) problems.push(`record ${i}: prevHash broken (chain edited or record removed before it)`);
      const recomputed = await recordHashHex(r);
      if (recomputed !== r.recordHash) problems.push(`record ${i}: recordHash mismatch (record content altered)`);
    }
    return { ok: problems.length === 0, problems };
  }

  return { GENESIS, makeRecord, recordHashHex, verifyChain };
})();

if (typeof module !== 'undefined') module.exports = SigillLedger;
