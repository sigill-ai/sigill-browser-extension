// Runs on sigill.ai pages — reads the stored JWT from localStorage and
// sends identity to the background so other content scripts can use it.
(() => {
  let lastToken = null;

  function decodeJwtPayload(raw) {
    const encoded = raw.split('.')[1];
    if (!encoded) return null;
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    return JSON.parse(atob(base64));
  }

  function sync() {
    const raw = localStorage.getItem('ns_token');
    if (!raw || raw === lastToken) return;

    try {
      const payload = decodeJwtPayload(raw);
      if (!payload) return;
      const email = payload.email ?? payload.sub;
      if (!email) return;
      if (!payload.exp || Date.now() >= payload.exp * 1000) return;
      lastToken = raw;

      chrome.runtime.sendMessage({
        type: 'SIGILL_IDENTITY',
        token: raw,
        email,
        userId: payload.sub,
        tenantId: payload.tenant_id,
      });
    } catch {
      // malformed token — ignore
    }
  }

  sync();
  setInterval(sync, 2000);
})();
