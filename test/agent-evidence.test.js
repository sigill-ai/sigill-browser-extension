// Agent Evidence Profiles suite: canonicalization and binding digests against the
// SDK's cross-language vectors and a run sealed for real (test/vectors/agent-run),
// the OAuth callback checks, and the conversation recorder end to end with a stub
// signer.
//
// Run: node test/agent-evidence.test.js

const fs = require('fs');
const path = require('path');
const E = require('../lib/agent-evidence.js');
const Auth = require('../lib/sigill-auth.js');
const Mcp = require('../lib/sigill-mcp.js');
const Recorder = require('../lib/conversation-recorder.js');

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const V = p => path.join(__dirname, 'vectors', 'agent-run', p);
const json = p => JSON.parse(fs.readFileSync(V(p), 'utf8'));

function memoryStorage() {
  const m = new Map();
  return {
    m,
    async get(k) { const keys = Array.isArray(k) ? k : [k]; const o = {}; for (const x of keys) if (m.has(x)) o[x] = structuredClone(m.get(x)); return o; },
    async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v)); },
    async remove(k) { for (const x of Array.isArray(k) ? k : [k]) m.delete(x); },
  };
}

(async () => {
  console.log('binding digests (SDK vectors)');
  for (const v of json('signature-sha256.json')) {
    const got = await E.signatureSha256(v.signature);
    check(`signatureSha256 ${v.name}`, got === (v.expected ?? null), `got ${got}, want ${v.expected}`);
  }

  console.log('canonicalization (run sealed for real)');
  for (const n of ['10-run_start', '16-run_end']) {
    const a = json(`${n}.json`);
    const { canonical, hash } = await E.envelopeHash(a.envelope);
    check(`${n} canonical bytes`, canonical === fs.readFileSync(V(`${n}.canonical.json`), 'utf8').trim());
    check(`${n} envelope hash`, hash === fs.readFileSync(V(`${n}.envelope-hash.txt`), 'utf8').trim());
  }
  const runStart = json('10-run_start.json');
  const control = json('00-control.json');
  check('run_start binds the control artifact',
    runStart.envelope.binds.controlArtifactSignatureSha256 === await E.signatureSha256(control.signature));
  const runEnd = json('16-run_end.json');
  const genTime = await E.signatureTimestamp(runEnd.signature);
  check('run_end signature timestamp imprints its signature', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(genTime), genTime);
  const tampered = structuredClone(runEnd.signature);
  tampered.signatures[0].signature = tampered.signatures[0].signature.replace(/^./, c => (c === 'A' ? 'B' : 'A'));
  let threw = false;
  try { await E.signatureTimestamp(tampered); } catch { threw = true; }
  check('a timestamp over another signature is rejected', threw);
  threw = false;
  try { await E.signatureTimestamp(runStart.signature.signatures ? { signatures: [{ ...runStart.signature.signatures[0], header: {} }] } : {}); } catch { threw = true; }
  check('a seal without sigTst is rejected', threw);

  console.log('canonicalization rules');
  check('JCS sorts by UTF-16 code units', E.jcs({ b: 1, a: 2, '\u20ac': 3, '\ud83d\ude00': 4 }) === '{"a":2,"b":1,"\u20ac":3,"\ud83d\ude00":4}');
  threw = false;
  try { E.jcs({ x: 1.5 }); } catch { threw = true; }
  check('JCS refuses non-integers', threw);
  const ev = E.event({ now: new Date('2026-10-11T10:00:00.1234Z'), actor: { type: 'agent', id: 'a' }, activity: 'x', correlationId: 'urn:uuid:1', seq: 0, stepType: 'run_start', objects: [] });
  check('seq 0 carries no prevSignatureSha256', !('prevSignatureSha256' in ev.chain));
  check('eventTime has millisecond precision', ev.step.eventTime === '2026-10-11T10:00:00.123Z', ev.step.eventTime);

  console.log('sign-in callback');
  const redirectUrl = 'https://behfnnjgaoacljokaeadabniafanfgbp.chromiumapp.org/callback';
  const ok = Auth.parseCallback(`${redirectUrl}?code=abc&state=s1&iss=https%3A%2F%2Fapi.sigill.ai`, { redirectUrl, state: 's1', issuer: 'https://api.sigill.ai' });
  check('a matching callback yields its code', ok === 'abc');
  for (const [label, url] of [
    ['wrong state', `${redirectUrl}?code=abc&state=other`],
    ['wrong issuer', `${redirectUrl}?code=abc&state=s1&iss=https%3A%2F%2Fevil.example`],
    ['wrong redirect', `https://other.chromiumapp.org/callback?code=abc&state=s1`],
    ['error answer', `${redirectUrl}?error=access_denied&state=s1`],
  ]) {
    threw = false;
    try { Auth.parseCallback(url, { redirectUrl, state: 's1', issuer: 'https://api.sigill.ai' }); } catch { threw = true; }
    check(`callback rejected: ${label}`, threw);
  }
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUgU1-ZMGAeOeoeqFZxyE';
  check('PKCE S256 is base64url(SHA-256(verifier))', await Auth.pkceChallenge(verifier) === require('crypto').createHash('sha256').update(verifier).digest('base64url'));

  console.log('token refresh');
  {
    const storage = memoryStorage();
    let tokenCalls = 0;
    const fetch = async (url, init) => {
      tokenCalls++;
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== 'r1') return { status: 400, json: async () => ({ error: 'invalid_grant' }) };
      return { status: 200, json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600, scope: 'mcp:agent:record offline_access' }) };
    };
    await storage.set({ sigillConnection: { issuer: 'https://api.sigill.ai', clientId: Auth.CLIENT_ID, tokenUrl: 'https://api.sigill.ai/oauth/token', accessToken: 'a1', accessExpiry: Date.now() + 1000, refreshToken: 'r1' } });
    const auth = Auth.create({ storage, fetch, launchWebAuthFlow: null, redirectUrl });
    const [t1, t2] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    check('concurrent callers share one refresh', t1 === 'a2' && t2 === 'a2' && tokenCalls === 1, `${t1} ${t2} calls=${tokenCalls}`);
    check('the rotated refresh token is stored', (await storage.get('sigillConnection')).sigillConnection.refreshToken === 'r2');
    await storage.set({ sigillRefreshInFlight: true, sigillConnection: { ...(await storage.get('sigillConnection')).sigillConnection, accessExpiry: 0 } });
    threw = false;
    try { await auth.accessToken(); } catch (e) { threw = e.name === 'NotConnectedError'; }
    check('an interrupted refresh is never replayed', threw && tokenCalls === 1);
  }

  console.log('recorder (stub signer)');
  {
    const storage = memoryStorage();
    let n = 0;
    const sealed = [];
    const mcp = {
      async recordingConfig() { return { certificates: [{ id: 'c0ffee00-0000-4000-8000-000000000001', source: 'platform' }] }; },
      async seal(req) {
        sealed.push(req);
        n++;
        const sig = Buffer.from(`sig-${n}`).toString('base64url');
        return { signature: { signatures: [{ protected: Buffer.from('{"alg":"PS256"}').toString('base64url'), signature: sig }] }, timestampedBy: 'Test TSA' };
      },
      async index(items) { return items.map(it => ({ key: it.key, status: 'indexed' })); },
    };
    let clock = new Date('2026-10-11T10:00:00.000Z');
    const rec = Recorder.create({ storage, mcp, evidence: E, now: () => clock, version: '0.6.0', checkTimestamp: async () => '2026-10-11T10:00:01Z' });
    const t1 = await rec.recordTurn({ platform: 'claude', conversationId: 'conv-1', messageId: 'm1', model: 'claude-x', promptText: 'hello', outputText: 'hi', attachments: [{ sha256: 'a'.repeat(64), sizeBytes: 3, mediaType: 'text/plain' }] });
    check('first turn opens a run: control, run_start, turn', sealed.length === 3 && t1.seq === 1);
    check('control artifact is timestamped', sealed[0].contentType === E.CONTROL_CONTENT_TYPE && sealed[0].timestamp === true);
    check('only digests are sent', JSON.stringify(sealed).indexOf('hello') === -1 && sealed[2].objects.length === 3);
    clock = new Date(clock.getTime() + 60_000);
    const t2 = await rec.recordTurn({ platform: 'claude', conversationId: 'conv-1', messageId: 'm2', outputText: 'again' });
    check('next turn continues the chain', t2.runId === t1.runId && t2.seq === 2 && sealed.length === 4);
    clock = new Date(clock.getTime() + Recorder.IDLE_MS + 1);
    check('an idle run is closed', await rec.closeIdle() === 1);
    const [b] = await rec.bundles();
    const arts = b.bundle.artifacts;
    check('bundle: run_start … run_end in order', arts.map(a => a.envelope.step.type).join(',') === 'run_start,model_output,model_output,run_end');
    check('run_end closes on its own seq', arts[3].envelope.step.finalSeq === 3 && arts[3].envelope.step.finalPrevSignatureSha256 === arts[3].envelope.chain.prevSignatureSha256);
    let linked = true;
    for (let i = 1; i < arts.length; i++) linked &&= arts[i].envelope.chain.prevSignatureSha256 === await E.signatureSha256(arts[i - 1].signature);
    check('every event links the previous signature', linked);
    check('run_start binds the control artifact', arts[0].envelope.binds.controlArtifactSignatureSha256 === await E.signatureSha256(b.bundle.controlArtifact.signature));
    check('actor is the assistant, never the user', arts.every(a => a.envelope.actor.id === 'urn:sigill:assistant:claude.ai' && a.envelope.actor.type === 'agent'));
    check('control artifact agent is the run actor', b.bundle.controlArtifact.envelope.agent.id === arts[0].envelope.actor.id);
    check('no conversation id or message id in envelopes', !JSON.stringify(b.bundle).includes('conv-1') && !JSON.stringify(b.bundle).includes('"m1"'));
    const t3 = await rec.recordTurn({ platform: 'claude', conversationId: 'conv-1', messageId: 'm3', outputText: 'later' });
    check('a turn after closing starts a new segment', t3.runId !== t1.runId && t3.seq === 1);
    const segs = await rec.bundles();
    const seg = segs.find(s => s.name === t3.runId).bundle.artifacts[0].envelope.extensions['ai.sigill.browser-extension'];
    check('the segment names the run it continues', seg.segmentOf === b.bundle.correlationId);
    const flushed = await rec.flushOutbox();
    // run 1: control, run_start, 2 turns, run_end; run 2: control, run_start, 1 turn
    check('sealed artifacts are indexed in order', flushed.indexed === 8 && flushed.pending === 0, JSON.stringify(flushed));
    check('badge index by message id', (await rec.turnByMessageId('m2'))?.genTime === '2026-10-11T10:00:01Z');

    // A failed seal stops the run; the next turn starts a new segment, never reusing a seq.
    mcp.seal = async () => { throw new Mcp.QuotaError('2026-11-01'); };
    threw = false;
    try { await rec.recordTurn({ platform: 'claude', conversationId: 'conv-1', messageId: 'm4', outputText: 'x' }); } catch (e) { threw = e.name === 'QuotaError'; }
    check('quota stops the run', threw && (await rec.stats()).stoppedRuns === 1);
  }

  console.log('recovery');
  {
    const storage = memoryStorage();
    await storage.set({ recRuns: { r1: { id: 'r1', pending: { name: '0003-model_output' }, nextSeq: 3 } } });
    const rec = Recorder.create({ storage, mcp: {}, evidence: E });
    await rec.recover();
    const r = (await storage.get('recRuns')).recRuns.r1;
    check('a seal interrupted by a restart stops the run', r.broken && !r.pending && r.nextSeq === 3);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
