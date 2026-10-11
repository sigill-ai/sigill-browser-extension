// Agent Evidence Profiles v1 (sigill-dotnet/spec/agent-profiles-common-v1.md) for
// client-observed conversations: one conversation is one agent run, recorded by the
// extension as it observes it. Same envelopes, binding digests and bundle as the
// Claude Code plugin and the SDKs, so a run verifies at sigill.ai/verify-run.
//
// Only digests leave the browser: an object carries the SHA-256 of its content,
// never the content. Pure functions, no chrome.* dependencies — loadable from the
// MV3 service worker via importScripts() and from Node via require() for the tests.

const SigillAgentEvidence = (() => {
  const CONTROL_SCHEMA = 'AgentControlArtifact';
  const EXECUTION_SCHEMA = 'AgentExecutionEvidence';
  const CONTROL_CONTENT_TYPE = 'application/vnd.sigill.agent-control+json';
  const EXECUTION_CONTENT_TYPE = 'application/vnd.sigill.agent-execution+json';

  // RFC 8785 (JCS). For the values envelopes hold — strings, booleans, safe
  // integers, plain objects and arrays — ECMAScript's JSON serialization of
  // primitives is exactly JCS's, and Array.prototype.sort orders member names by
  // UTF-16 code units, as JCS §3.2.3 requires.
  function jcs(v) {
    if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
    if (v !== null && typeof v === 'object') {
      return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
        .map(k => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
    }
    if (typeof v === 'number' && (!Number.isFinite(v) || !Number.isSafeInteger(v))) {
      throw new Error('envelopes carry safe integers only');
    }
    if (v === undefined || typeof v === 'function' || typeof v === 'bigint') {
      throw new Error('value cannot be canonicalized');
    }
    return JSON.stringify(v);
  }

  const subtle = () => globalThis.crypto.subtle;
  const toHex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

  async function sha256Hex(bytes) {
    return toHex(await subtle().digest('SHA-256', bytes));
  }

  const utf8 = s => new TextEncoder().encode(s);

  function newUUID() {
    return globalThis.crypto.randomUUID();
  }

  // Millisecond-precision UTC time, the form the profiles sign (common rules §4).
  function formatTime(date) {
    return new Date(Math.floor(date.getTime())).toISOString();
  }

  // A detached object: content stays local, only its digest is sealed. URIs are
  // opaque urn:uuid and never carry personal data (common rules §5).
  async function newObject(role, contentType, content) {
    const bytes = typeof content === 'string' ? utf8(content) : content;
    return { uri: 'urn:uuid:' + newUUID(), role, contentType, sizeBytes: bytes.length, sha256: await sha256Hex(bytes) };
  }

  // An object whose content the extension saw only as a digest (an attachment
  // hashed in the page). Its digest is what the page computed over the file.
  function digestObject(role, contentType, sha256, sizeBytes) {
    const o = { uri: 'urn:uuid:' + newUUID(), role, contentType: contentType || 'application/octet-stream', sha256 };
    if (Number.isSafeInteger(sizeBytes) && sizeBytes >= 0) o.sizeBytes = sizeBytes;
    return o;
  }

  function objectsBlock(objs) {
    return objs.map(o => {
      const b = { uri: o.uri, role: o.role, contentType: o.contentType };
      if (o.sizeBytes !== undefined) b.sizeBytes = o.sizeBytes;
      return b;
    });
  }

  // The bundle's objectDigests: object URI → SHA-256 hex.
  function digests(objs) {
    const d = {};
    for (const o of objs) d[o.uri] = o.sha256;
    return d;
  }

  // The BEFORE envelope (agent-control-artifact-v1.md).
  function controlArtifact({ now, actor, activity, correlationId, agent, controlSet, policy, objects }) {
    return {
      schemaName: CONTROL_SCHEMA,
      schemaVersion: '1',
      evidenceId: newUUID(),
      createdAt: formatTime(now),
      actor,
      activity: { name: activity, correlationId },
      agent,
      controlSet,
      timestampPolicy: policy,
      objects: objectsBlock(objects),
    };
  }

  // One DURING envelope (agent-execution-evidence-v1.md). step holds the
  // type-specific fields; binds is set on run_start only.
  function event({ now, actor, activity, correlationId, seq, prevSig, binds, stepType, step, consequential, stamp, extensions, objects }) {
    const s = { ...(step ?? {}), type: stepType, eventTime: formatTime(now), consequential: Boolean(consequential), timestamp: stamp ? 'required' : 'none' };
    const chain = { seq };
    if (seq > 0) chain.prevSignatureSha256 = prevSig;
    const env = {
      schemaName: EXECUTION_SCHEMA,
      schemaVersion: '1',
      evidenceId: newUUID(),
      createdAt: formatTime(now),
      actor,
      activity: { name: activity, correlationId },
      chain,
      step: s,
      objects: objectsBlock(objects ?? []),
    };
    if (binds && Object.keys(binds).length) env.binds = binds;
    if (extensions && Object.keys(extensions).length) env.extensions = extensions;
    return env;
  }

  // Canonical bytes and their SHA-256 hex — what the seal signs.
  async function envelopeHash(envelope) {
    const canonical = jcs(envelope);
    return { canonical, hash: await sha256Hex(utf8(canonical)) };
  }

  // ---------- base64 ----------

  function b64ToBytes(s, url) {
    let t = url ? s.replace(/-/g, '+').replace(/_/g, '/') : s;
    while (t.length % 4) t += '=';
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const strictB64Url = s => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s);

  // An entry whose protected header cannot be read counts as classical (§2).
  function isPostQuantum(protectedB64) {
    try {
      const h = JSON.parse(new TextDecoder().decode(b64ToBytes(protectedB64, true)));
      return typeof h?.alg === 'string' && h.alg.startsWith('ML-DSA');
    } catch {
      return false;
    }
  }

  // The classical signature entry of a JWS: { signature, header } or null.
  function classicalEntry(jws) {
    if (!jws || typeof jws !== 'object') return null;
    if (Array.isArray(jws.signatures)) {
      const e = jws.signatures.find(x => !isPostQuantum(x?.protected));
      return e ? { signature: e.signature, header: e.header } : null;
    }
    if (typeof jws.signature === 'string') return { signature: jws.signature, header: jws.header };
    return null;
  }

  // signatureSha256 (common rules §2): SHA-256 hex over the base64url-decoded
  // signature value of the classical entry. null when there is none.
  async function signatureSha256(jws) {
    const e = classicalEntry(jws);
    if (!e || !strictB64Url(e.signature)) return null;
    return sha256Hex(b64ToBytes(e.signature, true));
  }

  // ---------- RFC 3161 token (structural) ----------

  // Minimal DER reader: { tag, len, start (of content), end }.
  function derNode(buf, pos) {
    if (pos + 2 > buf.length) throw new Error('truncated');
    const tag = buf[pos];
    let len = buf[pos + 1];
    let p = pos + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 4 || p + n > buf.length) throw new Error('bad length');
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[p + i];
      p += n;
    }
    if (p + len > buf.length) throw new Error('truncated');
    return { tag, start: p, end: p + len };
  }

  function children(buf, node) {
    const out = [];
    for (let p = node.start; p < node.end;) {
      const c = derNode(buf, p);
      out.push(c);
      p = c.end;
    }
    return out;
  }

  const OID_SIGNED_DATA = '2a864886f70d010702';
  const OID_TST_INFO = '2a864886f70d0109100104';
  const HASH_BY_OID = {
    '608648016503040201': 'SHA-256',
    '608648016503040202': 'SHA-384',
    '608648016503040203': 'SHA-512',
  };

  const hexOf = (buf, n) => toHex(buf.slice(n.start, n.end));

  // ContentInfo → SignedData → TSTInfo. Returns { hashAlg, imprint, genTime }.
  function parseTimestampToken(der) {
    const ci = derNode(der, 0);
    const [ctype, explicit] = children(der, ci);
    if (ctype?.tag !== 0x06 || hexOf(der, ctype) !== OID_SIGNED_DATA || explicit?.tag !== 0xa0) throw new Error('not SignedData');
    const sd = children(der, explicit)[0];
    const sdKids = children(der, sd);
    const encap = sdKids[2];
    if (!encap || encap.tag !== 0x30) throw new Error('no encapsulated content');
    const [etype, econtent] = children(der, encap);
    if (hexOf(der, etype) !== OID_TST_INFO || econtent?.tag !== 0xa0) throw new Error('not a TSTInfo');
    const octets = children(der, econtent)[0];
    if (octets?.tag !== 0x04) throw new Error('TSTInfo not in an OCTET STRING');
    if (!sdKids.some(k => k.tag === 0x31 && k !== sdKids[1] && children(der, k).length)) throw new Error('no SignerInfos');
    const tst = derNode(der, octets.start);
    const f = children(der, tst);
    // version, policy, messageImprint, serialNumber, genTime
    if (f[0]?.tag !== 0x02 || f[1]?.tag !== 0x06 || f[2]?.tag !== 0x30 || f[3]?.tag !== 0x02 || f[4]?.tag !== 0x18) {
      throw new Error('malformed TSTInfo');
    }
    const [algId, digest] = children(der, f[2]);
    const hashAlg = HASH_BY_OID[hexOf(der, children(der, algId)[0])];
    if (!hashAlg || digest?.tag !== 0x04) throw new Error('unsupported imprint');
    const gt = new TextDecoder().decode(der.slice(f[4].start, f[4].end));
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(gt);
    if (!m) throw new Error('bad genTime');
    const genTime = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ''}Z`;
    return { hashAlg, imprint: der.slice(digest.start, digest.end), genTime };
  }

  // A required timestamp must be present (common rules §6.2): a JAdES sigTst in the
  // classical entry's etsiU whose RFC 3161 token imprints the base64url signature
  // value (JAdES §5.3.4). Structural and imprint check only — verifiers check the
  // TSA's signature. Returns the token's genTime, or throws.
  async function signatureTimestamp(jws) {
    const e = classicalEntry(jws);
    const etsiU = e?.header?.etsiU;
    if (!e?.signature || !Array.isArray(etsiU)) throw new Error('the seal carries no signature timestamp');
    const target = utf8(e.signature);
    for (const comp of etsiU) {
      let c;
      try { c = JSON.parse(new TextDecoder().decode(b64ToBytes(comp, true))); } catch { continue; }
      for (const t of c?.sigTst?.tstTokens ?? []) {
        try {
          const tok = parseTimestampToken(b64ToBytes(t.val, false));
          const h = new Uint8Array(await subtle().digest(tok.hashAlg, target));
          if (h.length === tok.imprint.length && h.every((b, i) => b === tok.imprint[i])) return tok.genTime;
        } catch { /* try the next token */ }
      }
    }
    throw new Error('the seal carries no signature timestamp bound to its signature');
  }

  // The portable form of one run (common rules §7). Payloads are never included:
  // the extension keeps digests only.
  function bundle({ correlationId, control, artifacts }) {
    const one = a => ({ envelope: JSON.parse(a.envelope), signature: a.signature, objectDigests: a.objectDigests });
    return {
      format: 'AgentRunBundle',
      bundleVersion: '1',
      correlationId,
      controlArtifact: control ? one(control) : null,
      artifacts: artifacts.map(one),
    };
  }

  return {
    CONTROL_CONTENT_TYPE, EXECUTION_CONTENT_TYPE,
    jcs, sha256Hex, newUUID, formatTime, newObject, digestObject, digests,
    controlArtifact, event, envelopeHash, signatureSha256, signatureTimestamp, parseTimestampToken, bundle,
  };
})();

if (typeof module !== 'undefined') module.exports = SigillAgentEvidence;
