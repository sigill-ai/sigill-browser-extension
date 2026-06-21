// Shared helpers for all platform adapters.
// All content scripts from this extension run in the same isolated world,
// so these top-level declarations are available in every adapter.

async function sigillStamp(platform, role, text, conversationId) {
  chrome.runtime.sendMessage({ type: 'STAMP', platform, role, text, conversationId })
    .then(res => {
      if (res?.ok) console.debug(`[Sigill] stamped ${platform} ${role} (${text.length} chars)`);
      else if (res?.skipped) console.debug('[Sigill] skipped — no API key or platform disabled');
      else if (res?.error) console.warn('[Sigill] stamp error:', res.error);
    })
    .catch(() => {});
}
