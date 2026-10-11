const $ = id => document.getElementById(id);
const PLATFORMS = ['claude', 'chatgpt', 'gemini'];
let pendingClearCount = 0;
let currentLogCount = 0;

let isDev = false;
let connected = false;

async function load() {
  const data = await chrome.storage.sync.get(['fixtureCapture', ...PLATFORMS.map(p => `${p}Enabled`)]);
  isDev = (await chrome.runtime.sendMessage({ type: 'IS_DEV' }).catch(() => ({})))?.dev === true;

  PLATFORMS.forEach(p => {
    $(`${p}Enabled`).checked = data[`${p}Enabled`] !== false;
  });
  $('devSection').hidden = !isDev;
  if (isDev) {
    $('fixtureCapture').checked = data.fixtureCapture !== false;
    await loadFixtureStats();
  }

  const conn = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION' }).catch(() => ({ connected: false }));
  connected = conn?.connected === true;
  $('connectedState').hidden = !connected;
  $('signInState').hidden = connected;
  if (connected && conn.connectedAt) $('connectedSince').textContent = `since ${new Date(conn.connectedAt).toLocaleDateString()}`;
  $('connectBtn').textContent = conn?.needsReconnect ? 'Sign in to Sigill again' : 'Sign in with Sigill';

  const stats = await chrome.runtime.sendMessage({ type: 'GET_STATS' }).catch(() => ({}));
  const turns = stats?.turns ?? 0;
  const runs = stats?.runs ?? 0;
  currentLogCount = runs + (stats?.legacyCount ?? 0);
  let text = runs ? `${turns} turn${turns === 1 ? '' : 's'} in ${runs} run${runs === 1 ? '' : 's'}` : 'Nothing recorded yet';
  if (stats?.legacyCount) text += ` · ${stats.legacyCount} earlier`;
  let color = '#94a3b8';
  if (!connected) { text = conn?.needsReconnect ? 'Not recording — sign in again' : 'Not recording — sign in to start'; color = '#f59e0b'; }
  else if (stats?.lastStop && stats.openRuns === 0 && /quota/i.test(stats.lastStop)) { text = 'Paused — agent evidence quota reached'; color = '#f59e0b'; }
  $('stats').textContent = text;
  $('stats').style.color = color;
  $('exportBtn').disabled = currentLogCount === 0;
  $('clearBtn').disabled = currentLogCount === 0;
  if (currentLogCount === 0 || pendingClearCount !== currentLogCount) hideClearConfirm();
}

async function save() {
  const data = {};
  PLATFORMS.forEach(p => { data[`${p}Enabled`] = $(`${p}Enabled`).checked; });
  await chrome.storage.sync.set(data);
}

PLATFORMS.forEach(p => $(`${p}Enabled`).addEventListener('change', save));

$('connectBtn').addEventListener('click', async () => {
  $('connectBtn').disabled = true;
  setStatus('connectStatus', 'Waiting for sign-in in the Sigill window…', '');
  const res = await chrome.runtime.sendMessage({ type: 'CONNECT' }).catch(err => ({ error: err.message }));
  $('connectBtn').disabled = false;
  setStatus('connectStatus', res?.error ?? '', res?.error ? 'seal-status-error' : '');
  await load();
  await loadSealCertificates();
});

$('disconnectBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'DISCONNECT' });
  await load();
  await loadSealCertificates();
});

// Info panel toggle
$('infoBtn').addEventListener('click', () => {
  const panel = $('infoPanel');
  const open = panel.style.display !== 'none' && panel.style.display !== '';
  panel.style.display = open ? 'none' : 'block';
  $('infoBtn').classList.toggle('info-btn-active', !open);
});

$('exportBtn').addEventListener('click', async () => {
  const { runs, legacy } = await chrome.runtime.sendMessage({ type: 'EXPORT' });
  for (const r of runs ?? []) {
    downloadText(`sigill-agent-run-${r.name}.json`, JSON.stringify(r.bundle, null, 2), 'application/json');
  }
  if (legacy?.ledger?.length) {
    downloadText(`sigill-evidence-bundle-${Date.now()}.json`, JSON.stringify(legacy, null, 2), 'application/json');
  }
});

$('certificateSelect').addEventListener('change', async () => {
  await chrome.runtime.sendMessage({ type: 'SET_SEAL_CERTIFICATE', certificateId: $('certificateSelect').value });
  setStatus('sealStatus', 'Applies to conversations that start from now on.', 'seal-status-ok');
});

async function loadFixtureStats() {
  const stats = await chrome.runtime.sendMessage({ type: 'GET_FIXTURE_STATS' }).catch(() => ({ count: 0, bytes: 0 }));
  const count = stats?.count ?? 0;
  const kb = Math.round((stats?.bytes ?? 0) / 1024);
  $('fixtureStats').textContent = count === 0 ? 'No fixtures yet' : `${count} fixture${count === 1 ? '' : 's'} · ${kb} KB`;
  $('exportFixturesBtn').disabled = count === 0;
  $('clearFixturesBtn').disabled = count === 0;
}

$('fixtureCapture').addEventListener('change', () => {
  chrome.storage.sync.set({ fixtureCapture: $('fixtureCapture').checked });
});

$('exportFixturesBtn').addEventListener('click', async () => {
  const { fixtures } = await chrome.runtime.sendMessage({ type: 'EXPORT_FIXTURES' });
  if (!fixtures?.length) return;
  downloadText(`sigill-fixtures-${Date.now()}.json`, JSON.stringify(fixtures, null, 2), 'application/json');
});

$('clearFixturesBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_FIXTURES' });
  await loadFixtureStats();
});

$('debugBtn').addEventListener('click', async () => {
  const { log } = await chrome.runtime.sendMessage({ type: 'GET_DEBUG_LOG' });
  if (!log?.length) { alert('No debug entries yet — trigger a response first.'); return; }
  downloadText(`sigill-debug-${Date.now()}.json`, JSON.stringify(log, null, 2), 'application/json');
  await chrome.runtime.sendMessage({ type: 'CLEAR_DEBUG_LOG' });
});

$('clearBtn').addEventListener('click', async () => {
  const count = currentLogCount;
  if (!count) return;
  pendingClearCount = count;
  $('clearConfirmText').textContent = 'Clear all recorded runs from this browser? Runs already indexed stay in Sigill; export first to keep the bundles.';
  $('clearConfirm').hidden = false;
});

$('cancelClearBtn').addEventListener('click', hideClearConfirm);

$('confirmClearBtn').addEventListener('click', async () => {
  $('confirmClearBtn').disabled = true;
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOG' });
  hideClearConfirm();
  await load();
});

function hideClearConfirm() {
  pendingClearCount = 0;
  $('clearConfirm').hidden = true;
  $('confirmClearBtn').disabled = false;
}

async function loadSealCertificates() {
  const select = $('certificateSelect');
  setStatus('sealStatus', '', '');
  if (!connected) {
    select.replaceChildren(new Option('Sign in to choose', ''));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.replaceChildren(new Option('Loading certificates…', ''));
  const res = await chrome.runtime.sendMessage({ type: 'LIST_SEAL_CERTIFICATES' }).catch(err => ({ error: err.message }));
  if (res?.error) {
    select.replaceChildren(new Option('Could not load certificates', ''));
    setStatus('sealStatus', res.error, 'seal-status-error');
    return;
  }
  const certs = res?.certificates ?? [];
  const platform = certs.find(c => c.source === 'platform');
  const own = certs.filter(c => c.source !== 'platform');
  // Default (empty value): the Sigill Platform Seal. The organisation's own certificates follow.
  select.replaceChildren(
    new Option(platform ? 'Sigill Platform Seal' : 'Sigill Platform Seal (unavailable)', ''),
    ...own.map(c => new Option(c.label || 'Organisation certificate', c.id)),
  );
  select.value = res.selected && own.some(c => c.id === res.selected) ? res.selected : '';
}

function setStatus(id, text, className) {
  $(id).textContent = text;
  $(id).className = `seal-status ${className}`.trim();
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  downloadBlob(filename, blob);
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: filename,
  });
  a.click();
  URL.revokeObjectURL(url);
}

load().then(loadSealCertificates);
