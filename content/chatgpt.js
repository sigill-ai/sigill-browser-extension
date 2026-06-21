// Selectors: [data-message-author-role="user"] / [data-message-author-role="assistant"]
// Update these if ChatGPT's DOM structure changes.

(async () => {
  if (!(await sigillEnabled('chatgpt'))) return;

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
    timers.set(el, setTimeout(() => {
      if (processed.has(el)) return;
      const text = el.innerText?.trim();
      if (!text) return;
      processed.add(el);
      sigillStamp('chatgpt', role, text, conversationId());
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
    document.querySelectorAll('[data-message-author-role="user"]').forEach(el => attach(el, 'user'));
    document.querySelectorAll('[data-message-author-role="assistant"]').forEach(el => attach(el, 'assistant'));
  }

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
