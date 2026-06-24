// Selector strategy: try specific data-testid first, then class-based fallbacks.
// Claude.ai's React DOM changes frequently — the queryAll helper tries each
// candidate and picks the first that actually returns elements.

(() => {
  const USER_SELECTORS = [
    '[data-testid="human-turn"]',
    '[data-testid="user-message"]',
    '.human-turn',
    '[class*="HumanTurn"]',
    '[class*="human-turn"]',
  ];

  // Explicit selectors to try first; if none match we fall back to structural detection.
  const ASSISTANT_SELECTORS_EXPLICIT = [
    '[data-is-streaming]',           // current Claude.ai: response containers have this attribute
    '[data-testid="assistant-turn"]',
    '[data-testid="assistant-message"]',
    '[data-testid="bot-message"]',
    '[data-testid="claude-message"]',
    '[data-testid="ai-message"]',
    '.font-claude-message',
    '[class*="AssistantTurn"]',
    '[class*="assistant-turn"]',
  ];

  function conversationId() {
    return location.pathname.split('/').filter(Boolean).at(-1) ?? 'unknown';
  }

  function normalizeText(text) {
    let cleaned = text
      .replace(/^Claude responded:\s*/i, '')
      .trim();

    cleaned = cleaned.replace(/^[\uE000-\uF8FF\s]+/, '').trim();
    cleaned = cleaned.replace(/^"[^"\n]{10,400}"\s*\n+/s, '').trim();
    const lines = cleaned.split(/\n+/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 1 && /^(thought|thinking|reasoned|deciphered)\b/i.test(lines[0])) {
      lines.shift();
      cleaned = lines.join('\n').trim();
    }

    const parts = cleaned.split(/\n{2,}/);
    if (parts.length > 1 && parts[1].startsWith(parts[0])) {
      return parts.slice(1).join('\n\n').trim();
    }
    return cleaned;
  }

  function visibleText(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return '';
    return el.innerText?.trim() ?? '';
  }

  function isReasoningUi(el) {
    const marker = [
      el.getAttribute('data-testid') ?? '',
      el.getAttribute('aria-label') ?? '',
      el.className?.toString?.() ?? '',
    ].join(' ').toLowerCase();
    return /\b(thought|thinking|reason|summary)\b/.test(marker);
  }

  function getText(el) {
    if (
      el.matches('[data-testid="user-message"],[data-user-message-bubble="true"]') ||
      el.querySelector('[data-testid="user-message"],[data-user-message-bubble="true"]')
    ) {
      return visibleText(el)
        .replace(/^You said:\s*/i, '')
        .trim();
    }

    const answerSelectors = [
      '.standard-markdown',
      '.progressive-markdown',
      '[class*="standard-markdown"]',
      '[class*="progressive-markdown"]',
      '.font-claude-response-body',
    ];

    const candidates = [];
    if (answerSelectors.some(sel => { try { return el.matches(sel); } catch { return false; } })) {
      candidates.push(el);
    }
    for (const sel of answerSelectors) {
      try {
        candidates.push(...el.querySelectorAll(sel));
      } catch {}
    }
    const uniqueCandidates = [...new Set(candidates)];

    const blocks = uniqueCandidates
      .filter(node => !isReasoningUi(node) && !node.closest('[data-testid*="thought" i],[class*="thought" i],[class*="thinking" i],[class*="reason" i]'))
      .filter((node, _index, nodes) => !nodes.some(other => other !== node && node.contains(other)))
      .map(visibleText)
      .filter(Boolean);

    if (blocks.length) return blocks.join('\n\n');

    const fallbackSelectors = [
      '[data-testid="assistant-message"]',
      '[data-testid="message-content"]',
      '.font-claude-message',
      '.font-claude-response',
    ];
    const fallback = [];
    for (const sel of fallbackSelectors) {
      try {
        fallback.push(...el.querySelectorAll(sel));
      } catch {}
    }
    return fallback
      .filter(node => !isReasoningUi(node))
      .map(visibleText)
      .find(Boolean) ?? '';
  }

  function isStatusOnly(text) {
    return /^(thinking|thought|reasoning|deciphered|deliberated)\b/i.test(text.trim());
  }

  function isComplete(pair) {
    if (pair.assistantEl?.getAttribute('data-is-streaming') === 'true') return false;
    const output = normalizeText(getText(pair.assistantEl));
    return Boolean(output) && !isStatusOnly(output);
  }

  function queryUsers() {
    for (const sel of USER_SELECTORS) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length) return { sel, els: [...els] };
      } catch {}
    }
    return { sel: null, els: [] };
  }

  function queryAssistants(userEls) {
    // Try explicit selectors first.
    for (const sel of ASSISTANT_SELECTORS_EXPLICIT) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length) return { sel, els: [...els] };
      } catch {}
    }

    // Structural fallback: the assistant turn is the DOM sibling that immediately
    // follows each user message's turn container. Walk up from each user-message
    // until we find an ancestor whose nextElementSibling has real text content.
    if (!userEls.length) return { sel: null, els: [] };
    const found = new Set();
    for (const userEl of userEls) {
      let el = userEl;
      while (el.parentElement && el.parentElement !== document.body) {
        el = el.parentElement;
        const next = el.nextElementSibling;
        if (next && !next.querySelector('[data-testid="user-message"]')) {
          const text = next.innerText?.trim();
          if (text && text.length > 10) { found.add(next); break; }
        }
      }
    }
    if (found.size) return { sel: 'structural', els: [...found] };
    return { sel: null, els: [] };
  }

  sigillObserveTurns({
    platform: 'claude',
    label: 'claude',
    conversationId,
    getUsers: () => queryUsers().els,
    getAssistants: userEls => queryAssistants(userEls).els,
    getText,
    normalizeText,
    isComplete,
    assistantDelay: 3000,
  });
})();
