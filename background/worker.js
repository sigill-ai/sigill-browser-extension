const API_BASE = 'https://api.sigill.ai';
const PROVIDER = { claude: 'anthropic', chatgpt: 'openai', gemini: 'google' };
const MODEL    = { claude: 'claude',    chatgpt: 'gpt',    gemini: 'gemini' };
let logWriteQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'STAMP_TURN') {
    stampTurn(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'GET_STATS') {
    getStats().then(sendResponse);
    return true;
  }
  if (msg.type === 'GET_STAMPED_TURNS') {
    getStampedTurns(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'EXPORT') {
    exportLog().then(sendResponse);
    return true;
  }
  if (msg.type === 'CLEAR_LOG') {
    clearLog().then(sendResponse);
    return true;
  }
  if (msg.type === 'LIST_SEAL_CERTIFICATES') {
    listSealCertificates().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'SEAL_LOG') {
    sealLog(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'SIGILL_IDENTITY') {
    syncSigillIdentity(msg).then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'DISCONNECT_IDENTITY') {
    chrome.storage.sync.remove(['actorId', 'actorTenantId', 'actorTenantName', 'sigillConnected'])
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function stampTurn({ platform, conversationId, prompt, output }) {
  const settings = await chrome.storage.sync.get([
    'apiKey', `${platform}Enabled`, 'actorId', 'actorTenantId',
  ]);
  const { apiKey } = settings;
  if (!apiKey || settings[`${platform}Enabled`] === false) return { skipped: true };

  const evidenceId = crypto.randomUUID();
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const actor = { type: 'user' };
  if (settings.actorId) actor.id = settings.actorId;
  if (settings.actorTenantId) actor.tenantId = settings.actorTenantId;

  // Build envelope per AiEvidenceEnvelopeV1 schema — integrity.envelopeHash and proofs
  // are added after canonicalization, per spec §4.
  const envelope = {
    schemaName: 'AiEvidenceEnvelope',
    schemaVersion: '1',
    evidenceId,
    createdAt,
    purpose: { category: 'chat.completion' },
    actor,
    activity: { name: 'chat.completion', correlationId: conversationId ?? 'unknown' },
    model: { provider: PROVIDER[platform] ?? platform, name: MODEL[platform] ?? 'unknown' },
    prompt: { contentType: 'text/plain', encoding: 'utf-8', inline: prompt },
    output: { contentType: 'text/plain', encoding: 'utf-8', inline: output },
    integrity: { canonicalization: 'RFC8785' },
  };

  const hashHex = await computeEnvelopeHash(envelope);
  envelope.integrity.envelopeHash = { alg: 'SHA-256', hex: hashHex };

  const resp = await fetch(`${API_BASE}/tsa/stamp-hash`, {
    method: 'POST',
    headers: { Authorization: bearer(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ tsaSlug: 'auto', hashHex, label: `${platform}-turn-${evidenceId.slice(0, 8)}` }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Sigill ${resp.status}: ${body}`);
  }

  const proof = await resp.json();
  envelope.proofs = [{
    type: 'rfc3161',
    tsrBase64: proof.tsrBase64,
    tsaName: proof.tsaName,
    genTime: proof.genTime,
    serial: proof.serial,
  }];

  await appendLog(envelope);
  return { ok: true, evidenceId, genTime: proof.genTime, tsaName: proof.tsaName };
}

async function syncSigillIdentity({ token, email, tenantId }) {
  let resolvedTenantId = tenantId ?? null;
  let resolvedTenantName = null;
  try {
    const me = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (me.ok) {
      const data = await me.json();
      resolvedTenantId = data.tenantId ?? resolvedTenantId;
      resolvedTenantName = data.tenantName ?? null;
    }
  } catch { /* use JWT tenantId fallback */ }

  await chrome.storage.sync.set({
    actorId: email,
    actorTenantId: resolvedTenantId,   // UUID — goes into envelope
    actorTenantName: resolvedTenantName, // display name — shown in popup
    sigillConnected: true,
  });
  console.log('[Sigill] identity synced:', email, resolvedTenantId, resolvedTenantName);
}

function bearer(apiKey) {
  return apiKey.match(/^Bearer\s+/i) ? apiKey : `Bearer ${apiKey}`;
}

async function appendLog(envelope) {
  const write = logWriteQueue.catch(() => {}).then(async () => {
    const { log = [] } = await chrome.storage.local.get('log');
    log.push(envelope);
    await chrome.storage.local.set({ log });
  });
  logWriteQueue = write.catch(() => {});
  return write;
}

// Minimal RFC 8785 (JCS): sort object keys lexicographically, no whitespace.
// Sufficient for our envelope which only contains strings, booleans, and plain objects.
function jcs(v) {
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

async function computeEnvelopeHash(envelope) {
  // Strip integrity.envelopeHash and proofs before canonicalization (spec §4)
  const stripped = JSON.parse(JSON.stringify(envelope));
  if (stripped.integrity) delete stripped.integrity.envelopeHash;
  delete stripped.proofs;
  const canonical = jcs(stripped);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getStats() {
  const { log = [] } = await chrome.storage.local.get('log');
  return { count: log.length };
}

async function getStampedTurns({ platform, conversationId }) {
  const { log = [] } = await chrome.storage.local.get('log');
  const provider = PROVIDER[platform] ?? platform;
  const modelName = MODEL[platform] ?? 'unknown';
  let index = 0;
  const turns = [];
  for (const envelope of log) {
    if (envelope.activity?.correlationId !== conversationId) continue;
    if (envelope.model?.provider !== provider || envelope.model?.name !== modelName) continue;
    turns.push({
      index: index++,
      prompt: envelope.prompt?.inline ?? '',
      output: envelope.output?.inline ?? '',
      evidenceId: envelope.evidenceId,
      genTime: envelope.proofs?.[0]?.genTime,
      tsaName: envelope.proofs?.[0]?.tsaName,
    });
  }
  return { turns };
}

async function exportLog() {
  const { log = [] } = await chrome.storage.local.get('log');
  return { log };
}

async function clearLog() {
  logWriteQueue = logWriteQueue.catch(() => {}).then(() => chrome.storage.local.set({ log: [] }));
  await logWriteQueue;
  return { ok: true, count: 0 };
}

async function listSealCertificates() {
  const { apiKey } = await chrome.storage.sync.get('apiKey');
  if (!apiKey) return { certificates: [] };

  const resp = await fetch(`${API_BASE}/seal/certificates`, {
    headers: { Authorization: bearer(apiKey) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Sigill ${resp.status}: ${body}`);
  }

  const certificates = await resp.json();
  return { certificates: certificates.filter(c => c.status === 'active') };
}

async function sealLog({ certificateId }) {
  const { apiKey } = await chrome.storage.sync.get('apiKey');
  if (!apiKey) return { error: 'Missing API key' };
  if (!certificateId) return { error: 'Choose a seal certificate first' };

  const { log = [] } = await chrome.storage.local.get('log');
  if (!log.length) return { error: 'No stamped turns to seal' };

  const jsonl = log.map(e => JSON.stringify(e)).join('\n');
  const filename = `sigill-log-${Date.now()}.jsonl`;

  // Hash the log locally — the JSONL never leaves the browser
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jsonl));
  const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

  const resp = await fetch(`${API_BASE}/seal/sign-hash`, {
    method: 'POST',
    headers: { Authorization: bearer(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashHex, certificateId, label: filename, qualified: false }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Sigill ${resp.status}: ${body}`);
  }

  const bytes = new Uint8Array(await resp.arrayBuffer());
  const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
  return {
    ok: true,
    filename,
    jsonl,
    signatureBase64: btoa(binary),
    format: resp.headers.get('X-Seal-Format') ?? 'cades',
    operationId: resp.headers.get('X-Seal-Operation-Id'),
    certificateId: resp.headers.get('X-Seal-Certificate-Id') ?? certificateId,
    timestampedBy: resp.headers.get('X-Seal-Timestamped-By'),
    qualified: resp.headers.get('X-Seal-Qualified') === 'true',
  };
}
