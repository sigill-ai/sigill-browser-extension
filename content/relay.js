// Sigill relay — ISOLATED-world bridge between the MAIN-world interceptor
// (content/interceptor.js) and the background worker.
//
// The MAIN world is semi-trusted: any page script can post window messages, so
// every event is shape-validated and size-capped here before it reaches the
// extension. The relay also dispatches lightweight summaries as 'sigill:debug'
// DOM events so the debug overlay (Alt+Shift+D) shows capture activity live.

(() => {
  const MAX_REQUEST_BODY = 1 * 1024 * 1024;
  const MAX_CHUNK_TEXT = 256 * 1024;
  const MAX_CHUNKS_PER_EVENT = 500;
  const FLUSH_MS = 200;
  const MAX_QUEUE = 2000;

  // Note: the "Record fixtures" toggle is enforced in the worker (fixture
  // persistence only) — events must always flow, because live stamping and
  // attachment/blob evidence ride on the same pipe.
  const SIGILL_DEV = /-dev$/.test(chrome.runtime.getManifest().version_name ?? '');
  let queue = [];
  let flushTimer = null;
  let contextDead = false;

  function str(v, max) {
    return typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : null;
  }

  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string') return null;
    const captureId = str(raw.captureId, 64);
    switch (raw.kind) {
      case 'start':
        if (!captureId) return null;
        return {
          kind: 'start',
          captureId,
          platform: str(raw.platform, 16) ?? 'unknown',
          url: str(raw.url, 600) ?? '',
          method: str(raw.method, 10) ?? '',
          mode: raw.mode === 'meta' ? 'meta' : 'full',
          requestContentType: str(raw.requestContentType, 120),
          requestBody: str(raw.requestBody, MAX_REQUEST_BODY + 32),
        };
      case 'response':
        if (!captureId) return null;
        return {
          kind: 'response',
          captureId,
          status: Number.isInteger(raw.status) ? raw.status : null,
          responseContentType: str(raw.responseContentType, 120),
        };
      case 'chunks': {
        if (!captureId || !Array.isArray(raw.chunks)) return null;
        const chunks = [];
        for (const c of raw.chunks.slice(0, MAX_CHUNKS_PER_EVENT)) {
          const text = str(c?.text, MAX_CHUNK_TEXT);
          if (text == null) continue;
          chunks.push({ t: Number.isFinite(c.t) ? Math.round(c.t) : 0, text });
        }
        return chunks.length ? { kind: 'chunks', captureId, chunks } : null;
      }
      case 'end':
        if (!captureId) return null;
        return {
          kind: 'end',
          captureId,
          t: Number.isFinite(raw.t) ? Math.round(raw.t) : null,
          bytes: Number.isFinite(raw.bytes) ? raw.bytes : 0,
          chunkCount: Number.isFinite(raw.chunkCount) ? raw.chunkCount : 0,
          truncated: raw.truncated === true,
          metadataOnly: raw.metadataOnly === true,
          error: str(raw.error, 300),
          note: str(raw.note, 300),
        };
      case 'ws':
      case 'es':
        return { kind: raw.kind, url: str(raw.url, 300) ?? '' };
      case 'blob': {
        const sha = str(raw.sha256, 64);
        if (!/^[0-9a-f]{64}$/.test(sha ?? '')) return null;
        return {
          kind: 'blob',
          url: str(raw.url, 500) ?? '',
          sizeBytes: Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : 0,
          mediaType: str(raw.mediaType, 120),
          sha256: sha,
        };
      }
      default:
        return null;
    }
  }

  function overlayEntry(ev) {
    if (!SIGILL_DEV) {
      if (ev.kind === 'end') startsById.delete(ev.captureId);
      return;
    }
    const ts = new Date().toISOString();
    const platform = platformOf(ev);
    try {
      switch (ev.kind) {
        case 'start':
          document.dispatchEvent(new CustomEvent('sigill:debug', {
            detail: { type: 'net_start', platform, ts, method: ev.method, url: pathOf(ev.url), mode: ev.mode },
          }));
          break;
        case 'end':
          document.dispatchEvent(new CustomEvent('sigill:debug', {
            detail: {
              type: 'net_end', platform, ts,
              url: pathOf(startsById.get(ev.captureId) ?? ''),
              bytes: ev.bytes, chunkCount: ev.chunkCount,
              truncated: ev.truncated, error: ev.error ?? null,
            },
          }));
          startsById.delete(ev.captureId);
          break;
        case 'ws':
        case 'es':
          document.dispatchEvent(new CustomEvent('sigill:debug', {
            detail: { type: 'net_transport', platform, ts, transport: ev.kind, url: pathOf(ev.url) },
          }));
          break;
        case 'blob':
          document.dispatchEvent(new CustomEvent('sigill:debug', {
            detail: { type: 'net_blob', platform, ts, sizeBytes: ev.sizeBytes, mediaType: ev.mediaType },
          }));
          break;
      }
    } catch { /* overlay is best-effort */ }
  }

  const startsById = new Map(); // captureId -> url, so net_end rows show the path
  const PLATFORM_BY_HOST = [
    ['claude.ai', 'claude'],
    ['chatgpt.com', 'chatgpt'],
    ['gemini.google.com', 'gemini'],
  ];

  function platformOf(ev) {
    if (ev.platform) return ev.platform;
    const hit = PLATFORM_BY_HOST.find(([host]) => location.host === host || location.host.endsWith('.' + host));
    return hit?.[1] ?? location.host;
  }

  function pathOf(url) {
    try { return new URL(url).pathname.slice(0, 120); } catch { return String(url).slice(0, 120); }
  }

  function enqueue(ev) {
    if (ev.kind === 'start') startsById.set(ev.captureId, ev.url);
    overlayEntry(ev);
    if (contextDead) return;
    queue.push(ev);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    flushTimer = null;
    if (!queue.length || contextDead) return;
    const events = queue;
    queue = [];
    try {
      chrome.runtime.sendMessage({ type: 'NET_EVENTS', events }).catch(err => {
        if (String(err?.message ?? err).includes('Extension context invalidated')) contextDead = true;
      });
    } catch {
      // Extension reloaded while the page is still open — stop forwarding.
      contextDead = true;
    }
  }

  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin) return;
    const data = e.data;
    if (!data || data.source !== 'sigill-interceptor') return;
    if (data.type === 'hello') {
      announce();
      return;
    }
    if (!Array.isArray(data.events)) return;
    for (const raw of data.events) {
      const ev = sanitize(raw);
      if (ev) enqueue(ev);
    }
  });

  function announce() {
    window.postMessage({ source: 'sigill-relay', type: 'ready' }, location.origin);
  }
  announce();

  // --- attachment observation (hash-first) ----------------------------------
  // Files the user attaches (file picker, drag-drop, paste) are hashed HERE,
  // locally — only { name, size, type, sha256 } reaches the worker, never the
  // bytes. The worker associates them with the next completion turn on this
  // tab and records them as envelope `inputs`.

  const MAX_HASH_BYTES = 128 * 1024 * 1024;

  async function reportFiles(fileList, source) {
    for (const file of fileList) {
      if (typeof File !== 'undefined' && !(file instanceof File)) continue;
      const observed = {
        name: String(file.name ?? 'unnamed').slice(0, 300),
        sizeBytes: file.size ?? 0,
        mediaType: file.type || 'application/octet-stream',
        sha256: null,
        note: null,
        source,
        observedAt: new Date().toISOString(),
      };
      if (file.size > MAX_HASH_BYTES) {
        observed.note = `too large to hash (${file.size} bytes)`;
      } else {
        try {
          const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
          observed.sha256 = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (err) {
          observed.note = `hash failed: ${String(err?.message ?? err).slice(0, 120)}`;
        }
      }
      try {
        chrome.runtime.sendMessage({ type: 'FILE_OBSERVED', file: observed }).catch(() => {});
      } catch { /* extension reloaded */ }
      if (SIGILL_DEV) {
        document.dispatchEvent(new CustomEvent('sigill:debug', {
          detail: {
            type: 'file_observed',
            platform: platformOf({}),
            ts: observed.observedAt,
            name: observed.name,
            sizeBytes: observed.sizeBytes,
            source,
            hashed: Boolean(observed.sha256),
          },
        }));
      }
    }
  }

  document.addEventListener('change', e => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === 'file' && t.files?.length) {
      reportFiles([...t.files], 'file-input');
    }
  }, true);
  document.addEventListener('drop', e => {
    const files = e.dataTransfer?.files;
    if (files?.length) reportFiles([...files], 'drop');
  }, true);
  document.addEventListener('paste', e => {
    const files = e.clipboardData?.files;
    if (files?.length) reportFiles([...files], 'paste');
  }, true);
})();
