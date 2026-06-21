// Shared helpers for all platform adapters.
// All content scripts from this extension run in the same isolated world,
// so these top-level declarations are available in every adapter.

async function sigillStamp(platform, role, text, conversationId) {
  chrome.runtime.sendMessage({ type: 'STAMP', platform, role, text, conversationId }).catch(() => {});
}

async function sigillEnabled(platform) {
  try {
    const data = await chrome.storage.sync.get(['apiKey', `${platform}Enabled`]);
    return !!data.apiKey && data[`${platform}Enabled`] !== false;
  } catch {
    return false;
  }
}
