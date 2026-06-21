// Selectors: user-query / model-response (Angular custom elements)
// Update these if Gemini's DOM structure changes.

(async () => {
  if (!(await sigillEnabled('gemini'))) return;

  const processed = new WeakSet();
  const watching = new WeakSet();
  const timers = new WeakMap();

  function conversationId() {
    const m = location.pathname.match(/\/([^/?]+)$/);
    return m?.[1] ?? 'unknown';
  }

  function scheduleStamp(el, role) {
    if (processed.has(el)) return;
    clearTimeout(timers.get(el));
    // Gemini renders slightly slower; use a longer debounce for assistant turns
    timers.set(el, setTimeout(() => {
      if (processed.has(el)) return;
      const text = el.innerText?.trim();
      if (!text) return;
      processed.add(el);
      sigillStamp('gemini', role, text, conversationId());
    }, role === 'assistant' ? 1200 : 150));
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
    document.querySelectorAll('user-query').forEach(el => attach(el, 'user'));
    document.querySelectorAll('model-response').forEach(el => attach(el, 'assistant'));
  }

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
