// Selectors: [data-testid="human-turn"] / [data-testid="assistant-turn"]
// Update these if Claude's DOM structure changes.

(async () => {
  if (!(await sigillEnabled('claude'))) return;

  const processed = new WeakSet();
  const watching = new WeakSet();
  const timers = new WeakMap();

  function conversationId() {
    return location.pathname.split('/').filter(Boolean).at(-1) ?? 'unknown';
  }

  function scheduleStamp(el, role) {
    if (processed.has(el)) return;
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => {
      if (processed.has(el)) return;
      const text = el.innerText?.trim();
      if (!text) return;
      processed.add(el);
      sigillStamp('claude', role, text, conversationId());
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
    document.querySelectorAll('[data-testid="human-turn"]').forEach(el => attach(el, 'user'));
    document.querySelectorAll('[data-testid="assistant-turn"]').forEach(el => attach(el, 'assistant'));
  }

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
