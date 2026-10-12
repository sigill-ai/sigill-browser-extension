// Sigill network interceptor — runs in the page's MAIN world at document_start.
//
// Pure observer: wraps window.fetch and XMLHttpRequest to tee the platform's own
// API traffic (the SSE/chunked streams behind each chat turn). It never modifies
// a request or response — the page always receives the original object — and any
// failure inside our code must be invisible to the page.
//
// MAIN world has no chrome.* access, so events go to the ISOLATED-world relay
// (content/relay.js) via window.postMessage. The relay treats us as semi-trusted
// and re-validates everything.

(() => {
  if (window.__sigillNetTap) return;
  window.__sigillNetTap = true;

  const SOURCE = 'sigill-interceptor';
  const MAX_REQUEST_BODY = 1 * 1024 * 1024;   // 1 MB of request body text
  const MAX_STREAM_BYTES = 4 * 1024 * 1024;   // 4 MB of streamed text per capture
  const MAX_CHUNK_TEXT = 256 * 1024;          // cap a single recorded chunk
  const FLUSH_MS = 150;
  const BINARY_SLICE = 96 * 1024;             // bytes per base64 chunk (≈128 KB of text)

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // mode 'full' records request body + streamed response chunks;
  // mode 'meta' records only that the request happened (URL, method, status) —
  // used for noisy adjacent endpoints where we want discovery without the bulk.
  // Matchers test the pathname only: query strings like ?conversation_id=…
  // false-positive on substring tests (beacons/home, gizmos/sidebar).
  const MATCHERS = [
    {
      platform: 'claude',
      host: 'claude.ai',
      // Since October 2026 answers arrive on the long-lived Connect stream
      // ConversationService/StreamTimeline (binary protobuf, lib/claude-rpc.js);
      // the SSE /completion endpoints are kept for older deployments.
      full: p => p.includes('/chat_conversations') || /\/(completion|retry_completion)$/.test(p) ||
        /^\/claudeai-rpc\/[\w.]+\.ConversationService\/StreamTimeline$/.test(p),
    },
    {
      platform: 'chatgpt',
      host: 'chatgpt.com',
      // the completion POST (/f/conversation or /conversation) and the history
      // GET (/conversation/<uuid>); init, prepare, stream_status, textdocs,
      // autocompletions (draft keystrokes — deliberately not recorded) → meta
      // interpreter/download returns the signed URL for a generated file —
      // small JSON linking message_id + sandbox_path to the download.
      full: p => /^\/backend-(api|anon)\/(f\/)?conversation(\/[0-9a-f-]{8,})?$/.test(p) ||
        /\/interpreter\/download$/.test(p),
      meta: p => (p.startsWith('/backend-') && p.includes('conversation')) ||
        p.startsWith('/backend-api/files'),   // upload flow — discovery for outputArtifacts work
    },
    {
      platform: 'gemini',
      host: 'gemini.google.com',
      full: p => p.includes('StreamGenerate'),
      meta: p => p.includes('batchexecute'),
    },
  ];

  const matcher = MATCHERS.find(
    m => location.host === m.host || location.host.endsWith('.' + m.host)
  );
  if (!matcher) return;

  function matchMode(url) {
    let path;
    try {
      path = new URL(url).pathname;
    } catch {
      return null;
    }
    try {
      if (matcher.full?.(path)) return 'full';
      if (matcher.meta?.(path)) return 'meta';
    } catch { /* matcher regex failure — treat as no match */ }
    return null;
  }

  // --- transport to relay -------------------------------------------------

  let relayReady = false;
  const pendingBatches = [];
  let outbox = [];
  let flushTimer = null;
  let captureCounter = 0;
  const openCaptures = new Map(); // captureId -> { pendingChunks: [] }

  function emit(ev) {
    outbox.push(ev);
    if (outbox.length > 400) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    // Drain accumulated stream chunks into chunk events first, then ship.
    for (const [captureId, state] of openCaptures) {
      if (state.pendingChunks.length) {
        outbox.push({ kind: 'chunks', captureId, chunks: state.pendingChunks });
        state.pendingChunks = [];
      }
    }
    if (!outbox.length) return;
    const events = outbox;
    outbox = [];
    if (relayReady) {
      window.postMessage({ source: SOURCE, v: 1, events }, location.origin);
    } else {
      pendingBatches.push(events);
      if (pendingBatches.length > 50) pendingBatches.shift();
    }
  }

  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin) return;
    if (e.data?.source === 'sigill-relay' && e.data.type === 'ready' && !relayReady) {
      relayReady = true;
      for (const events of pendingBatches.splice(0)) {
        window.postMessage({ source: SOURCE, v: 1, events }, location.origin);
      }
    }
  });
  // In case the relay loaded first, ask it to announce itself.
  window.postMessage({ source: SOURCE, type: 'hello' }, location.origin);

  // --- capture lifecycle ---------------------------------------------------

  function newCapture(url, method, mode) {
    const captureId = `${Date.now().toString(36)}-${++captureCounter}-${Math.random().toString(36).slice(2, 8)}`;
    const state = {
      captureId,
      mode,
      startedAtMs: performance.now(),
      bytes: 0,
      chunkCount: 0,
      truncated: false,
      pendingChunks: [],
    };
    openCaptures.set(captureId, state);
    return { captureId, state, url, method };
  }

  function emitStart(cap, requestContentType, requestBody) {
    emit({
      kind: 'start',
      captureId: cap.captureId,
      platform: matcher.platform,
      url: cap.url,
      method: cap.method,
      mode: cap.state.mode,
      requestContentType: requestContentType ?? null,
      requestBody: requestBody ?? null,
    });
  }

  function emitResponse(cap, status, responseContentType) {
    emit({
      kind: 'response',
      captureId: cap.captureId,
      status,
      responseContentType: responseContentType ?? null,
    });
  }

  function addChunk(cap, text, enc) {
    const state = cap.state;
    if (!text || state.truncated) return;
    // Binary streams (base64) are long-lived and parsed incrementally by the
    // worker, which keeps no copy — they are not cut off at MAX_STREAM_BYTES.
    if (!enc && state.bytes + text.length > MAX_STREAM_BYTES) {
      state.truncated = true;
      text = text.slice(0, Math.max(0, MAX_STREAM_BYTES - state.bytes));
      if (!text) return;
    }
    state.bytes += text.length;
    state.chunkCount += 1;
    const chunk = {
      t: Math.round(performance.now() - state.startedAtMs),
      text: text.length > MAX_CHUNK_TEXT ? text.slice(0, MAX_CHUNK_TEXT) : text,
    };
    if (enc) chunk.enc = enc;
    state.pendingChunks.push(chunk);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function endCapture(cap, extra = {}) {
    const state = cap.state;
    if (!openCaptures.has(cap.captureId)) return;
    // Ship remaining chunks before the end event — otherwise anything that
    // completes within one flush window (every plain JSON response) reaches
    // the worker as end-then-chunks and the body is lost to a stranded stub.
    if (state.pendingChunks.length) {
      outbox.push({ kind: 'chunks', captureId: cap.captureId, chunks: state.pendingChunks });
      state.pendingChunks = [];
    }
    emit({
      kind: 'end',
      captureId: cap.captureId,
      t: Math.round(performance.now() - state.startedAtMs),
      bytes: state.bytes,
      chunkCount: state.chunkCount,
      truncated: state.truncated,
      ...extra,
    });
    flush();
    openCaptures.delete(cap.captureId);
  }

  // --- request body description --------------------------------------------

  async function describeBody(body) {
    try {
      if (body == null) return null;
      if (typeof body === 'string') return truncateBody(body);
      if (body instanceof URLSearchParams) return truncateBody(body.toString());
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        if (body.size > MAX_REQUEST_BODY) return `[blob ${body.size}B ${body.type || 'unknown'}]`;
        return truncateBody(await body.text());
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        const buf = body instanceof ArrayBuffer ? body : body.buffer;
        if (buf.byteLength > MAX_REQUEST_BODY) return `[binary ${buf.byteLength}B]`;
        return truncateBody(new TextDecoder().decode(buf));
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const parts = [];
        for (const [key, value] of body.entries()) {
          if (typeof value === 'string') {
            parts.push(`${key}=${value.length > 2000 ? value.slice(0, 2000) + '…' : value}`);
          } else {
            parts.push(`${key}=[file ${value.name ?? ''} ${value.size ?? '?'}B ${value.type ?? ''}]`);
          }
        }
        return truncateBody('[formdata]\n' + parts.join('\n'));
      }
      return `[unrecognized body ${Object.prototype.toString.call(body)}]`;
    } catch (err) {
      return `[body read failed: ${String(err?.message ?? err)}]`;
    }
  }

  function truncateBody(text) {
    return text.length > MAX_REQUEST_BODY ? text.slice(0, MAX_REQUEST_BODY) + '…[truncated]' : text;
  }

  // --- fetch ----------------------------------------------------------------

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let cap = null;
    try {
      cap = beginFetchCapture(input, init);
    } catch { /* capture must never break the page */ }

    const result = origFetch.apply(this, arguments);
    if (!cap) return result;

    return result.then(
      resp => {
        try { observeFetchResponse(resp, cap); } catch { /* observer only */ }
        return resp;
      },
      err => {
        try { endCapture(cap, { error: String(err?.message ?? err) }); } catch {}
        throw err;
      }
    );
  };

  function beginFetchCapture(input, init) {
    let url;
    if (typeof input === 'string' || input instanceof URL) {
      url = new URL(String(input), location.href).href;
    } else if (input instanceof Request) {
      url = input.url;
    } else {
      return null;
    }
    const mode = matchMode(url);
    if (!mode) return null;

    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const cap = newCapture(url, method, mode);

    if (mode === 'meta' || method === 'GET' || method === 'HEAD') {
      emitStart(cap, requestContentTypeOf(input, init), null);
      return cap;
    }

    // Body extraction is async (Request.clone().text(), Blob.text()) but resolves
    // from memory almost immediately; the worker tolerates chunks arriving first.
    const contentType = requestContentTypeOf(input, init);
    const bodySource = init?.body != null
      ? describeBody(init.body)
      : input instanceof Request
        ? input.clone().text().then(truncateBody, err => `[body read failed: ${String(err?.message ?? err)}]`)
        : Promise.resolve(null);
    Promise.resolve(bodySource).then(
      body => emitStart(cap, contentType, body),
      () => emitStart(cap, contentType, null)
    );
    return cap;
  }

  function requestContentTypeOf(input, init) {
    try {
      if (init?.headers) {
        const h = new Headers(init.headers);
        if (h.has('content-type')) return h.get('content-type');
      }
      if (input instanceof Request) return input.headers.get('content-type');
    } catch {}
    return null;
  }

  function observeFetchResponse(resp, cap) {
    emitResponse(cap, resp.status, resp.headers.get('content-type'));

    if (cap.state.mode === 'meta' || !resp.body) {
      endCapture(cap, cap.state.mode === 'meta' ? { metadataOnly: true } : {});
      return;
    }

    // clone() so the page consumes the untouched original stream.
    const reader = resp.clone().body.getReader();
    const decoder = new TextDecoder('utf-8');
    const binary = /^application\/(connect\+)?proto/i.test(resp.headers.get('content-type') ?? '');
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (binary) {
            // base64 in slices small enough to pass the relay's per-chunk cap whole
            for (let i = 0; i < value.length; i += BINARY_SLICE) addChunk(cap, toBase64(value.subarray(i, i + BINARY_SLICE)), 'b64');
            continue;
          }
          addChunk(cap, decoder.decode(value, { stream: true }));
          if (cap.state.truncated) {
            reader.cancel().catch(() => {});
            break;
          }
        }
        addChunk(cap, decoder.decode());
        endCapture(cap);
      } catch (err) {
        endCapture(cap, { error: String(err?.message ?? err) });
      }
    })();
  }

  // --- XMLHttpRequest (Gemini streams via XHR) --------------------------------

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const abs = new URL(String(url), location.href).href;
      const mode = matchMode(abs);
      this.__sigillReq = mode ? { url: abs, method: String(method).toUpperCase(), mode } : null;
    } catch {
      this.__sigillReq = null;
    }
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const req = this.__sigillReq;
    if (req) {
      try { observeXhr(this, req, body); } catch { /* observer only */ }
    }
    return origSend.apply(this, arguments);
  };

  function observeXhr(xhr, req, body) {
    const cap = newCapture(req.url, req.method, req.mode);
    Promise.resolve(req.mode === 'full' ? describeBody(body) : null).then(
      text => emitStart(cap, null, text),
      () => emitStart(cap, null, null)
    );

    let responded = false;
    let lastLength = 0;
    let ended = false;

    function readDelta() {
      if (cap.state.mode !== 'full') return;
      // responseText throws unless responseType is '' or 'text'.
      if (xhr.responseType && xhr.responseType !== 'text') return;
      try {
        const text = xhr.responseText;
        if (text.length > lastLength) {
          addChunk(cap, text.slice(lastLength));
          lastLength = text.length;
        }
      } catch { /* not readable yet */ }
    }

    xhr.addEventListener('readystatechange', () => {
      if (!responded && xhr.readyState >= 2) {
        responded = true;
        let contentType = null;
        try { contentType = xhr.getResponseHeader('content-type'); } catch {}
        emitResponse(cap, xhr.status, contentType);
      }
      if (xhr.readyState >= 3) readDelta();
    });
    xhr.addEventListener('progress', readDelta);
    xhr.addEventListener('loadend', () => {
      if (ended) return;
      ended = true;
      readDelta();
      const extra = cap.state.mode === 'meta' ? { metadataOnly: true } : {};
      if (xhr.responseType && xhr.responseType !== 'text' && cap.state.mode === 'full') {
        extra.note = `responseType=${xhr.responseType} — body not text-readable`;
      }
      endCapture(cap, extra);
    });
    xhr.addEventListener('error', () => {
      if (ended) return;
      ended = true;
      endCapture(cap, { error: 'xhr network error' });
    });
    xhr.addEventListener('abort', () => {
      if (ended) return;
      ended = true;
      readDelta();
      endCapture(cap, { error: 'aborted' });
    });
  }

  // --- WebSocket / EventSource canaries ---------------------------------------
  // We don't record payloads — just the fact that the platform opened one, so the
  // fixtures reveal if chat traffic moves to a transport we aren't parsing.

  // Generated-file downloads: platforms often build the file client-side and
  // hand it to the browser via URL.createObjectURL(blob). Hashing the blob at
  // creation is the only moment the bytes are observable — the worker later
  // matches the blob URL against chrome.downloads events to stamp the
  // artifact. Pure observer: the original URL is returned untouched.
  const MAX_BLOB_HASH_BYTES = 128 * 1024 * 1024;
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL(obj);
    try {
      if (obj instanceof Blob && obj.size > 0 && obj.size <= MAX_BLOB_HASH_BYTES) {
        obj.arrayBuffer().then(async buf => {
          const digest = await crypto.subtle.digest('SHA-256', buf);
          const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
          emit({ kind: 'blob', url, sizeBytes: obj.size, mediaType: obj.type || null, sha256: hex });
          flush();
        }).catch(() => { /* blob unreadable — nothing to report */ });
      }
    } catch { /* observer only */ }
    return url;
  };

  if (window.WebSocket) {
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, argsList) {
        try { emit({ kind: 'ws', url: String(argsList[0]).slice(0, 300) }); } catch {}
        return Reflect.construct(target, argsList);
      },
    });
  }
  if (window.EventSource) {
    window.EventSource = new Proxy(window.EventSource, {
      construct(target, argsList) {
        try { emit({ kind: 'es', url: String(argsList[0]).slice(0, 300) }); } catch {}
        return Reflect.construct(target, argsList);
      },
    });
  }
})();
