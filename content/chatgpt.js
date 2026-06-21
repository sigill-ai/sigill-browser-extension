// Selectors: [data-message-author-role="user"] / [data-message-author-role="assistant"]

(() => {
  const processed = new WeakSet();
  const watching  = new WeakSet();
  const timers    = new WeakMap();
  let lastPrompt  = '';

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
      if (role === 'user') {
        lastPrompt = text;
        console.debug('[Sigill] chatgpt: captured prompt');
      } else {
        const res = await sigillStampTurn('chatgpt', conversationId(), lastPrompt, text);
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

  function scan() {
    const u = document.querySelectorAll('[data-message-author-role="user"]');
    const a = document.querySelectorAll('[data-message-author-role="assistant"]');
    console.debug(`[Sigill] chatgpt scan: ${u.length} user, ${a.length} assistant`);
    u.forEach(el => attach(el, 'user'));
    a.forEach(el => attach(el, 'assistant'));
  }

  console.debug('[Sigill] chatgpt adapter active');
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
