const API_BASE = 'https://api.sigill.ai';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'STAMP') {
    stamp(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
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

async function stamp({ platform, role, text, conversationId }) {
  const settings = await chrome.storage.sync.get(['apiKey', `${platform}Enabled`]);
  const { apiKey } = settings;
  if (!apiKey || settings[`${platform}Enabled`] === false) return { skipped: true };

  const hashHex = await sha256(text);
  const label = `${platform}-${role}-${Date.now()}`;

  const resp = await fetch(`${API_BASE}/tsa/stamp-hash`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tsaSlug: 'auto', hashHex, label }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Sigill ${resp.status}: ${body}`);
  }

  const sigill = await resp.json();
  const entry = {
    id: `${platform}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    platform,
    role,
    conversationId: conversationId ?? 'unknown',
    content: text,
    hash: hashHex,
    sigill,
    at: new Date().toISOString(),
  };

  const { log = [] } = await chrome.storage.local.get('log');
  log.push(entry);
  await chrome.storage.local.set({ log });
  return { ok: true };
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
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
