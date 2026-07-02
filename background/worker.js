importScripts('../lib/turn-adapters.js', '../lib/evidence-envelope.js', '../lib/evidence-ledger.js');

const API_BASE = 'https://api.sigill.ai';
const PROVIDER = SigillEvidence.PROVIDER;
// Dev detection is build-time: the repo manifest carries version_name
// "x.y.z-dev"; tools/pack.sh strips it for the public zip. (update_url can't
// distinguish — self-distributed zips are loaded unpacked, same as dev.)
const IS_DEV = /-dev$/.test(chrome.runtime.getManifest().version_name ?? '');
let logWriteQueue = Promise.resolve();

// The API key is a bearer credential — kept in storage.local (device-only),
// never storage.sync. Older versions synced it; migrate on first read.
async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (apiKey) return apiKey;
  const legacy = await chrome.storage.sync.get('apiKey');
  if (legacy.apiKey) {
    await chrome.storage.local.set({ apiKey: legacy.apiKey });
    await chrome.storage.sync.remove('apiKey');
    return legacy.apiKey;
  }
  return null;
}

const debugLog = [];
const DEBUG_MAX = 300;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
  if (msg.type === 'GET_API_KEY') {
    getApiKey().then(apiKey => sendResponse({ apiKey }));
    return true;
  }
  if (msg.type === 'SET_API_KEY') {
    chrome.storage.local.set({ apiKey: msg.apiKey ?? '' }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'IS_DEV') {
    sendResponse({ dev: IS_DEV });
    return true;
  }
  if (msg.type === 'DEBUG_ENTRY') {
    if (IS_DEV) pushDebug(msg.entry);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'GET_DEBUG_LOG') {
    sendResponse({ log: [...debugLog] });
    return true;
  }
  if (msg.type === 'CLEAR_DEBUG_LOG') {
    debugLog.length = 0;
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'NET_EVENTS') {
    handleNetEvents(msg.events, _sender);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'FILE_OBSERVED') {
    recordPendingAttachment(msg.file, _sender?.tab?.id).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'GET_FIXTURE_STATS') {
    getFixtureStats().then(sendResponse);
    return true;
  }
  if (msg.type === 'EXPORT_FIXTURES') {
    exportFixtures().then(sendResponse);
    return true;
  }
  if (msg.type === 'CLEAR_FIXTURES') {
    clearFixtures().then(sendResponse);
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

// POST a digest to the Sigill TSA and return a schema-shaped rfc3161 proof.
async function stampHash(apiKey, hashHex, label) {
  const resp = await fetch(`${API_BASE}/tsa/stamp-hash`, {
    method: 'POST',
    headers: { Authorization: bearer(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ tsaSlug: 'auto', hashHex, label }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Sigill ${resp.status}: ${body}`);
  }
  const proof = await resp.json();
  return {
    type: 'rfc3161',
    tsrBase64: proof.tsrBase64,
    tsaName: proof.tsaName,
    genTime: proof.genTime,
    serial: proof.serial,
  };
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

// --- Chained ledger ---------------------------------------------------------
// Envelopes are stored wrapped in chained ledger records (lib/evidence-ledger.js).
// All ledger reads/writes serialize through logWriteQueue; a legacy flat 'log'
// is migrated into a chain on first touch.

async function migrateLegacyLog() {
  const { ledger, log } = await chrome.storage.local.get(['ledger', 'log']);
  if (Array.isArray(ledger)) return ledger;
  const records = [];
  for (const envelope of Array.isArray(log) ? log : []) {
    records.push(await SigillLedger.makeRecord(records.at(-1) ?? null, envelope));
  }
  await chrome.storage.local.set({ ledger: records });
  await chrome.storage.local.remove('log');
  if (records.length) console.log(`[Sigill] migrated ${records.length} legacy log entries into the chained ledger`);
  return records;
}

function readLedger() {
  const read = logWriteQueue.catch(() => {}).then(migrateLegacyLog);
  logWriteQueue = read.catch(() => {});
  return read;
}

async function appendLog(envelope) {
  const write = logWriteQueue.catch(() => {}).then(async () => {
    const ledger = await migrateLegacyLog();
    ledger.push(await SigillLedger.makeRecord(ledger.at(-1) ?? null, envelope));
    await chrome.storage.local.set({ ledger });
  });
  logWriteQueue = write.catch(() => {});
  return write;
}

// Anchor the chain head with one RFC 3161 stamp — bounds tampering of every
// record before it. Runs hourly via chrome.alarms; skips when nothing changed.
async function anchorLedgerHead() {
  const run = logWriteQueue.catch(() => {}).then(async () => {
    const ledger = await migrateLegacyLog();
    if (!ledger.length) return { skipped: 'empty ledger' };
    const head = ledger.at(-1);
    const { anchors = [] } = await chrome.storage.local.get('anchors');
    if (anchors.at(-1)?.headHash === head.recordHash) return { skipped: 'head unchanged' };
    const apiKey = await getApiKey();
    if (!apiKey) return { skipped: 'no api key' };
    const proof = await stampHash(apiKey, head.recordHash, `ledger-anchor-seq${head.seq}`);
    anchors.push({
      seq: head.seq,
      headHash: head.recordHash,
      anchoredAt: new Date().toISOString(),
      proof,
    });
    await chrome.storage.local.set({ anchors });
    return { ok: true, seq: head.seq };
  });
  logWriteQueue = run.catch(() => {});
  const result = await run;
  pushDebug({ type: 'anchor', ts: new Date().toISOString(), ...result });
  return result;
}

chrome.alarms.get('sigill-ledger-anchor').then(alarm => {
  if (!alarm) chrome.alarms.create('sigill-ledger-anchor', { periodInMinutes: 60, delayInMinutes: 2 });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'sigill-ledger-anchor') return;
  anchorLedgerHead().catch(err => pushDebug({
    type: 'anchor', ts: new Date().toISOString(), ok: false, error: err?.message ?? String(err),
  }));
});

// --- Network fixture capture -------------------------------------------------
// Raw platform API traffic recorded by content/interceptor.js, used to develop
// and regression-test the protocol adapters. Captures accumulate in memory
// while a stream is live (the message traffic keeps this worker alive) and are
// persisted to storage.local when the stream ends. If the worker is restarted
// mid-stream, a stub capture is created so late chunks aren't dropped silently.

const activeCaptures = new Map();
let fixtureWriteQueue = Promise.resolve();
const FIXTURE_MAX_COUNT = 40;
const FIXTURE_META_MAX = 8;
const FIXTURE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function handleNetEvents(events, sender) {
  if (!Array.isArray(events)) return;
  for (const ev of events) {
    if (!ev || typeof ev.kind !== 'string') continue;
    if (ev.kind === 'ws' || ev.kind === 'es') {
      pushDebug({ type: 'net_transport', ts: new Date().toISOString(), transport: ev.kind, url: ev.url });
      continue;
    }
    if (ev.kind === 'blob') {
      recordBlobHash(ev, sender);
      continue;
    }
    const capture = ev.captureId ? captureFor(ev, sender) : null;
    if (!capture) continue;
    switch (ev.kind) {
      case 'start':
        capture.resumedWithoutStart = false;
        capture.platform = ev.platform ?? capture.platform;
        capture.url = ev.url ?? capture.url;
        capture.method = ev.method ?? capture.method;
        capture.mode = ev.mode ?? capture.mode;
        capture.requestContentType = ev.requestContentType ?? null;
        capture.requestBody = ev.requestBody ?? null;
        break;
      case 'response':
        capture.status = ev.status;
        capture.responseContentType = ev.responseContentType ?? null;
        break;
      case 'chunks':
        capture.chunks.push(...ev.chunks);
        capture.bytes += ev.chunks.reduce((n, c) => n + c.text.length, 0);
        break;
      case 'end':
        capture.endedAt = new Date().toISOString();
        capture.durationMs = ev.t ?? null;
        capture.truncated = ev.truncated || capture.truncated;
        capture.metadataOnly = ev.metadataOnly === true;
        if (ev.error) capture.error = ev.error;
        if (ev.note) capture.note = ev.note;
        activeCaptures.delete(ev.captureId);
        persistFixture(capture);
        pushDebug({
          type: 'net_end',
          platform: capture.platform,
          ts: capture.endedAt,
          url: capture.url,
          status: capture.status ?? null,
          chunkCount: capture.chunks.length,
          bytes: capture.bytes,
          error: capture.error ?? null,
        });
        maybeRecordArtifactLink(capture);
        maybeSendBadgePositions(capture).catch(() => { /* display only */ });
        maybeStampNetworkTurn(capture).catch(err => pushDebug({
          type: 'stamp_result',
          platform: capture.platform,
          ts: new Date().toISOString(),
          ok: false,
          source: 'network',
          error: err?.message ?? String(err),
        }));
        break;
    }
  }
}

function captureFor(ev, sender) {
  let capture = activeCaptures.get(ev.captureId);
  if (!capture) {
    capture = {
      captureId: ev.captureId,
      tabId: sender?.tab?.id ?? null,
      platform: ev.platform ?? 'unknown',
      url: ev.url ?? null,
      method: ev.method ?? null,
      mode: ev.mode ?? 'full',
      startedAt: new Date().toISOString(),
      chunks: [],
      bytes: 0,
      truncated: false,
      extensionVersion: chrome.runtime.getManifest().version,
      // true when the worker restarted mid-stream and the 'start' event was lost
      resumedWithoutStart: ev.kind !== 'start',
    };
    activeCaptures.set(ev.captureId, capture);
  }
  return capture;
}

function persistFixture(capture) {
  fixtureWriteQueue = fixtureWriteQueue.catch(() => {}).then(async () => {
    if (!IS_DEV) return; // fixture recording is a development tool
    const { fixtureCapture } = await chrome.storage.sync.get('fixtureCapture');
    if (fixtureCapture === false) return;
    const { fixtures = [] } = await chrome.storage.local.get('fixtures');
    fixtures.push(capture);
    // Meta captures are canaries, not payloads (Gemini fires dozens of
    // batchexecute RPCs per session) — keep a handful so they can't evict
    // full captures from the buffer.
    let metaCount = fixtures.filter(f => f.mode === 'meta').length;
    for (let i = 0; i < fixtures.length && metaCount > FIXTURE_META_MAX; ) {
      if (fixtures[i].mode === 'meta') {
        fixtures.splice(i, 1);
        metaCount -= 1;
      } else {
        i += 1;
      }
    }
    let total = fixtures.reduce((n, f) => n + (f.bytes ?? 0) + (f.requestBody?.length ?? 0), 0);
    while (fixtures.length > FIXTURE_MAX_COUNT || (total > FIXTURE_MAX_TOTAL_BYTES && fixtures.length > 1)) {
      const dropped = fixtures.shift();
      total -= (dropped.bytes ?? 0) + (dropped.requestBody?.length ?? 0);
    }
    await chrome.storage.local.set({ fixtures });
  });
  return fixtureWriteQueue;
}

function pushDebug(entry) {
  if (!IS_DEV) return; // debug log is a development tool
  if (debugLog.length >= DEBUG_MAX) debugLog.shift();
  debugLog.push(entry);
}

// --- Attachment observation ---------------------------------------------
// Files the user attached are hashed in the content script; only name/size/
// type/sha256 arrive here. They wait per-tab until the next completion turn
// on that tab claims them as envelope `inputs`. Persisted so a worker restart
// mid-conversation doesn't lose them; pruned by age.

let attachmentQueue = Promise.resolve();
const ATTACHMENT_TTL_MS = 60 * 60 * 1000;
const ATTACHMENT_MAX_PER_TAB = 20;

function pruneAttachments(pending) {
  const cutoff = Date.now() - ATTACHMENT_TTL_MS;
  for (const [tabId, list] of Object.entries(pending)) {
    const fresh = list.filter(f => Date.parse(f.observedAt) > cutoff);
    if (fresh.length) pending[tabId] = fresh.slice(-ATTACHMENT_MAX_PER_TAB);
    else delete pending[tabId];
  }
  return pending;
}

function recordPendingAttachment(file, tabId) {
  if (tabId == null || !file || typeof file.name !== 'string') return Promise.resolve();
  const write = attachmentQueue.catch(() => {}).then(async () => {
    const { pendingAttachments = {} } = await chrome.storage.local.get('pendingAttachments');
    (pendingAttachments[tabId] ??= []).push({
      name: file.name,
      sizeBytes: file.sizeBytes,
      mediaType: file.mediaType,
      sha256: file.sha256 ?? null,
      note: file.note ?? null,
      source: file.source,
      observedAt: file.observedAt,
    });
    await chrome.storage.local.set({ pendingAttachments: pruneAttachments(pendingAttachments) });
    pushDebug({ type: 'file_observed', ts: file.observedAt, name: file.name, sizeBytes: file.sizeBytes, hashed: Boolean(file.sha256), tabId });
  });
  attachmentQueue = write.catch(() => {});
  return write;
}

async function takePendingAttachments(tabId, turn) {
  // A declared count of 0 is proof this turn sent no files — leave any
  // pending ones for a later turn rather than mis-attributing them.
  if (tabId == null || turn.attachmentCount === 0) return [];
  let taken = [];
  const op = attachmentQueue.catch(() => {}).then(async () => {
    const { pendingAttachments = {} } = await chrome.storage.local.get('pendingAttachments');
    pruneAttachments(pendingAttachments);
    const list = pendingAttachments[tabId] ?? [];
    if (!list.length) return;
    taken = list;
    delete pendingAttachments[tabId];
    await chrome.storage.local.set({ pendingAttachments });
  });
  attachmentQueue = op.catch(() => {});
  await op;
  return taken;
}

// --- Generated files (outputArtifacts) ------------------------------------
// Three observation points cooperate to stamp a file the platform produced:
//   1. blob hashes — the interceptor hashes Blobs at URL.createObjectURL time
//      (the only moment client-built file bytes are observable);
//   2. artifact links — ChatGPT's /interpreter/download call ties a
//      message_id + sandbox_path (and signed URL) to the upcoming download;
//   3. chrome.downloads — the completed download provides filename/size and
//      the URL to match against 1 and 2.
// Matches become artifact envelopes chained into the ledger, linked to the
// parent turn via activity.parentEvidenceId. Unattributable downloads are
// ignored entirely — this must never record the user's unrelated downloads.

const BLOB_TTL_MS = 30 * 60 * 1000;
const PLATFORM_HOSTS = { 'claude.ai': 'claude', 'chatgpt.com': 'chatgpt', 'gemini.google.com': 'gemini' };

function recordBlobHash(ev, sender) {
  attachmentQueue = attachmentQueue.catch(() => {}).then(async () => {
    const { blobHashes = {} } = await chrome.storage.local.get('blobHashes');
    const cutoff = Date.now() - BLOB_TTL_MS;
    for (const [url, entry] of Object.entries(blobHashes)) {
      if (entry.ts < cutoff) delete blobHashes[url];
    }
    blobHashes[ev.url] = {
      sha256: ev.sha256,
      sizeBytes: ev.sizeBytes,
      mediaType: ev.mediaType ?? null,
      platform: platformOfSender(sender),
      ts: Date.now(),
    };
    await chrome.storage.local.set({ blobHashes });
  });
}

function maybeRecordArtifactLink(capture) {
  if (!(capture.url ?? '').includes('/interpreter/download')) return;
  attachmentQueue = attachmentQueue.catch(() => {}).then(async () => {
    let params;
    try { params = new URL(capture.url).searchParams; } catch { return; }
    const body = (() => { try { return JSON.parse(capture.chunks.map(c => c.text).join('')); } catch { return {}; } })();
    const conversationId = (capture.url.match(/\/conversation\/([0-9a-f-]{8,})\//) ?? [])[1] ?? null;
    const { artifactLinks = [] } = await chrome.storage.local.get('artifactLinks');
    const cutoff = Date.now() - BLOB_TTL_MS;
    const fresh = artifactLinks.filter(l => l.ts > cutoff);
    fresh.push({
      platform: capture.platform,
      conversationId,
      messageId: params.get('message_id'),
      sandboxPath: params.get('sandbox_path'),
      downloadUrl: typeof body.download_url === 'string' ? body.download_url.split('?')[0] : null,
      fileId: body.metadata?.file_id ?? null,
      fileName: body.file_name ?? null,
      ts: Date.now(),
    });
    await chrome.storage.local.set({ artifactLinks: fresh.slice(-20) });
    pushDebug({
      type: 'artifact_link',
      platform: capture.platform,
      ts: new Date().toISOString(),
      messageId: params.get('message_id'),
      sandboxPath: params.get('sandbox_path'),
    });
  });
}

// Register the files a just-stamped turn declared, so their later downloads
// can be matched and linked back to this exact envelope.
function recordTurnArtifactLinks(turn, envelope, platform) {
  const op = attachmentQueue.catch(() => {}).then(async () => {
    const { artifactLinks = [] } = await chrome.storage.local.get('artifactLinks');
    const cutoff = Date.now() - BLOB_TTL_MS;
    const fresh = artifactLinks.filter(l => l.ts > cutoff);
    for (const f of turn.generatedFiles) {
      fresh.push({
        platform,
        conversationId: turn.conversationId ?? null,
        messageId: turn.messageId ?? null,
        evidenceId: envelope.evidenceId,
        fileName: f.name ?? null,
        sandboxPath: f.path ?? null,
        downloadUrl: null,
        downloadKey: f.url ? downloadKeyOf(f.url) : null,
        fileId: null,
        ts: Date.now(),
      });
    }
    await chrome.storage.local.set({ artifactLinks: fresh.slice(-20) });
  });
  attachmentQueue = op.catch(() => {});
  return op;
}

// Signed download URLs vary by param order/expiry — host plus the storage
// token (`c=`) identifies the exact object.
function downloadKeyOf(url) {
  try {
    const u = new URL(url);
    const token = u.searchParams.get('c');
    return token ? `${u.host}|c=${token}` : null;
  } catch {
    return null;
  }
}

function platformOfSender(sender) {
  try {
    const host = new URL(sender?.tab?.url ?? sender?.url ?? '').host;
    return Object.entries(PLATFORM_HOSTS).find(([h]) => host === h || host.endsWith('.' + h))?.[1] ?? null;
  } catch { return null; }
}

function basename(p) {
  return String(p ?? '').split(/[\\/]/).pop();
}

chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current !== 'complete') return;
  chrome.downloads.search({ id: delta.id }).then(([item]) => {
    if (item) return handleCompletedDownload(item);
  }).catch(err => pushDebug({
    type: 'artifact_stamped', ts: new Date().toISOString(), ok: false, error: err?.message ?? String(err),
  }));
});

async function handleCompletedDownload(item) {
  const { blobHashes = {} } = await chrome.storage.local.get('blobHashes');
  const { artifactLinks = [] } = await chrome.storage.local.get('artifactLinks');
  const fullUrl = item.finalUrl || item.url || '';
  const urlBase = fullUrl.split('?')[0];
  const filename = basename(item.filename);
  const urlKey = downloadKeyOf(fullUrl);

  const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
  const platformOfHost = host =>
    Object.entries(PLATFORM_HOSTS).find(([h]) => host === h || host.endsWith('.' + h))?.[1] ?? null;
  const urlHostPlatform = platformOfHost(hostOf(fullUrl));

  const blob = blobHashes[item.url] ?? blobHashes[item.finalUrl];
  const link = artifactLinks.findLast(l =>
    (l.downloadKey && urlKey && l.downloadKey === urlKey) ||          // exact storage token (Gemini)
    (l.downloadUrl && l.downloadUrl === urlBase) ||                    // signed-URL base (ChatGPT estuary)
    (l.sandboxPath && basename(l.sandboxPath) === filename) ||         // sandbox filename (ChatGPT/Claude)
    // bare filename match only when the download itself came from a
    // platform host — never lets a look-alike foreign download in
    (l.fileName && l.fileName === filename && urlHostPlatform === l.platform));

  let platform = blob?.platform ?? link?.platform ?? urlHostPlatform;
  if (!platform && item.referrer) {
    platform = platformOfHost(hostOf(item.referrer));
  }
  if (!platform) return; // not ours — never record unrelated downloads

  const settings = await chrome.storage.sync.get([`${platform}Enabled`, 'actorId', 'actorTenantId']);
  const apiKey = await getApiKey();
  if (!apiKey || settings[`${platform}Enabled`] === false) return;

  // Parent turn: by exact evidence id (stream-declared files), then by
  // message id (interpreter/download links), then by the conversation id
  // embedded in the download URL itself (e.g. Claude's wiggle path).
  const ledger = await readLedger();
  let parent = link?.evidenceId
    ? ledger.findLast(r => r.envelope.evidenceId === link.evidenceId)
    : null;
  if (!parent && link?.messageId) {
    parent = ledger.findLast(r => r.envelope.output?.metadata?.messageId === link.messageId);
  }
  const urlConvId = (urlBase.match(/\/conversations?\/([0-9a-f-]{36})/) ?? [])[1] ?? null;
  if (!parent && urlConvId) {
    parent = ledger.findLast(r =>
      r.envelope.activity?.correlationId === urlConvId &&
      r.envelope.purpose?.category === 'chat.completion');
  }

  const actor = { type: 'user', id: settings.actorId ?? await getDeviceId() };
  if (settings.actorTenantId) actor.tenantId = settings.actorTenantId;

  // Bytes: blob hash if the file was client-built; otherwise try an immediate
  // re-fetch of the same signed URL (permitted platform hosts only) — weaker
  // than blob-observed, disclosed as its own class.
  let sha256 = blob?.sha256 ?? null;
  let hashSource = sha256 ? 'blob-observed' : 'none';
  let sizeBytes = item.fileSize > 0 ? item.fileSize : (blob?.sizeBytes ?? null);
  if (!sha256) {
    const refetched = await tryRefetchHash(item);
    if (refetched) {
      sha256 = refetched.sha256;
      hashSource = 'refetch';
      sizeBytes = sizeBytes ?? refetched.sizeBytes;
    }
  }

  const envelope = SigillEvidence.buildArtifactEnvelope({
    platform,
    artifact: {
      filename,
      sizeBytes,
      mediaType: item.mime || blob?.mediaType || null,
      sha256,
      hashSource,
      sourceUrl: item.url?.startsWith('blob:') ? 'blob:(client-generated)' : urlBase,
      downloadedAt: new Date().toISOString(),
    },
    link: {
      conversationId: link?.conversationId ?? parent?.envelope.activity?.correlationId ?? urlConvId ?? null,
      messageId: link?.messageId ?? parent?.envelope.output?.metadata?.messageId ?? null,
      sandboxPath: link?.sandboxPath ?? null,
      platformFileId: link?.fileId ?? null,
      parentEvidenceId: parent?.envelope.evidenceId ?? null,
    },
    model: parent?.envelope.model ?? null,
    actor,
    extensionVersion: chrome.runtime.getManifest().version,
    evidenceId: crypto.randomUUID(),
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  const hashHex = await SigillEvidence.envelopeHashHex(envelope);
  envelope.integrity.envelopeHash = { alg: 'SHA-256', hex: hashHex };
  envelope.proofs = [await stampHash(apiKey, hashHex, `${platform}-artifact-${envelope.evidenceId.slice(0, 8)}`)];
  await appendLog(envelope);
  pushDebug({
    type: 'artifact_stamped',
    platform,
    ts: new Date().toISOString(),
    ok: true,
    filename,
    hashed: Boolean(sha256),
    hashSource,
    parentEvidenceId: parent?.envelope.evidenceId ?? null,
    evidenceId: envelope.evidenceId,
  });
}

// Fetch the just-downloaded signed URL once more and hash the bytes. Only for
// hosts we hold permission for; capped; any failure means no hash claim.
const REFETCH_MAX_BYTES = 50 * 1024 * 1024;

async function tryRefetchHash(item) {
  try {
    const url = item.finalUrl ?? item.url;
    const host = new URL(url).host;
    const permitted = Object.keys(PLATFORM_HOSTS).some(h => host === h || host.endsWith('.' + h));
    if (!permitted) return null;
    if (item.fileSize > REFETCH_MAX_BYTES) return null;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > REFETCH_MAX_BYTES) return null;
    // If the browser knows the downloaded size, the re-fetched bytes must match it.
    if (item.fileSize > 0 && buf.byteLength !== item.fileSize) return null;
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return {
      sha256: Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join(''),
      sizeBytes: buf.byteLength,
    };
  } catch {
    return null;
  }
}

// --- Network-layer stamping ----------------------------------------------
// The evidence path: a finished capture is parsed by its platform adapter
// into a TurnRecord; complete turns are mapped onto AiEvidenceEnvelopeV1,
// hashed, stamped, and appended to the log. Incomplete or unparseable turns
// are surfaced in the debug log — never stamped.

async function maybeStampNetworkTurn(capture) {
  const adapter = SigillTurnAdapters[capture.platform];
  if (capture.mode !== 'full' || capture.error || !adapter?.isCompletion?.(capture)) return;

  const turn = adapter.parseCompletion(capture);
  pushDebug({
    type: 'turn_parsed',
    platform: capture.platform,
    ts: new Date().toISOString(),
    complete: turn.complete,
    action: turn.action,
    model: turn.model,
    messageId: turn.messageId,
    outputLength: turn.outputText.length,
    warnings: turn.warnings,
  });
  if (!turn.complete || !turn.outputText) return;

  const settings = await chrome.storage.sync.get([
    `${capture.platform}Enabled`, 'actorId', 'actorTenantId',
  ]);
  const apiKey = await getApiKey();
  if (!apiKey || settings[`${capture.platform}Enabled`] === false) {
    pushDebug({ type: 'stamp_result', platform: capture.platform, ts: new Date().toISOString(), skipped: true, source: 'network' });
    return;
  }

  // Platform message IDs are stable — never stamp the same message twice
  // (e.g. a re-observed stream after a flaky reload).
  const ledger = await readLedger();
  if (turn.messageId && ledger.some(r => r.envelope.output?.metadata?.messageId === turn.messageId)) {
    pushDebug({ type: 'stamp_dedup', platform: capture.platform, ts: new Date().toISOString(), messageId: turn.messageId });
    return;
  }

  const actor = { type: 'user', id: settings.actorId ?? await getDeviceId() };
  if (settings.actorTenantId) actor.tenantId = settings.actorTenantId;

  const observed = await takePendingAttachments(capture.tabId, turn);
  const attachments = observed.filter(a => a.sha256);
  for (const a of observed.filter(a => !a.sha256)) {
    turn.warnings.push(`attachment observed but not hashed: ${a.name} (${a.note ?? 'unknown reason'})`);
  }
  if (turn.attachmentCount != null && turn.attachmentCount !== attachments.length &&
      (turn.attachmentCount > 0 || attachments.length > 0)) {
    turn.warnings.push(`request declared ${turn.attachmentCount} attachment(s), extension observed ${attachments.length}`);
  }

  const envelope = SigillEvidence.buildTurnEnvelope({
    turn,
    capture,
    actor,
    attachments,
    extensionVersion: chrome.runtime.getManifest().version,
    evidenceId: crypto.randomUUID(),
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  const hashHex = await SigillEvidence.envelopeHashHex(envelope);
  envelope.integrity.envelopeHash = { alg: 'SHA-256', hex: hashHex };
  const proof = await stampHash(apiKey, hashHex, `${capture.platform}-turn-${envelope.evidenceId.slice(0, 8)}`);
  envelope.proofs = [proof];
  await appendLog(envelope);
  if (turn.generatedFiles?.length) {
    await recordTurnArtifactLinks(turn, envelope, capture.platform);
  }

  pushDebug({
    type: 'stamp_result',
    platform: capture.platform,
    ts: new Date().toISOString(),
    ok: true,
    source: 'network',
    evidenceId: envelope.evidenceId,
    messageId: turn.messageId,
  });

  if (capture.tabId != null) {
    chrome.tabs.sendMessage(capture.tabId, {
      type: 'NETWORK_TURN_STAMPED',
      platform: capture.platform,
      conversationId: turn.conversationId,
      messageId: turn.messageId,
      evidenceId: envelope.evidenceId,
      genTime: proof.genTime,
      tsaName: proof.tsaName,
    }).catch(() => { /* tab closed — evidence is logged regardless */ });
  }
}

// Stable pseudonymous actor id for envelopes produced without a connected
// Sigill identity — actor.id is required by the schema. Device-local by
// design (storage.local, not sync).
async function getDeviceId() {
  const { deviceId } = await chrome.storage.local.get('deviceId');
  if (deviceId) return deviceId;
  const id = 'ext-' + crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

async function getFixtureStats() {
  const { fixtures = [] } = await chrome.storage.local.get('fixtures');
  const bytes = fixtures.reduce((n, f) => n + (f.bytes ?? 0) + (f.requestBody?.length ?? 0), 0);
  return { count: fixtures.length, bytes };
}

async function exportFixtures() {
  const { fixtures = [] } = await chrome.storage.local.get('fixtures');
  return { fixtures };
}

async function clearFixtures() {
  await chrome.storage.local.set({ fixtures: [] });
  return { ok: true };
}

async function getStats() {
  const ledger = await readLedger();
  const { anchors = [] } = await chrome.storage.local.get('anchors');
  return {
    count: ledger.length,
    anchorCount: anchors.length,
    lastAnchoredAt: anchors.at(-1)?.anchoredAt ?? null,
  };
}

// Claude badge restore: the DOM exposes no message ids, but the platform's
// own history response (captured on conversation load) gives the current
// branch. Map its assistant messages onto ledger evidence and send the tab
// position-indexed placements — nth assistant element gets nth badge.
async function maybeSendBadgePositions(capture) {
  if (capture.platform !== 'claude' || capture.method !== 'GET' || capture.tabId == null) return;
  if (!SigillTurnAdapters.claude.isHistory(capture)) return;
  const history = SigillTurnAdapters.claude.parseHistory(capture);
  if (!history?.nodes?.length) return;

  // Walk the current branch leaf → root, then put it in display order
  const byId = new Map(history.nodes.map(n => [n.id, n]));
  const chain = [];
  let cursor = history.currentNode;
  while (cursor && byId.has(cursor)) {
    chain.push(byId.get(cursor));
    cursor = byId.get(cursor).parentId;
  }
  chain.reverse();
  const assistants = chain.filter(n => n.role === 'assistant');

  const ledger = await readLedger();
  const evidenceByMsg = new Map();
  for (const r of ledger) {
    const mid = r.envelope.output?.metadata?.messageId;
    if (mid) evidenceByMsg.set(mid, r.envelope);
  }

  const turns = [];
  assistants.forEach((n, index) => {
    const env = evidenceByMsg.get(n.id);
    if (env) {
      turns.push({
        index,
        messageId: n.id,
        evidenceId: env.evidenceId,
        genTime: env.proofs?.[0]?.genTime,
        tsaName: env.proofs?.[0]?.tsaName,
      });
    }
  });
  if (!turns.length) return;

  chrome.tabs.sendMessage(capture.tabId, {
    type: 'BADGE_POSITIONS',
    platform: 'claude',
    conversationId: history.conversationId,
    turns,
  }).catch(() => { /* tab closed — display only */ });
  pushDebug({
    type: 'badge_positions_sent',
    platform: 'claude',
    ts: new Date().toISOString(),
    count: turns.length,
    conversationId: history.conversationId,
  });
}

// Stamped turns for one conversation — consumed by the badge-restore loop in
// content/shared.js, which locates messages by data-message-id.
async function getStampedTurns({ platform, conversationId }) {
  const ledger = await readLedger();
  const provider = PROVIDER[platform] ?? platform;
  const turns = [];
  for (const envelope of ledger.map(r => r.envelope)) {
    if (envelope.model?.provider !== provider) continue;
    if (envelope.purpose?.category !== 'chat.completion') continue;
    // Gemini's network id is 'c_<hex>' while the page URL exposes bare '<hex>'
    const corr = envelope.activity?.correlationId ?? '';
    if (corr !== conversationId && corr !== `c_${conversationId}`) continue;
    turns.push({
      messageId: envelope.output?.metadata?.messageId ?? null,
      evidenceId: envelope.evidenceId,
      genTime: envelope.proofs?.[0]?.genTime,
      tsaName: envelope.proofs?.[0]?.tsaName,
    });
  }
  return { turns };
}

// The export is a self-contained evidence bundle: chained records + anchor
// stamps. tools/verify-bundle.js validates one with no Sigill dependency.
async function buildExportBundle() {
  const ledger = await readLedger();
  const { anchors = [] } = await chrome.storage.local.get('anchors');
  return {
    format: 'sigill-evidence-bundle',
    formatVersion: '1',
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    ledger,
    anchors,
  };
}

async function exportLog() {
  return { bundle: await buildExportBundle() };
}

async function clearLog() {
  logWriteQueue = logWriteQueue.catch(() => {})
    .then(() => chrome.storage.local.set({ ledger: [], anchors: [] }));
  await logWriteQueue;
  return { ok: true, count: 0 };
}

async function listSealCertificates() {
  const apiKey = await getApiKey();
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
  const apiKey = await getApiKey();
  if (!apiKey) return { error: 'Missing API key' };
  if (!certificateId) return { error: 'Choose a seal certificate first' };

  const bundle = await buildExportBundle();
  if (!bundle.ledger.length) return { error: 'No stamped turns to seal' };

  const text = JSON.stringify(bundle, null, 2);
  const filename = `sigill-evidence-bundle-${Date.now()}.json`;

  // Hash the bundle locally — its content never leaves the browser
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
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
    text,
    signatureBase64: btoa(binary),
    format: resp.headers.get('X-Seal-Format') ?? 'cades',
    operationId: resp.headers.get('X-Seal-Operation-Id'),
    certificateId: resp.headers.get('X-Seal-Certificate-Id') ?? certificateId,
    timestampedBy: resp.headers.get('X-Seal-Timestamped-By'),
    qualified: resp.headers.get('X-Seal-Qualified') === 'true',
  };
}
