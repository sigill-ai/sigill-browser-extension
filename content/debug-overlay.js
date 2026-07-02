(() => {
  // Development tool — only active in dev builds (version_name "x.y.z-dev";
  // the public zip has it stripped and gets no overlay, no listeners).
  if (!/-dev$/.test(chrome.runtime.getManifest().version_name ?? '')) return;

  const MAX = 200;
  const log = [];
  let visible = false;
  let platformFilter = 'all';
  let panel = null;

  const COLORS = {
    scan:             '#60a5fa',
    not_eligible:     '#475569',
    timer_skip:       '#f87171',
    stamping:         '#fb923c',
    stamp_ok:         '#4ade80',
    stamp_skip:       '#fbbf24',
    stamp_err:        '#f87171',
    isComplete_true:  '#4ade80',
    isComplete_false: '#f87171',
    net_start:        '#38bdf8',
    net_end_ok:       '#4ade80',
    net_end_err:      '#f87171',
    net_transport:    '#e879f9',
    file_observed:    '#fbbf24',
    net_blob:         '#2dd4bf',
    artifact:         '#34d399',
    default:          '#94a3b8',
  };

  function entryColor(e) {
    if (e.type === 'scan')         return COLORS.scan;
    if (e.type === 'not_eligible') return COLORS.not_eligible;
    if (e.type === 'timer_skip')   return COLORS.timer_skip;
    if (e.type === 'stamping')     return COLORS.stamping;
    if (e.type === 'stamp_result') return e.ok ? COLORS.stamp_ok : e.skipped ? COLORS.stamp_skip : COLORS.stamp_err;
    if (e.type === 'isComplete')   return e.result ? COLORS.isComplete_true : COLORS.isComplete_false;
    if (e.type === 'net_start')    return COLORS.net_start;
    if (e.type === 'net_end')      return e.error ? COLORS.net_end_err : COLORS.net_end_ok;
    if (e.type === 'net_transport') return COLORS.net_transport;
    if (e.type === 'file_observed') return COLORS.file_observed;
    if (e.type === 'net_blob') return COLORS.net_blob;
    if (e.type === 'artifact_link' || e.type === 'artifact_stamped') return COLORS.artifact;
    return COLORS.default;
  }

  function entrySummary(e) {
    const pp = s => `"${(s ?? '').slice(0, 40)}"`;
    switch (e.type) {
      case 'scan':
        return `armed:${e.armed ? 'T' : 'F'}  users:${e.userCount}  asst:${e.assistantCount}  pairs:${e.pairCount}  conv:${(e.conversationId ?? '').slice(-8)}`;
      case 'not_eligible':
        return `${e.reason}  sub:${e.wasSubmitted}  arm:${e.appearedAfterArm}  rec:${e.recentSubmit}  ${pp(e.promptPreview)}`;
      case 'timer_skip':
        return `${e.reason}  ${pp(e.promptPreview)}`;
      case 'stamping':
        return `len:${e.outputLength}  ${pp(e.promptPreview)}`;
      case 'stamp_result':
        return e.ok
          ? `ok  id:${(e.evidenceId ?? '').slice(0, 8)}`
          : e.skipped
            ? 'skipped (no key or disabled)'
            : `error: ${e.error ?? '?'}`;
      case 'isComplete': {
        const ok = e.result ? '✓' : '✗';
        if (e.platform === 'claude')   return `${ok}  streaming:${e.dataIsStreaming}  len:${e.outputLength}  statusOnly:${e.isStatusOnly}`;
        if (e.platform === 'chatgpt')  return `${ok}  generating:${e.isGenerating}`;
        if (e.platform === 'gemini')   return `${ok}  reason:${e.reason}  rawLen:${(e.raw ?? '').length}`;
        return ok;
      }
      case 'net_start':
        return `${e.method ?? ''} ${e.url ?? ''}${e.mode === 'meta' ? '  (meta)' : ''}`;
      case 'net_end':
        return e.error
          ? `error: ${e.error}  ${e.url ?? ''}`
          : `chunks:${e.chunkCount ?? 0}  ${e.bytes ?? 0}b${e.truncated ? '  TRUNCATED' : ''}  ${e.url ?? ''}`;
      case 'net_transport':
        return `${e.transport ?? '?'} opened  ${e.url ?? ''}`;
      case 'file_observed':
        return `${e.source ?? '?'}  ${e.hashed ? 'sha256 ok' : 'NOT HASHED'}  ${e.sizeBytes ?? 0}b  "${(e.name ?? '').slice(0, 40)}"`;
      case 'net_blob':
        return `blob hashed  ${e.sizeBytes ?? 0}b  ${e.mediaType ?? ''}`;
      case 'artifact_link':
        return `${basenameish(e.sandboxPath)}  msg:${(e.messageId ?? '').slice(0, 8)}`;
      case 'artifact_stamped':
        return e.ok
          ? `${e.hashed ? 'sha256 ok' : 'metadata only'}  "${e.filename ?? ''}"  parent:${(e.parentEvidenceId ?? 'none').slice(0, 8)}`
          : `error: ${e.error ?? '?'}`;
      default:
        return '';
    }
  }

  function basenameish(p) {
    return String(p ?? '').split(/[\\/]/).pop();
  }

  function fmtTime(ts) {
    if (!ts) return '?';
    try {
      const d = new Date(ts);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      return `${hh}:${mm}:${ss}.${ms}`;
    } catch { return '?'; }
  }

  function makeRow(entry) {
    const row = document.createElement('div');
    row.style.cssText = [
      'display:grid',
      'grid-template-columns:78px 90px 52px 1fr',
      'gap:4px',
      'align-items:baseline',
      'padding:2px 8px',
      'cursor:pointer',
      'border-radius:2px',
    ].join(';');

    const time = document.createElement('span');
    time.textContent = fmtTime(entry.ts);
    time.style.cssText = 'color:#475569;font-size:9px;font-variant-numeric:tabular-nums;';

    const type = document.createElement('span');
    type.textContent = entry.type ?? '?';
    type.style.cssText = `color:${entryColor(entry)};font-size:9px;font-weight:700;`;

    const plat = document.createElement('span');
    plat.textContent = entry.platform ?? '';
    plat.style.cssText = 'color:#818cf8;font-size:9px;';

    const summary = document.createElement('span');
    summary.textContent = entrySummary(entry);
    summary.style.cssText = 'color:#94a3b8;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    row.append(time, type, plat, summary);

    let detailEl = null;
    row.addEventListener('click', () => {
      if (detailEl) { detailEl.remove(); detailEl = null; return; }
      detailEl = document.createElement('pre');
      detailEl.style.cssText = [
        'margin:2px 0 3px 0',
        'padding:5px 8px',
        'background:#020617',
        'border-radius:4px',
        'color:#94a3b8',
        'font-size:9px',
        'overflow:auto',
        'max-height:160px',
        'white-space:pre-wrap',
        'word-break:break-all',
        'grid-column:1/-1',
      ].join(';');
      detailEl.textContent = JSON.stringify(entry, null, 2);
      row.after(detailEl);
    });
    row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.03)'; });
    row.addEventListener('mouseleave', () => { row.style.background = ''; });

    return row;
  }

  function buildPanel() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      'bottom:14px',
      'right:14px',
      'width:560px',
      'max-height:460px',
      'background:#0c1321',
      'border:1px solid #1e293b',
      'border-radius:10px',
      'box-shadow:0 12px 40px rgba(0,0,0,0.7)',
      'z-index:2147483646',
      'display:flex',
      'flex-direction:column',
      'font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace',
      'overflow:hidden',
      'user-select:none',
    ].join(';');

    // Header (draggable)
    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;gap:5px;padding:6px 10px;background:#111827;border-bottom:1px solid #1e293b;flex-shrink:0;cursor:grab;';

    let dragging = false, ox = 0, oy = 0, startRight = 0, startBottom = 0;
    hdr.addEventListener('mousedown', ev => {
      if (ev.target.tagName === 'BUTTON') return;
      dragging = true;
      ox = ev.clientX; oy = ev.clientY;
      const rect = el.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
      hdr.style.cursor = 'grabbing';
      ev.preventDefault();
    });
    document.addEventListener('mousemove', ev => {
      if (!dragging) return;
      el.style.right  = Math.max(0, startRight  - (ev.clientX - ox)) + 'px';
      el.style.bottom = Math.max(0, startBottom - (ev.clientY - oy)) + 'px';
    });
    document.addEventListener('mouseup', () => { if (dragging) { dragging = false; hdr.style.cursor = 'grab'; } });

    const title = document.createElement('span');
    title.textContent = 'Sigill Debug';
    title.style.cssText = 'color:#e2e8f0;font-size:11px;font-weight:700;flex:1;';
    hdr.appendChild(title);

    for (const p of ['all', 'claude', 'chatgpt', 'gemini']) {
      const btn = document.createElement('button');
      btn.textContent = p;
      btn.dataset.pf = p;
      const active = p === platformFilter;
      btn.style.cssText = [
        'padding:2px 7px',
        'border-radius:4px',
        `border:1px solid ${active ? '#4f46e5' : '#1e293b'}`,
        `background:${active ? '#312e81' : 'transparent'}`,
        `color:${active ? '#c7d2fe' : '#64748b'}`,
        'font-size:9px',
        'cursor:pointer',
        'font-family:inherit',
      ].join(';');
      btn.addEventListener('click', () => {
        platformFilter = p;
        hdr.querySelectorAll('[data-pf]').forEach(b => {
          const a = b.dataset.pf === p;
          b.style.background   = a ? '#312e81' : 'transparent';
          b.style.color        = a ? '#c7d2fe' : '#64748b';
          b.style.borderColor  = a ? '#4f46e5' : '#1e293b';
        });
        rebuild();
      });
      hdr.appendChild(btn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'padding:1px 6px;border-radius:4px;border:1px solid #1e293b;background:transparent;color:#64748b;font-size:14px;cursor:pointer;line-height:1;font-family:inherit;margin-left:2px;';
    closeBtn.addEventListener('click', hide);
    hdr.appendChild(closeBtn);
    el.appendChild(hdr);

    // Column header
    const cols = document.createElement('div');
    cols.style.cssText = 'display:grid;grid-template-columns:78px 90px 52px 1fr;gap:4px;padding:3px 8px 2px;border-bottom:1px solid #0f172a;flex-shrink:0;';
    for (const label of ['time', 'type', 'platform', 'detail']) {
      const c = document.createElement('span');
      c.textContent = label;
      c.style.cssText = 'color:#334155;font-size:8px;text-transform:uppercase;letter-spacing:.5px;';
      cols.appendChild(c);
    }
    el.appendChild(cols);

    // Log list
    const list = document.createElement('div');
    list.style.cssText = 'flex:1;overflow-y:auto;min-height:0;padding:3px 0;';
    el.appendChild(list);

    // Footer
    const ftr = document.createElement('div');
    ftr.style.cssText = 'display:flex;align-items:center;padding:5px 10px;border-top:1px solid #1e293b;flex-shrink:0;gap:8px;';

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    clearBtn.style.cssText = 'padding:2px 8px;border-radius:4px;border:1px solid #1e293b;background:transparent;color:#64748b;font-size:9px;cursor:pointer;font-family:inherit;';
    clearBtn.addEventListener('click', () => {
      log.length = 0;
      list.innerHTML = '';
      updateCount(list, countEl);
      chrome.runtime.sendMessage({ type: 'CLEAR_DEBUG_LOG' }).catch(() => {});
    });
    ftr.appendChild(clearBtn);

    const countEl = document.createElement('span');
    countEl.style.cssText = 'color:#334155;font-size:9px;';
    ftr.appendChild(countEl);

    const hint = document.createElement('span');
    hint.textContent = 'Alt+Shift+D · click row for JSON · drag header';
    hint.style.cssText = 'color:#1e293b;font-size:9px;margin-left:auto;';
    ftr.appendChild(hint);

    el.appendChild(ftr);
    document.body.appendChild(el);
    return { el, list, countEl };
  }

  function updateCount(list, countEl) {
    if (!countEl) return;
    const shown = list.children.length;
    countEl.textContent = `${shown} / ${log.length}`;
  }

  function rebuild() {
    if (!panel) return;
    panel.list.innerHTML = '';
    const filtered = platformFilter === 'all' ? log : log.filter(e => e.platform === platformFilter);
    [...filtered].reverse().forEach(e => panel.list.appendChild(makeRow(e)));
    updateCount(panel.list, panel.countEl);
  }

  function push(entry) {
    log.push(entry);
    if (log.length > MAX) log.shift();

    if (!panel || !visible) return;
    if (platformFilter !== 'all' && entry.platform !== platformFilter) return;

    const row = makeRow(entry);
    panel.list.insertBefore(row, panel.list.firstChild);
    while (panel.list.children.length > MAX) panel.list.removeChild(panel.list.lastChild);
    updateCount(panel.list, panel.countEl);
  }

  function show() {
    if (!panel) { panel = buildPanel(); rebuild(); }
    panel.el.style.display = 'flex';
    visible = true;
  }

  function hide() {
    if (panel) panel.el.style.display = 'none';
    visible = false;
  }

  function toggle() { visible ? hide() : show(); }

  // Receive real-time debug events dispatched by sigillDebugLog in shared.js
  document.addEventListener('sigill:debug', e => push(e.detail));

  // Hydrate with entries already captured before the overlay loaded
  chrome.runtime.sendMessage({ type: 'GET_DEBUG_LOG' })
    .then(res => { (res?.log ?? []).forEach(e => { if (log.length < MAX) log.push(e); }); })
    .catch(() => {});

  // Alt+Shift+D toggles the panel
  document.addEventListener('keydown', e => {
    if (e.altKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      toggle();
    }
  }, true);
})();
