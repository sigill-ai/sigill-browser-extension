const API_BASE = 'https://api.sigill.ai';
const PROVIDER = { claude: 'anthropic', chatgpt: 'openai', gemini: 'google' };
const MODEL    = { claude: 'claude',    chatgpt: 'gpt',    gemini: 'gemini' };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'STAMP_TURN') {
    stampTurn(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'GET_STATS') {
    getStats().then(sendResponse);
    return true;
  }
  if (msg.type === 'EXPORT') {
    exportLog().then(sendResponse);
    return true;
  }
});

async function stampTurn({ platform, conversationId, prompt, output }) {
  const settings = await chrome.storage.sync.get(['apiKey', `${platform}Enabled`]);
  const { apiKey } = settings;
  if (!apiKey || settings[`${platform}Enabled`] === false) return { skipped: true };

  const evidenceId = crypto.randomUUID();
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Build envelope per AiEvidenceEnvelopeV1 schema — integrity.envelopeHash and proofs
  // are added after canonicalization, per spec §4.
  const envelope = {
    schemaName: 'AiEvidenceEnvelope',
    schemaVersion: '1',
    evidenceId,
    createdAt,
    purpose: { category: 'chat.completion' },
    actor: { type: 'user', id: 'browser-extension' },
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
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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

  const { log = [] } = await chrome.storage.local.get('log');
  log.push(envelope);
  await chrome.storage.local.set({ log });
  return { ok: true };
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

async function exportLog() {
  const { log = [] } = await chrome.storage.local.get('log');
  return { log };
}
