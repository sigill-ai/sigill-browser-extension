importScripts('../lib/turn-adapters.js', '../lib/evidence-envelope.js', '../lib/evidence-ledger.js',
  '../lib/agent-evidence.js', '../lib/sigill-auth.js', '../lib/sigill-mcp.js', '../lib/conversation-recorder.js',
  '../lib/claude-rpc.js');

const API_BASE = 'https://api.sigill.ai';
const PROVIDER = SigillEvidence.PROVIDER;
// Dev detection is build-time: the repo manifest carries version_name
// "x.y.z-dev"; tools/pack.sh strips it for the public zip. (update_url can't
// distinguish — self-distributed zips are loaded unpacked, same as dev.)
const IS_DEV = /-dev$/.test(chrome.runtime.getManifest().version_name ?? '');
let logWriteQueue = Promise.resolve();
const VERSION = chrome.runtime.getManifest().version;

// Sigill sign-in (OAuth + PKCE). The extension holds an MCP token for the recording
// tools only; it never reads the sigill.ai session and holds no API key.
const auth = SigillAuth.create({
  storage: chrome.storage.local,
  fetch: (...a) => fetch(...a),
  launchWebAuthFlow: o => chrome.identity.launchWebAuthFlow(o),
  redirectUrl: chrome.identity.getRedirectURL('callback'),
  issuer: API_BASE,
});
const mcp = SigillMcp.create({ fetch: (...a) => fetch(...a), accessToken: () => auth.accessToken(), base: API_BASE, version: VERSION });
const recorder = SigillConversationRecorder.create({
  storage: chrome.storage.local,
  mcp,
  evidence: SigillAgentEvidence,
  version: VERSION,
  settings: async () => {
    const s = await chrome.storage.sync.get(['claudeEnabled', 'chatgptEnabled', 'geminiEnabled']);
    const { sealCertificateId } = await chrome.storage.local.get('sealCertificateId');
    return {
      sealCertificateId: sealCertificateId || null,
      platformsEnabled: { claude: s.claudeEnabled !== false, chatgpt: s.chatgptEnabled !== false, gemini: s.geminiEnabled !== false },
    };
  },
  log: line => pushDebug({ type: 'recorder', ts: new Date().toISOString(), line }),
});

// Credentials of earlier versions are removed, never used: the API key and the
// identity scraped from a sigill.ai session (email + organisation).
chrome.storage.local.remove('apiKey');
chrome.storage.sync.remove(['apiKey', 'actorId', 'actorTenantId', 'actorTenantName', 'sigillConnected']);
recorder.recover();

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
  if (msg.type === 'SET_SEAL_CERTIFICATE') {
    // Applies to runs that start from now on: one run, one signer.
    chrome.storage.local.set({ sealCertificateId: msg.certificateId || '' }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'CONNECT') {
    auth.connect().then(r => sendResponse({ ok: true, ...r })).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'DISCONNECT') {
    auth.disconnect().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'GET_CONNECTION') {
    auth.status().then(sendResponse);
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
});

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

// Housekeeping: close conversations idle for 30 minutes (run_end) and index sealed
// artifacts that are not yet in the Evidence Store. The legacy ledger above is
// read-only: it is kept for export, and nothing is added to it any more.
async function recorderHousekeeping() {
  if (!(await auth.status()).connected) return;
  const closed = await recorder.closeIdle();
  let flushed;
  do { flushed = await recorder.flushOutbox(); } while (flushed.indexed > 0 && flushed.pending > 0);
  pushDebug({ type: 'housekeeping', ts: new Date().toISOString(), closed, unindexed: flushed.pending });
}

function flushSoon() {
  recorder.flushOutbox().catch(err => pushDebug({ type: 'index', ts: new Date().toISOString(), ok: false, error: err?.message ?? String(err) }));
}

chrome.alarms.clear('sigill-ledger-anchor');
chrome.alarms.get('sigill-recorder').then(alarm => {
  if (!alarm) chrome.alarms.create('sigill-recorder', { periodInMinutes: 5, delayInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'sigill-recorder') return;
  recorderHousekeeping().catch(err => pushDebug({
    type: 'housekeeping', ts: new Date().toISOString(), ok: false, error: err?.message ?? String(err),
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
        if (capture.platform === 'claude' && SigillClaudeRpc.isTimelineStream(capture.url)) {
          capture.rpc = SigillClaudeRpc.createParser();
          capture.rpcQueue = Promise.resolve();
          const early = capture.chunks.splice(0); // chunks that overtook the start event
          if (early.length) feedTimeline(capture, early);
        }
        break;
      case 'response':
        capture.status = ev.status;
        capture.responseContentType = ev.responseContentType ?? null;
        break;
      case 'chunks':
        capture.bytes += ev.chunks.reduce((n, c) => n + c.text.length, 0);
        if (capture.rpc) feedTimeline(capture, ev.chunks); // parsed as it streams; no copy kept
        else capture.chunks.push(...ev.chunks);
        // ChatGPT keeps the completion connection open after the answer: the SSE
        // terminator, not the end of the connection, closes the turn.
        if (capture.platform === 'chatgpt' && !capture.turnSettled &&
            /(^|\n)data: \[DONE\]\s*$/.test(capture.chunks.slice(-4).map(c => c.text).join(''))) {
          settleTurn(capture);
        }
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
        if (!capture.turnSettled) settleTurn(capture);
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
function recordTurnArtifactLinks(turn, platform) {
  const op = attachmentQueue.catch(() => {}).then(async () => {
    const { artifactLinks = [] } = await chrome.storage.local.get('artifactLinks');
    const cutoff = Date.now() - BLOB_TTL_MS;
    const fresh = artifactLinks.filter(l => l.ts > cutoff);
    for (const f of turn.generatedFiles) {
      fresh.push({
        platform,
        conversationId: turn.conversationId ?? null,
        messageId: turn.messageId ?? null,
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

  const settings = await chrome.storage.sync.get(`${platform}Enabled`);
  if (settings[`${platform}Enabled`] === false || !(await auth.status()).connected) return;

  // The conversation the file belongs to: by the turn that declared it, by the
  // message id of an interpreter/download link, or by the id in the download URL.
  const urlConvId = (urlBase.match(/\/conversations?\/([0-9a-f-]{36})/) ?? [])[1] ?? null;
  const byMessage = link?.messageId ? await recorder.turnByMessageId(link.messageId) : null;
  const conversationId = link?.conversationId ?? byMessage?.conversationId ?? urlConvId;

  // Bytes: blob hash if the file was client-built; otherwise an immediate re-fetch
  // of the same signed URL (platform hosts only). Without a digest there is
  // nothing to seal.
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
  if (!sha256 || !conversationId) {
    pushDebug({ type: 'artifact_stamped', platform, ts: new Date().toISOString(), ok: false, skipped: !sha256 ? 'no digest' : 'no conversation', filename });
    return;
  }

  const r = await recorder.recordGeneratedFile({
    platform, conversationId, sha256, sizeBytes, mediaType: item.mime || blob?.mediaType || null,
  });
  flushSoon();
  pushDebug({
    type: 'artifact_stamped', platform, ts: new Date().toISOString(), ok: true, filename, hashSource, runId: r.runId, seq: r.seq,
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

  return recordParsedTurn(adapter.parseCompletion(capture), capture);
}

async function recordParsedTurn(turn, capture) {
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

  const settings = await chrome.storage.sync.get(`${capture.platform}Enabled`);
  const connection = await auth.status();
  if (!connection.connected || settings[`${capture.platform}Enabled`] === false) {
    pushDebug({ type: 'stamp_result', platform: capture.platform, ts: new Date().toISOString(), skipped: true, source: 'network' });
    return;
  }

  // Platform message ids are stable — never record the same message twice
  // (e.g. a re-observed stream after a flaky reload).
  const ledger = await readLedger();
  if (turn.messageId && (await recorder.turnByMessageId(turn.messageId) ||
      ledger.some(r => r.envelope.output?.metadata?.messageId === turn.messageId))) {
    pushDebug({ type: 'stamp_dedup', platform: capture.platform, ts: new Date().toISOString(), messageId: turn.messageId });
    return;
  }

  const observed = await takePendingAttachments(capture.tabId, turn);
  const attachments = observed.filter(a => a.sha256);
  for (const a of observed.filter(a => !a.sha256)) {
    turn.warnings.push(`attachment observed but not hashed: ${a.name} (${a.note ?? 'unknown reason'})`);
  }
  if (turn.attachmentCount != null && turn.attachmentCount !== attachments.length &&
      (turn.attachmentCount > 0 || attachments.length > 0)) {
    turn.warnings.push(`request declared ${turn.attachmentCount} attachment(s), extension observed ${attachments.length}`);
  }

  const r = await recorder.recordTurn({
    platform: capture.platform,
    conversationId: turn.conversationId,
    messageId: turn.messageId,
    model: turn.model,
    promptText: turn.promptText,
    outputText: turn.outputText,
    attachments,
  });
  flushSoon();
  if (turn.generatedFiles?.length) {
    await recordTurnArtifactLinks(turn, capture.platform);
  }

  pushDebug({
    type: 'stamp_result',
    platform: capture.platform,
    ts: new Date().toISOString(),
    ok: true,
    source: 'network',
    runId: r.runId,
    seq: r.seq,
    messageId: turn.messageId,
  });

  if (capture.tabId != null) {
    chrome.tabs.sendMessage(capture.tabId, {
      type: 'NETWORK_TURN_STAMPED',
      platform: capture.platform,
      conversationId: turn.conversationId,
      messageId: turn.messageId,
      evidenceId: r.evidenceId,
      genTime: r.genTime,
      tsaName: r.tsaName,
    }).catch(() => { /* tab closed — evidence is recorded regardless */ });
  }
}

// Parse and record a finished completion capture, once.
function settleTurn(capture) {
  capture.turnSettled = true;
  maybeStampNetworkTurn(capture).catch(err => pushDebug({
    type: 'stamp_result',
    platform: capture.platform,
    ts: new Date().toISOString(),
    ok: false,
    source: 'network',
    error: err?.message ?? String(err),
  }));
}

// claude.ai's timeline stream carries every turn of a conversation and stays open:
// it is parsed as it arrives (lib/claude-rpc.js) and each completed answer is
// recorded on its own. Feeding is serialized per capture (frames may be gzipped).
function feedTimeline(capture, chunks) {
  capture.rpcQueue = capture.rpcQueue.then(async () => {
    for (const c of chunks) {
      if (c.enc !== 'b64') continue;
      const bin = atob(c.text);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      for (const turn of await capture.rpc.push(bytes)) {
        await recordParsedTurn(turn, capture).catch(err => pushDebug({
          type: 'stamp_result', platform: 'claude', ts: new Date().toISOString(), ok: false, source: 'network', error: err?.message ?? String(err),
        }));
      }
    }
  }).catch(err => pushDebug({ type: 'turn_parsed', platform: 'claude', ts: new Date().toISOString(), complete: false, warnings: [err?.message ?? String(err)] }));
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
  const rec = await recorder.stats();
  return { ...rec, legacyCount: ledger.length };
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

  const evidenceByMsg = new Map();
  for (const r of await readLedger()) {
    const mid = r.envelope.output?.metadata?.messageId;
    if (mid) evidenceByMsg.set(mid, { evidenceId: r.envelope.evidenceId, genTime: r.envelope.proofs?.[0]?.genTime, tsaName: r.envelope.proofs?.[0]?.tsaName });
  }
  for (const t of await recorder.stampedTurns('claude', history.conversationId)) {
    if (t.messageId) evidenceByMsg.set(t.messageId, { evidenceId: t.evidenceId, genTime: t.genTime, tsaName: t.tsaName });
  }

  const turns = [];
  assistants.forEach((n, index) => {
    const ev = evidenceByMsg.get(n.id);
    if (ev) turns.push({ index, messageId: n.id, ...ev });
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
  for (const t of await recorder.stampedTurns(platform, conversationId)) {
    turns.push({ messageId: t.messageId, evidenceId: t.evidenceId, genTime: t.genTime, tsaName: t.tsaName });
  }
  return { turns };
}

// Export: every recorded run as an AgentRunBundle (verifiable offline and at
// sigill.ai/verify-run), plus the read-only ledger of earlier versions when it
// holds anything (tools/verify-bundle.js validates that one).
async function exportLog() {
  const runs = await recorder.bundles();
  const ledger = await readLedger();
  let legacy = null;
  if (ledger.length) {
    const { anchors = [] } = await chrome.storage.local.get('anchors');
    legacy = {
      format: 'sigill-evidence-bundle',
      formatVersion: '1',
      exportedAt: new Date().toISOString(),
      extensionVersion: VERSION,
      ledger,
      anchors,
    };
  }
  return { runs, legacy };
}

async function clearLog() {
  await recorder.clear();
  logWriteQueue = logWriteQueue.catch(() => {})
    .then(() => chrome.storage.local.set({ ledger: [], anchors: [] }));
  await logWriteQueue;
  return { ok: true, count: 0 };
}

// Certificates the organisation can seal agent evidence with: its own, then the
// Sigill Platform Seal. The choice applies to runs that start afterwards.
async function listSealCertificates() {
  if (!(await auth.status()).connected) return { certificates: [], selected: null };
  const cfg = await mcp.recordingConfig();
  const { sealCertificateId } = await chrome.storage.local.get('sealCertificateId');
  return { certificates: cfg.certificates ?? [], selected: sealCertificateId || null };
}
