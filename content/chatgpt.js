// Selectors: [data-message-author-role="user"] / [data-message-author-role="assistant"]

(() => {
  function conversationId() {
    const m = location.pathname.match(/\/c\/([^/?]+)/);
    return m?.[1] ?? 'unknown';
  }

  function isGenerating() {
    return [
      '[data-testid="stop-button"]',
      '[aria-label*="Stop generating" i]',
      '[aria-label*="Stop streaming" i]',
      'button[aria-label*="Stop" i]',
    ].some(sel => {
      try {
        return Boolean(document.querySelector(sel));
      } catch {
        return false;
      }
    });
  }

  function normalizeText(text) {
    const lines = text.trim().split(/\n+/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return '';
    if (!/^Thought for\b/i.test(lines[0])) return text.trim();

    lines.shift();
    if (lines.length > 1 && !/[.!?:;)]$/.test(lines[0]) && lines[0].length < 120) {
      lines.shift();
    }
    return lines.join('\n').trim();
  }

  function getText(el) {
    if (el.getAttribute('data-message-author-role') !== 'assistant') {
      return el.innerText?.trim() ?? '';
    }

    const markdown = [...el.querySelectorAll('.markdown')].filter(node => {
      const text = node.innerText?.trim();
      return text && !node.closest('[aria-expanded],[data-testid*="thought" i],[class*="thought" i],[class*="reason" i]');
    });
    if (markdown.length) return markdown.map(node => node.innerText.trim()).join('\n\n');

    return normalizeText(el.innerText ?? '');
  }

  function isComplete(pair) {
    if (isGenerating()) return false;
    // Action buttons (copy, thumbs up/down, regenerate) only appear after streaming finishes.
    // These are outside .markdown so they don't match inline code-copy buttons.
    return Boolean(pair.assistantEl.querySelector(
      '[data-testid="copy-turn-action-button"], [data-testid="thumbs-up-button"], [data-testid="thumbs-down-button"],' +
      'button[aria-label*="thumbs up" i], button[aria-label*="thumbs down" i]'
    ));
  }

  sigillObserveTurns({
    platform: 'chatgpt',
    label: 'chatgpt',
    conversationId,
    getUsers: () => [...document.querySelectorAll('[data-message-author-role="user"]')],
    getAssistants: () => [...document.querySelectorAll('[data-message-author-role="assistant"]')],
    getText,
    normalizeText,
    isBusy: isGenerating,
    isComplete,
    assistantDelay: 600,
  });
})();
