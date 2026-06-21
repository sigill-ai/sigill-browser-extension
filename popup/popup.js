const $ = id => document.getElementById(id);
const PLATFORMS = ['claude', 'chatgpt', 'gemini'];

async function load() {
  const keys = ['apiKey', ...PLATFORMS.map(p => `${p}Enabled`)];
  const data = await chrome.storage.sync.get(keys);

  $('apiKey').value = data.apiKey ?? '';
  PLATFORMS.forEach(p => {
    $(`${p}Enabled`).checked = data[`${p}Enabled`] !== false;
  });

  const stats = await chrome.runtime.sendMessage({ type: 'GET_STATS' }).catch(() => ({ count: 0 }));
  $('stats').textContent = `${stats?.count ?? 0} turns stamped`;
}

async function save() {
  const data = { apiKey: $('apiKey').value.trim() };
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

$('exportBtn').addEventListener('click', async () => {
  const { log } = await chrome.runtime.sendMessage({ type: 'EXPORT' });
  if (!log?.length) return;
  const jsonl = log.map(e => JSON.stringify(e)).join('\n');
  const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `sigill-log-${Date.now()}.jsonl`,
  });
  a.click();
  URL.revokeObjectURL(url);
});

load();
