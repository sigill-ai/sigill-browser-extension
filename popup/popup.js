const $ = id => document.getElementById(id);
const PLATFORMS = ['claude', 'chatgpt', 'gemini'];
let pendingClearCount = 0;
let currentLogCount = 0;

let isDev = false;

async function load() {
  const keys = ['actorId', 'actorTenantId', 'actorTenantName', 'sigillConnected', 'sealCertificateId', 'fixtureCapture', ...PLATFORMS.map(p => `${p}Enabled`)];
  const data = await chrome.storage.sync.get(keys);
  const { apiKey } = await chrome.runtime.sendMessage({ type: 'GET_API_KEY' }).catch(() => ({}));
  isDev = (await chrome.runtime.sendMessage({ type: 'IS_DEV' }).catch(() => ({})))?.dev === true;

  $('apiKey').value = apiKey ?? '';
  PLATFORMS.forEach(p => {
    $(`${p}Enabled`).checked = data[`${p}Enabled`] !== false;
  });
  $('devSection').hidden = !isDev;
  if (isDev) {
    $('fixtureCapture').checked = data.fixtureCapture !== false;
    await loadFixtureStats();
  }

  if (data.sigillConnected && data.actorId) {
    $('connectedState').style.display = 'block';
    $('signInState').style.display = 'none';
    $('connectedEmail').textContent = data.actorId;
    $('connectedOrg').textContent = data.actorTenantName ?? '';
  } else {
    $('connectedState').style.display = 'none';
    $('signInState').style.display = 'block';
  }

  const stats = await chrome.runtime.sendMessage({ type: 'GET_STATS' }).catch(() => ({ count: 0 }));
  const count = stats?.count ?? 0;
  currentLogCount = count;
  const noKey = !apiKey;
  const anchorNote = stats?.anchorCount ? ` · ${stats.anchorCount} anchor${stats.anchorCount === 1 ? '' : 's'}` : '';
  $('stats').textContent = noKey ? 'Add your API key above to start' : `${count} turns stamped${anchorNote}`;
  $('stats').style.color = noKey ? '#f59e0b' : '#94a3b8';
  $('exportBtn').disabled = count === 0;
  $('clearBtn').disabled = count === 0;
  $('sealBtn').disabled = noKey || count === 0 || !$('certificateSelect').value;
  if (count === 0 || pendingClearCount !== count) hideClearConfirm();
}

async function save() {
  await chrome.runtime.sendMessage({ type: 'SET_API_KEY', apiKey: $('apiKey').value.trim() });
  const data = {};
  PLATFORMS.forEach(p => { data[`${p}Enabled`] = $(`${p}Enabled`).checked; });
  await chrome.storage.sync.set(data);
}

$('toggleKey').addEventListener('click', () => {
  const inp = $('apiKey');
  const showing = inp.type === 'text';
  inp.type = showing ? 'password' : 'text';
  $('toggleKey').textContent = showing ? 'Show' : 'Hide';
});

$('apiKey').addEventListener('change', save);
PLATFORMS.forEach(p => $(`${p}Enabled`).addEventListener('change', save));

$('disconnectBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'DISCONNECT_IDENTITY' });
  await load();
});

// Info panel toggle
$('infoBtn').addEventListener('click', () => {
  const panel = $('infoPanel');
  const open = panel.style.display !== 'none' && panel.style.display !== '';
  panel.style.display = open ? 'none' : 'block';
  $('infoBtn').classList.toggle('info-btn-active', !open);
});

$('exportBtn').addEventListener('click', async () => {
  const { bundle } = await chrome.runtime.sendMessage({ type: 'EXPORT' });
  if (!bundle?.ledger?.length) return;
  downloadText(`sigill-evidence-bundle-${Date.now()}.json`, JSON.stringify(bundle, null, 2), 'application/json');
});

$('refreshCertsBtn').addEventListener('click', loadSealCertificates);

$('certificateSelect').addEventListener('change', async () => {
  await chrome.storage.sync.set({ sealCertificateId: $('certificateSelect').value });
  $('sealBtn').disabled = currentLogCount === 0 || !$('certificateSelect').value;
});

$('sealBtn').addEventListener('click', async () => {
  const certificateId = $('certificateSelect').value;
  if (!certificateId || currentLogCount === 0) return;

  setSealStatus('Sealing log...', '');
  $('sealBtn').disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'SEAL_LOG', certificateId }).catch(err => ({ error: err.message }));
  if (res?.error) {
    setSealStatus(res.error, 'seal-status-error');
    $('sealBtn').disabled = false;
    return;
  }

  downloadText(res.filename, res.text, 'application/json');
  const signatureName = res.format === 'pades'
    ? res.filename.replace(/\.json$/, '_sealed.pdf')
    : res.filename.replace(/\.json$/, '.p7s');
  downloadBase64(signatureName, res.signatureBase64, res.format === 'pades' ? 'application/pdf' : 'application/pkcs7-signature');
  setSealStatus(`Sealed as ${res.format.toUpperCase()}${res.timestampedBy ? `, timestamped by ${res.timestampedBy}` : ''}.`, 'seal-status-ok');
  $('sealBtn').disabled = currentLogCount === 0 || !$('certificateSelect').value;
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
  const stats = await chrome.runtime.sendMessage({ type: 'GET_STATS' }).catch(() => ({ count: 0 }));
  const count = stats?.count ?? 0;
  if (!count) return;
  pendingClearCount = count;
  $('clearConfirmText').textContent = `Clear ${count} stamped turn${count === 1 ? '' : 's'} from local storage?`;
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
  const { sealCertificateId } = await chrome.storage.sync.get('sealCertificateId');
  select.replaceChildren(new Option('Loading certificates...', ''));
  $('sealBtn').disabled = true;
  setSealStatus('', '');

  const res = await chrome.runtime.sendMessage({ type: 'LIST_SEAL_CERTIFICATES' }).catch(err => ({ error: err.message }));
  if (res?.error) {
    select.replaceChildren(new Option('Could not load certificates', ''));
    setSealStatus(res.error, 'seal-status-error');
    return;
  }

  const certs = res?.certificates ?? [];
  if (!certs.length) {
    select.replaceChildren(new Option('No active seal certificates', ''));
    setSealStatus('Add or activate a seal certificate in Sigill to enable sealing.', '');
    return;
  }

  select.replaceChildren(...certs.map(cert => {
    const source = cert.source ? ` (${cert.source})` : '';
    return new Option(`${cert.label ?? cert.certSubject ?? 'Certificate'}${source}`, cert.id);
  }));
  if (sealCertificateId && certs.some(cert => cert.id === sealCertificateId)) {
    select.value = sealCertificateId;
  }
  $('sealBtn').disabled = currentLogCount === 0 || !select.value;
}

function setSealStatus(text, className) {
  $('sealStatus').textContent = text;
  $('sealStatus').className = `seal-status ${className}`.trim();
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  downloadBlob(filename, blob);
}

function downloadBase64(filename, base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  downloadBlob(filename, new Blob([bytes], { type }));
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
