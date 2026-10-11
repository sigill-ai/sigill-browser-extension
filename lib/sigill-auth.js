// Sigill sign-in: OAuth 2.1 authorization code + PKCE (S256) through
// chrome.identity.launchWebAuthFlow. The client is identified by its Client ID
// Metadata Document on sigill.ai; Chrome delivers the chromiumapp.org redirect
// only to this extension. Tokens are MCP tokens (audience <issuer>/mcp): they are
// used for Sigill's MCP tools only and never sent to REST endpoints.
//
// No API key and no sigill.ai session token is ever read or stored.
//
// Dependencies are injected ({ storage, fetch, launchWebAuthFlow, redirectUrl })
// so the flow is testable in Node; the worker passes the chrome.* versions.

const SigillAuth = (() => {
  const ISSUER = 'https://api.sigill.ai';
  const CLIENT_ID = 'https://sigill.ai/.well-known/oauth-client/browser-extension.json';
  const SCOPE = 'mcp:agent:record offline_access';
  const REFRESH_MARGIN_MS = 5 * 60 * 1000;
  const KEY = 'sigillConnection';
  const INFLIGHT = 'sigillRefreshInFlight';

  class NotConnectedError extends Error {
    constructor(msg) { super(msg ?? 'Not connected to Sigill'); this.name = 'NotConnectedError'; }
  }

  const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomToken = n => b64url(globalThis.crypto.getRandomValues(new Uint8Array(n)));

  async function pkceChallenge(verifier) {
    const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(d));
  }

  function sameOrigin(a, b) {
    try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
  }

  // Validate the authorization response the browser handed back (RFC 6749 §4.1.2, RFC 9207).
  function parseCallback(responseUrl, { redirectUrl, state, issuer }) {
    let u;
    try { u = new URL(responseUrl); } catch { throw new Error('The sign-in answer was not a URL'); }
    if (u.origin + u.pathname !== redirectUrl) throw new Error('The sign-in answer came back to the wrong address');
    const q = u.searchParams;
    if (q.get('state') !== state) throw new Error('The sign-in answer does not belong to this sign-in');
    if (q.get('iss') && q.get('iss').replace(/\/$/, '') !== issuer) throw new Error('The sign-in answer came from another issuer');
    if (q.get('error')) throw new Error(`Sign-in was not completed (${q.get('error')})`);
    const code = q.get('code');
    if (!code) throw new Error('The sign-in answer carried no code');
    return code;
  }

  function create({ storage, fetch, launchWebAuthFlow, redirectUrl, issuer = ISSUER, clientId = CLIENT_ID, deviceLabel = 'Browser extension' }) {
    let lock = Promise.resolve();
    const withLock = fn => {
      const run = lock.catch(() => {}).then(fn);
      lock = run.catch(() => {});
      return run;
    };
    const load = async () => (await storage.get(KEY))[KEY] ?? null;
    const save = cred => storage.set({ [KEY]: cred });

    async function discover() {
      const resp = await fetch(issuer + '/.well-known/oauth-authorization-server');
      if (!resp.ok) throw new Error(`Could not reach Sigill (${resp.status})`);
      const md = await resp.json();
      for (const k of ['authorization_endpoint', 'token_endpoint']) {
        if (typeof md[k] !== 'string' || !md[k].startsWith('https://')) throw new Error('Sigill sign-in metadata is incomplete');
      }
      return md;
    }

    async function deviceId() {
      const { sigillDeviceId } = await storage.get('sigillDeviceId');
      if (sigillDeviceId) return sigillDeviceId;
      const id = randomToken(24); // 32 chars of [A-Za-z0-9_-]
      await storage.set({ sigillDeviceId: id });
      return id;
    }

    // Returns { status, body }; a request that never left (network error) throws NotSent.
    async function tokenRequest(url, form) {
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form).toString(),
        });
      } catch (err) {
        const e = new Error('Sigill could not be reached');
        e.notSent = true;
        throw e;
      }
      let body = {};
      try { body = await resp.json(); } catch { /* empty */ }
      return { status: resp.status, body };
    }

    function apply(cred, body) {
      if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('the token answer carried no access token');
      cred.accessToken = body.access_token;
      cred.accessExpiry = Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000;
      if (typeof body.refresh_token === 'string' && body.refresh_token) cred.refreshToken = body.refresh_token;
      if (typeof body.scope === 'string') cred.scope = body.scope;
      return cred;
    }

    async function revoke(cred) {
      if (!cred?.revokeUrl || !sameOrigin(cred.revokeUrl, cred.issuer)) return;
      const token = cred.refreshToken || cred.accessToken;
      if (!token) return;
      try {
        await fetch(cred.revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token, client_id: cred.clientId }).toString(),
        });
      } catch { /* best effort */ }
    }

    async function connect() {
      const md = await discover();
      const verifier = randomToken(48);
      const state = randomToken(24);
      const device = await deviceId();
      const q = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUrl,
        code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', state,
        scope: SCOPE, resource: issuer + '/mcp', device_id: device, device_label: deviceLabel,
      });
      const responseUrl = await launchWebAuthFlow({ url: `${md.authorization_endpoint}?${q}`, interactive: true });
      if (!responseUrl) throw new Error('Sign-in was cancelled');
      const code = parseCallback(responseUrl, { redirectUrl, state, issuer });

      const { status, body } = await tokenRequest(md.token_endpoint, {
        grant_type: 'authorization_code', code, redirect_uri: redirectUrl,
        code_verifier: verifier, client_id: clientId, resource: issuer + '/mcp',
      });
      if (status !== 200) throw new Error(`Sigill did not issue a token (${body.error ?? status})`);
      const cred = apply({
        issuer, clientId, deviceId: device, tokenUrl: md.token_endpoint,
        revokeUrl: md.revocation_endpoint ?? null, connectedAt: new Date().toISOString(),
      }, body);
      if (!` ${cred.scope ?? ''} `.includes(' mcp:agent:record ')) {
        await revoke(cred);
        throw new Error('The connection was approved without recording; connect again and approve it');
      }
      return withLock(async () => {
        const old = await load();
        if (old?.refreshToken) await revoke(old); // the replaced connection ends
        await save(cred);
        await storage.remove(INFLIGHT);
        return { connectedAt: cred.connectedAt, scope: cred.scope };
      });
    }

    // A valid access token, refreshed when it is about to expire. A refresh token is
    // spent at most once: the in-flight marker is durable before it leaves, so a
    // worker killed mid-refresh never replays it (replay revokes the whole grant).
    async function accessToken() {
      const cred = await load();
      if (!cred) throw new NotConnectedError();
      if (cred.uncertain) throw new NotConnectedError(`Sign in to Sigill again (${cred.uncertain})`);
      if (cred.accessExpiry - Date.now() > REFRESH_MARGIN_MS) return cred.accessToken;
      return withLock(async () => {
        const cur = await load();
        if (!cur) throw new NotConnectedError();
        if (cur.uncertain) throw new NotConnectedError(`Sign in to Sigill again (${cur.uncertain})`);
        if ((await storage.get(INFLIGHT))[INFLIGHT]) {
          cur.uncertain = 'a token refresh was interrupted';
          await save(cur);
          await storage.remove(INFLIGHT);
          throw new NotConnectedError(`Sign in to Sigill again (${cur.uncertain})`);
        }
        if (cur.accessExpiry - Date.now() > REFRESH_MARGIN_MS) return cur.accessToken;
        if (!cur.refreshToken) throw new NotConnectedError('Sign in to Sigill again');
        await storage.set({ [INFLIGHT]: true });
        let res;
        try {
          res = await tokenRequest(cur.tokenUrl, {
            grant_type: 'refresh_token', refresh_token: cur.refreshToken,
            client_id: cur.clientId, resource: cur.issuer + '/mcp',
          });
        } catch (err) {
          if (err.notSent) { await storage.remove(INFLIGHT); throw err; } // nothing was spent
          throw err;
        }
        if (res.status === 200) {
          try { apply(cur, res.body); } catch (e) { cur.uncertain = e.message; }
        } else if (res.status === 429) {
          await storage.remove(INFLIGHT); // throttled before processing
          throw new Error('Sigill is busy; try again shortly');
        } else if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(res.body.error)) {
          cur.refreshToken = null;
          cur.uncertain = `the connection was ended (${res.body.error})`;
        } else {
          cur.uncertain = 'a token refresh got no answer';
        }
        await save(cur);
        await storage.remove(INFLIGHT);
        if (cur.uncertain) throw new NotConnectedError(`Sign in to Sigill again (${cur.uncertain})`);
        return cur.accessToken;
      });
    }

    async function disconnect() {
      return withLock(async () => {
        const cred = await load();
        if (cred) await revoke(cred);
        await storage.remove([KEY, INFLIGHT]);
      });
    }

    async function status() {
      const cred = await load();
      if (!cred) return { connected: false };
      return { connected: !cred.uncertain, needsReconnect: Boolean(cred.uncertain), reason: cred.uncertain ?? null, connectedAt: cred.connectedAt };
    }

    return { connect, accessToken, disconnect, status, issuer };
  }

  return { create, parseCallback, pkceChallenge, NotConnectedError, ISSUER, CLIENT_ID, SCOPE };
})();

if (typeof module !== 'undefined') module.exports = SigillAuth;
