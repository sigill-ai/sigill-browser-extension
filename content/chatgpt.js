// Selectors: [data-message-author-role="user"] / [data-message-author-role="assistant"]
// Update these if ChatGPT's DOM structure changes.

(() => {
  const processed = new WeakSet();
  const watching = new WeakSet();
  const timers = new WeakMap();

  function conversationId() {
    const m = location.pathname.match(/\/c\/([^/?]+)/);
    return m?.[1] ?? 'unknown';
  }

  function scheduleStamp(el, role) {
    if (processed.has(el)) return;
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(async () => {
      if (processed.has(el)) return;
      const text = el.innerText?.trim();
      if (!text) return;
      processed.add(el);
      const res = await sigillStamp('chatgpt', role, text, conversationId());
      if (res?.ok) sigillInjectBadge(el, role);
    }, role === 'assistant' ? 800 : 150));
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

  function scan() {
    const userEls = document.querySelectorAll('[data-message-author-role="user"]');
    const assistantEls = document.querySelectorAll('[data-message-author-role="assistant"]');
    console.debug(`[Sigill] scan: ${userEls.length} user, ${assistantEls.length} assistant elements`);
    userEls.forEach(el => attach(el, 'user'));
    assistantEls.forEach(el => attach(el, 'assistant'));
  }

  console.debug('[Sigill] chatgpt adapter active');
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
