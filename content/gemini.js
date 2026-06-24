// Selectors: user-query / model-response (Angular custom elements)

(() => {
  function conversationId() {
    const m = location.pathname.match(/\/([^/?]+)$/);
    return m?.[1] ?? 'unknown';
  }

  function normalizeText(text) {
    let cleaned = text.trim();
    // Strip leading UI button labels Gemini injects before the response (e.g. "Show code", "Hide code")
    cleaned = cleaned.replace(/^((?:Show|Hide) code\s*\n+)+/i, '');
    cleaned = cleaned.replace(/^You said\b\s*/i, '');
    cleaned = cleaned.replace(/^Gemini said\b\s*/i, '');
    return cleaned.trim();
  }

  function isComplete(pair) {
    const output = normalizeText(pair.output);
    if (!Boolean(output) || /^(thinking|generating|drafting|gemini said|show code|hide code)$/i.test(output)) return false;
    // Thumbs/copy buttons only appear after Gemini finishes responding.
    return Boolean(pair.assistantEl.querySelector(
      'thumbs-up-button, thumbs-down-button, button[aria-label*="thumb" i], button[aria-label*="helpful" i]'
    ));
  }

  sigillObserveTurns({
    platform: 'gemini',
    label: 'gemini',
    conversationId,
    getUsers: () => [...document.querySelectorAll('user-query')],
    getAssistants: () => [...document.querySelectorAll('model-response')],
    normalizeText,
    isComplete,
    assistantDelay: 600,
  });
})();
