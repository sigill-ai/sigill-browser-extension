// Sigill content script — badge display for network-stamped turns.
//
// Evidence capture and stamping happen entirely in the network layer
// (content/interceptor.js → content/relay.js → background/worker.js). This
// script only decorates the page: it places a badge when the worker reports a
// stamped turn, and restores badges on reload where the platform exposes
// message IDs in the DOM. A missing badge never affects the evidence.

// Dev builds carry version_name "x.y.z-dev"; the public zip has it stripped.
const SIGILL_DEV = /-dev$/.test(chrome.runtime.getManifest().version_name ?? '');

function sigillDebugLog(entry) {
  if (!SIGILL_DEV) return;
  chrome.runtime.sendMessage({ type: 'DEBUG_ENTRY', entry }).catch(() => {});
  document.dispatchEvent(new CustomEvent('sigill:debug', { detail: entry }));
}

const SIGILL_PLATFORM = (() => {
  const host = location.host;
  for (const [h, platform] of [
    ['claude.ai', 'claude'],
    ['chatgpt.com', 'chatgpt'],
    ['gemini.google.com', 'gemini'],
  ]) {
    if (host === h || host.endsWith('.' + h)) return platform;
  }
  return null;
})();

function sigillConversationId() {
  if (SIGILL_PLATFORM === 'chatgpt') {
    return location.pathname.match(/\/c\/([^/?]+)/)?.[1] ?? null;
  }
  return location.pathname.split('/').filter(Boolean).at(-1) ?? null;
}

// --- badge placement ---------------------------------------------------------
// Platforms re-render messages after streaming completes (Claude's React swap
// wipes anything injected mid-stream), so placement is CONVERGENT, not
// one-shot: stamped evidence lands in a target registry, and an ensure-loop
// (re-)injects whenever the platform removes a badge.
//
// Element resolution per target, strongest first:
//   message-id — [data-message-id] / [data-chatgpt-selection-message-id]
//                lookup (ChatGPT exposes message uuids)
//   index      — nth assistant element; indices come from the worker, which
//                maps the platform's own history response onto the ledger
//                (BADGE_POSITIONS — Claude)
//   latest     — last assistant element, only within 30s of stamping (live
//                fallback for Claude/Gemini; the resolved element is then
//                pinned so later turns can't steal the badge)

const SIGILL_ASSISTANT_SELECTORS = {
  claude: ['[data-is-streaming]', '[data-testid="assistant-turn"]', '[data-testid="assistant-message"]', '.font-claude-message'],
  // October 2026 markup first; the role attribute is the earlier one
  chatgpt: ['[data-chatgpt-selection-message-id]:has([data-markdown-text-style="assistant-message"])', '[data-message-author-role="assistant"]'],
  gemini: ['model-response'],
};

const sigillBadgeTargets = new Map(); // evidenceId -> { evidence, mode, index?, el?, bornAt }

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'NETWORK_TURN_STAMPED') {
    sigillDebugLog({
      type: 'badge_notify',
      platform: msg.platform,
      ts: new Date().toISOString(),
      messageId: msg.messageId,
      evidenceId: msg.evidenceId,
    });
    sigillBadgeConversation = sigillConversationId(); // sync before ensure — a stale marker would wipe this target
    sigillBadgeTargets.set(msg.evidenceId, { evidence: msg, mode: 'latest', el: null, bornAt: Date.now() });
    sigillEnsureBadges();
  } else if (msg?.type === 'BADGE_POSITIONS') {
    sigillDebugLog({
      type: 'badge_positions',
      platform: msg.platform,
      ts: new Date().toISOString(),
      count: msg.turns?.length ?? 0,
      conversationId: msg.conversationId,
    });
    sigillBadgeConversation = sigillConversationId();
    for (const t of msg.turns ?? []) {
      sigillBadgeTargets.set(t.evidenceId, { evidence: t, mode: 'index', index: t.index, el: null, bornAt: Date.now() });
    }
    sigillEnsureBadges();
  }
});

function sigillAssistantElements() {
  for (const sel of SIGILL_ASSISTANT_SELECTORS[SIGILL_PLATFORM] ?? []) {
    try {
      const els = [...document.querySelectorAll(sel)];
      if (els.length) return els;
    } catch { /* bad selector — display only */ }
  }
  return [];
}

let sigillBadgeConversation = null;

function sigillEnsureBadges() {
  const conversationId = sigillConversationId();
  if (conversationId !== sigillBadgeConversation) {
    // SPA navigation — stale targets must not decorate another conversation
    sigillBadgeConversation = conversationId;
    sigillBadgeTargets.clear();
    return;
  }
  if (!sigillBadgeTargets.size) return;

  const els = sigillAssistantElements();
  for (const target of sigillBadgeTargets.values()) {
    let el = target.el?.isConnected ? target.el : null;
    if (!el && target.evidence.messageId) {
      try {
        const id = CSS.escape(target.evidence.messageId);
        el = document.querySelector(`[data-message-id="${id}"], [data-chatgpt-selection-message-id="${id}"]`);
      } catch { /* invalid id chars */ }
    }
    if (!el && target.mode === 'index') el = els[target.index] ?? null;
    if (!el && target.mode === 'latest' && Date.now() - target.bornAt < 30000) el = els.at(-1) ?? null;
    if (!el) continue;
    target.el = el; // pin: re-renders re-inject here, later turns can't steal it
    sigillInjectBadge(el, target.evidence);
  }
}

setInterval(sigillEnsureBadges, 2000);

// Restore on load where the DOM carries message ids (ChatGPT). Claude restore
// arrives as BADGE_POSITIONS when the platform's own history request is
// captured; Gemini has no restore path (live badges only).

async function sigillLoadStampedTurns() {
  const conversationId = sigillConversationId();
  if (!SIGILL_PLATFORM || !conversationId) return;
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'GET_STAMPED_TURNS',
      platform: SIGILL_PLATFORM,
      conversationId,
    });
  } catch { return; }
  sigillBadgeConversation = conversationId;
  for (const turn of res?.turns ?? []) {
    if (!turn.messageId || sigillBadgeTargets.has(turn.evidenceId)) continue;
    sigillBadgeTargets.set(turn.evidenceId, { evidence: turn, mode: 'message-id', el: null, bornAt: Date.now() });
  }
  sigillEnsureBadges();
}

setTimeout(sigillLoadStampedTurns, 1500);
let sigillLastLoadedConversation = null;
setInterval(() => {
  const conversationId = sigillConversationId();
  if (conversationId && conversationId !== sigillLastLoadedConversation) {
    sigillLastLoadedConversation = conversationId;
    sigillLoadStampedTurns();
  }
}, 2500);

// --- badge + tooltip rendering ----------------------------------------------

let sigillTooltip = null;

function sigillGetTooltip() {
  if (!sigillTooltip) {
    sigillTooltip = document.createElement('div');
    sigillTooltip.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'background:#1e1b4b',
      'color:#e0e7ff',
      'border:1px solid #4338ca',
      'border-radius:8px',
      'padding:10px 13px',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'pointer-events:none',
      'white-space:nowrap',
      'box-shadow:0 4px 20px rgba(0,0,0,0.4)',
      'display:none',
    ].join(';');
    document.body.appendChild(sigillTooltip);
  }
  return sigillTooltip;
}

// Where the badge sits inside an answer element. Gemini's <model-response> spans
// the whole pane while the text column is narrower: anchor to the column's
// action row instead, so the badge lines up with the answer.
function sigillBadgeHost(el) {
  if (SIGILL_PLATFORM === 'gemini') {
    return el.querySelector('.response-container-footer') ?? el.querySelector('.response-footer') ?? el;
  }
  return el;
}

function sigillInjectBadge(el, evidence) {
  // Idempotent by live DOM state, not by flag — the platform may re-render
  // and strip the wrapper while the element (and any dataset) survives.
  if (el.querySelector('.sigill-stamp-host')) return;

  const a = document.createElement('a');
  a.href = 'https://sigill.ai/evidence';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = 'Timestamped by Sigill';
  a.className = 'sigill-stamp';
  a.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'gap:5px',
    'height:26px',
    'padding:0 9px',
    'border:1px solid rgba(99,102,241,0.45)',
    'border-radius:999px',
    'background:rgba(99,102,241,0.12)',
    'color:#c7d2fe',
    'font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'text-decoration:none',
    'transition:background 0.15s,border-color 0.15s,color 0.15s,box-shadow 0.15s',
    'box-shadow:0 0 0 1px rgba(255,255,255,0.04) inset',
    'opacity:0.78',
    'flex-shrink:0',
  ].join(';');
  a.addEventListener('mouseenter', e => {
    a.style.opacity = '1';
    a.style.background = 'rgba(99,102,241,0.2)';
    a.style.borderColor = 'rgba(129,140,248,0.8)';
    a.style.color = '#eef2ff';
    a.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.08) inset,0 4px 14px rgba(79,70,229,0.18)';
    if (evidence?.evidenceId) {
      const tip = sigillGetTooltip();
      const genTime = evidence.genTime ? new Date(evidence.genTime).toLocaleString() : '—';
      const id = evidence.evidenceId.slice(0, 8);
      const tsa = evidence.tsaName || '—';
      tip.replaceChildren();
      const title = document.createElement('div');
      title.textContent = 'Sigill Evidence';
      title.style.cssText = 'color:#a5b4fc;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px';
      tip.appendChild(title);
      for (const [key, value] of [['ID:', `${id}...`], ['Stamped:', genTime], ['TSA:', tsa]]) {
        const row = document.createElement('div');
        const label = document.createElement('span');
        label.textContent = key;
        label.style.color = '#94a3b8';
        row.append(label, ' ', value);
        tip.appendChild(row);
      }
      tip.style.display = 'block';
      const rect = a.getBoundingClientRect();
      tip.style.left = Math.min(rect.left, window.innerWidth - 220) + 'px';
      tip.style.top = (rect.bottom + 6) + 'px';
    }
  });
  a.addEventListener('mouseleave', () => {
    a.style.opacity = '0.78';
    a.style.background = 'rgba(99,102,241,0.12)';
    a.style.borderColor = 'rgba(99,102,241,0.45)';
    a.style.color = '#c7d2fe';
    a.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.04) inset';
    const tip = sigillGetTooltip();
    tip.style.display = 'none';
  });
  a.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2.75L4.75 6.25v5.2c0 5.05 3.18 9.27 7.25 10.55 4.07-1.28 7.25-5.5 7.25-10.55v-5.2L12 2.75z" fill="#4f46e5" stroke="#a5b4fc" stroke-width="1.4"/>
    <path d="M8.8 12.1l2.15 2.15 4.45-4.65" stroke="white" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round"/>
  </svg><span>Sigill</span>`;

  const host = sigillBadgeHost(el);
  const hostStyle = getComputedStyle(host);
  if (hostStyle.position === 'static') host.style.position = 'relative';

  const wrapper = document.createElement('div');
  wrapper.className = 'sigill-stamp-host';
  wrapper.style.cssText = [
    'position:absolute',
    'right:10px',
    'bottom:10px',
    'z-index:3',
    'display:flex',
    'pointer-events:none',
  ].join(';');
  a.style.pointerEvents = 'auto';
  wrapper.appendChild(a);
  host.appendChild(wrapper);

  if (host.getBoundingClientRect().width < 520) {
    wrapper.style.right = '6px';
    wrapper.style.bottom = '6px';
    a.style.height = '24px';
    a.style.padding = '0 7px';
  }
}
