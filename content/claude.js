// Primary selectors: [data-testid="human-turn"] / [data-testid="assistant-turn"]
// Fallbacks added because Claude's DOM has changed across versions.

(() => {
  const processed = new WeakSet();
  const watching  = new WeakSet();
  const timers    = new WeakMap();
  let lastPrompt  = '';

  const USER_SELECTORS      = ['[data-testid="human-turn"]', '[data-testid="user-message"]'];
  const ASSISTANT_SELECTORS = ['[data-testid="assistant-turn"]', '[data-testid="assistant-message"]', '.font-claude-message'];

  function conversationId() {
    return location.pathname.split('/').filter(Boolean).at(-1) ?? 'unknown';
  }

  function scheduleStamp(el, role) {
    if (processed.has(el)) return;
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(async () => {
      if (processed.has(el)) return;
      const text = el.innerText?.trim();
      if (!text) return;
      processed.add(el);
      if (role === 'user') {
        lastPrompt = text;
        console.debug('[Sigill] claude: captured prompt');
      } else {
        const res = await sigillStampTurn('claude', conversationId(), lastPrompt, text);
        lastPrompt = '';
        if (res?.ok) sigillInjectBadge(el);
      }
    }, role === 'assistant' ? 800 : 50));
  }

  function attach(el, role) {
    if (watching.has(el)) return;
    watching.add(el);
    if (role === 'assistant') {
      const obs = new MutationObserver(() => {
        if (processed.has(el)) { obs.disconnect(); return; }
        scheduleStamp(el, role);
      });
      obs.observe(el, { childList: true, subtree: true, characterData: true });
    }
    scheduleStamp(el, role);
  }

  function queryAll(selectors) {
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length) return { sel, els };
    }
    return { sel: null, els: [] };
  }

  function scan() {
    const { sel: uSel, els: uEls } = queryAll(USER_SELECTORS);
    const { sel: aSel, els: aEls } = queryAll(ASSISTANT_SELECTORS);
    console.debug(`[Sigill] claude scan: ${uEls.length} user (${uSel}), ${aEls.length} assistant (${aSel})`);
    uEls.forEach(el => attach(el, 'user'));
    aEls.forEach(el => attach(el, 'assistant'));
  }

  console.debug('[Sigill] claude adapter active');
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
