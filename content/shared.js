// Stamps a complete conversation turn (prompt + output) as one AiEvidenceEnvelope.
// The badge is injected on the assistant element since that's where the turn completes.
async function sigillStampTurn(platform, conversationId, prompt, output) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'STAMP_TURN', platform, conversationId, prompt, output });
    if (res?.ok) console.log(`[Sigill] stamped ${platform} turn`, res.evidenceId);
    else if (res?.skipped) console.log('[Sigill] skipped — no API key or platform disabled');
    else if (res?.error) console.warn('[Sigill] stamp error:', res.error);
    return res;
  } catch {
    return null;
  }
}

async function sigillGetStampedTurns(platform, conversationId) {
  try {
    return await chrome.runtime.sendMessage({ type: 'GET_STAMPED_TURNS', platform, conversationId });
  } catch {
    return { turns: [] };
  }
}

function sigillText(el) {
  return el?.innerText?.trim() ?? '';
}

function sigillNormalizedText(el, normalizeText, getText = sigillText, role = null) {
  const extracted = getText(el, role);
  const text = role === 'user' && !extracted ? sigillText(el) : extracted;
  return normalizeText(text).trim();
}

function sigillDocumentOrder(a, b) {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
}

function sigillDefaultPairs(users, assistants, normalizeText = text => text, getText = sigillText) {
  const nodes = [
    ...users.map(el => ({ el, role: 'user' })),
    ...assistants.map(el => ({ el, role: 'assistant' })),
  ].sort((a, b) => sigillDocumentOrder(a.el, b.el));

  const pairs = [];
  let prompt = '';
  let userEl = null;
  let waitingForAssistant = false;
  for (const node of nodes) {
    const text = sigillNormalizedText(node.el, normalizeText, getText, node.role);
    if (!text) continue;
    if (node.role === 'user') {
      prompt = text;
      userEl = node.el;
      waitingForAssistant = true;
    } else if (prompt && waitingForAssistant && text) {
      pairs.push({ userEl, assistantEl: node.el, prompt, output: text, index: pairs.length });
      waitingForAssistant = false;
    }
  }
  return pairs;
}

function sigillObserveTurns({
  platform,
  conversationId,
  getUsers,
  getAssistants,
  makePairs = sigillDefaultPairs,
  getText = sigillText,
  normalizeText = text => text,
  isBusy = () => false,
  isComplete = () => true,
  assistantDelay = 2500,
  label = platform,
}) {
  const processedAssistants = new WeakSet();
  const processedTurnKeys = new Set();
  const userFirstSeenAt = new WeakMap();
  const pendingAssistantByTurnKey = new Map();
  const timers = new WeakMap();
  const pendingSignatures = new WeakMap();
  const stampedTurnCache = new Map();
  let lastScanLog = '';
  let currentConversationId = null;
  let armed = false;
  let armTimer = null;
  let armedAt = 0;
  let lastComposerActivityAt = 0;
  let lastSubmitAt = 0;
  let lastSubmitConversationId = null;
  let pendingPromptText = '';
  let lastNonEmptyComposerText = '';
  const submittedPrompts = new Map();

  function rememberSubmittedPrompt(text) {
    const prompt = normalizeText(text).trim();
    lastSubmitAt = Date.now();
    lastSubmitConversationId = currentConversationId ?? conversationId();
    if (prompt) {
      submittedPrompts.set(prompt, lastSubmitAt);
      pendingPromptText = prompt;
    }
  }

  function hasRecentSubmit() {
    return lastSubmitAt > 0 && Date.now() - lastSubmitAt < 120000;
  }

  function submitBelongsTo(convoId) {
    if (!hasRecentSubmit()) return false;
    return lastSubmitConversationId === convoId || lastSubmitConversationId === 'unknown';
  }

  function hasSubmittedPrompt(prompt) {
    const submittedAt = submittedPrompts.get(prompt);
    if (!submittedAt) return false;
    if (Date.now() - submittedAt > 10 * 60 * 1000) {
      submittedPrompts.delete(prompt);
      return false;
    }
    return true;
  }

  function consumeSubmittedPrompt(prompt) {
    submittedPrompts.delete(prompt);
    if (pendingPromptText === prompt) pendingPromptText = '';
  }

  function noteComposerActivity(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const editor = target.closest('textarea,input,[contenteditable="true"],[role="textbox"]');
    if (editor) {
      lastComposerActivityAt = Date.now();
      pendingPromptText = sigillText(editor);
      if (pendingPromptText) lastNonEmptyComposerText = pendingPromptText;
    }
  }

  document.addEventListener('input', noteComposerActivity, true);
  document.addEventListener('beforeinput', noteComposerActivity, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      noteComposerActivity(event);
      rememberSubmittedPrompt(pendingPromptText || lastNonEmptyComposerText);
    }
  }, true);

  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest('button,[role="button"]');
    if (!button) return;
    const labelText = `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`.toLowerCase();
    if (/\b(send|submit)\b/.test(labelText)) {
      rememberSubmittedPrompt(pendingPromptText || lastNonEmptyComposerText);
    }
  }, true);

  function turnKeyFor(convoId, pair) {
    return `${convoId}\n\0\n${pair.index ?? 0}\n\0\n${pair.prompt}`;
  }

  function contentKeyFor(prompt, output) {
    return `${prompt}\n\0\n${output}`;
  }

  async function loadStampedTurns(convoId) {
    const res = await sigillGetStampedTurns(platform, convoId);
    const turns = new Map();
    for (const turn of res?.turns ?? []) {
      turns.set(contentKeyFor(turn.prompt, turn.output ?? ''), turn);
    }
    stampedTurnCache.set(convoId, turns);
    return turns;
  }

  function restoreBadge(pair, convoId) {
    const turns = stampedTurnCache.get(convoId);
    if (!turns) return false;
    const output = pair.output || sigillNormalizedText(pair.assistantEl, normalizeText, getText, 'assistant');
    const existing = turns.get(contentKeyFor(pair.prompt, output));
    if (!existing) return false;
    processedAssistants.add(pair.assistantEl);
    sigillInjectBadge(pair.assistantEl, existing);
    return true;
  }

  function markExisting(pairs, convoId) {
    for (const pair of pairs) {
      if (hasSubmittedPrompt(pair.prompt)) continue;
      restoreBadge(pair, convoId);
      processedAssistants.add(pair.assistantEl);
    }
  }

  function restoreExistingBadges(pairs, convoId) {
    pairs.forEach(pair => restoreBadge(pair, convoId));
  }

  function schedule(pair) {
    const { userEl, assistantEl, prompt } = pair;
    if (processedAssistants.has(assistantEl)) return;
    const wasSubmitted = hasSubmittedPrompt(prompt);
    const firstSeenAt = userEl ? userFirstSeenAt.get(userEl) : 0;
    const appearedAfterArm = firstSeenAt && firstSeenAt >= armedAt;
    const recentSubmit = submitBelongsTo(conversationId());
    if (!userEl || (!wasSubmitted && !appearedAfterArm && !recentSubmit)) return;
    if (isBusy() || !isComplete(pair)) {
      clearTimeout(timers.get(assistantEl));
      return;
    }

    const output = sigillNormalizedText(assistantEl, normalizeText, getText, 'assistant');
    if (!prompt || !output) return;

    const turnKey = turnKeyFor(conversationId(), pair);
    if (processedTurnKeys.has(turnKey)) return;

    const previousAssistantEl = pendingAssistantByTurnKey.get(turnKey);
    if (previousAssistantEl && previousAssistantEl !== assistantEl) {
      clearTimeout(timers.get(previousAssistantEl));
      timers.delete(previousAssistantEl);
      pendingSignatures.delete(previousAssistantEl);
    }
    pendingAssistantByTurnKey.set(turnKey, assistantEl);

    const signature = `${turnKey}\n\0\n${output}`;
    if (pendingSignatures.get(assistantEl) === signature && timers.has(assistantEl)) return;
    pendingSignatures.set(assistantEl, signature);

    clearTimeout(timers.get(assistantEl));
    timers.set(assistantEl, setTimeout(async () => {
      if (processedAssistants.has(assistantEl)) return;
      if (isBusy() || !isComplete(pair)) return;
      const finalOutput = sigillNormalizedText(assistantEl, normalizeText, getText, 'assistant');
      if (!finalOutput || pendingSignatures.get(assistantEl) !== `${turnKey}\n\0\n${finalOutput}`) return;
      if (processedTurnKeys.has(turnKey)) return;

      processedAssistants.add(assistantEl);
      processedTurnKeys.add(turnKey);
      pendingAssistantByTurnKey.delete(turnKey);
      const res = await sigillStampTurn(platform, conversationId(), prompt, finalOutput);
      if (res?.ok) {
        consumeSubmittedPrompt(prompt);
        const convoId = conversationId();
        if (!stampedTurnCache.has(convoId)) stampedTurnCache.set(convoId, new Map());
        stampedTurnCache.get(convoId).set(contentKeyFor(prompt, finalOutput), { ...res, prompt, output: finalOutput });
        sigillInjectBadge(assistantEl, res);
      }
    }, assistantDelay));
  }

  function scan() {
    const users = getUsers();
    const assistants = getAssistants(users);
    const nextConversationId = conversationId();
    const pairs = makePairs(users, assistants, normalizeText, getText);
    if (nextConversationId !== currentConversationId) {
      const previousConversationId = currentConversationId;
      const preserveSubmit = hasRecentSubmit() && (
        lastSubmitConversationId === nextConversationId ||
        lastSubmitConversationId === 'unknown' ||
        lastSubmitConversationId === previousConversationId
      );
      if (!preserveSubmit) {
        lastSubmitAt = 0;
        lastSubmitConversationId = null;
        submittedPrompts.clear();
        pendingPromptText = '';
      } else if (lastSubmitConversationId === 'unknown' && nextConversationId !== 'unknown') {
        lastSubmitConversationId = nextConversationId;
      }
      currentConversationId = nextConversationId;
      armed = false;
      armedAt = 0;
      lastScanLog = '';
      pendingAssistantByTurnKey.clear();
      clearTimeout(armTimer);
      assistants.forEach(el => clearTimeout(timers.get(el)));
      loadStampedTurns(nextConversationId).then(() => {
        restoreExistingBadges(makePairs(getUsers(), getAssistants(getUsers()), normalizeText, getText), nextConversationId);
      });
    }

    const summary = `${users.length} user, ${assistants.length} assistant, ${pairs.length} pairs`;
    if (summary !== lastScanLog) {
      console.log(`[Sigill] ${label} scan: ${summary}`);
      lastScanLog = summary;
    }
    const now = Date.now();
    for (const user of users) {
      if (!userFirstSeenAt.has(user)) userFirstSeenAt.set(user, now);
    }
    pairs.forEach(pair => restoreBadge(pair, nextConversationId));
    if (!armed) {
      const recentSubmit = submitBelongsTo(nextConversationId);
      const newestPair = recentSubmit ? pairs.at(-1) : null;
      const historicalPairs = pairs.filter(pair => pair !== newestPair && !hasSubmittedPrompt(pair.prompt));
      markExisting(historicalPairs, nextConversationId);
      pairs.filter(pair => pair === newestPair || hasSubmittedPrompt(pair.prompt)).forEach(schedule);
      clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armed = true;
        armedAt = Date.now();
      }, pairs.length ? 2500 : 800);
      return;
    }
    pairs.forEach(schedule);
  }

  console.log(`[Sigill] ${label} adapter active`);
  new MutationObserver(scan).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-is-streaming', 'aria-busy', 'aria-expanded', 'data-state'],
  });
  scan();
}

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

function sigillInjectBadge(el, evidence) {
  if (el.dataset.sigillDone) return;
  el.dataset.sigillDone = '1';

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

  const host = el;
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
