// Sigill MCP tools over a stateless tools/call (no initialize: Sigill's /mcp
// answers each call on its own). The extension uses only the recording tools its
// grant (scope mcp:agent:record) unlocks.
//
// Errors are typed: AuthError (sign in again), QuotaError (agent evidence quota
// used up), RetryableError (refused before processing — the same request may be
// sent again). Anything else is a plain Error and is never retried.

const SigillMcp = (() => {
  class AuthError extends Error { constructor(m) { super(m); this.name = 'AuthError'; } }
  class QuotaError extends Error {
    constructor(resetsAt) { super(`Agent evidence quota reached${resetsAt ? `; resets ${resetsAt}` : ''}`); this.name = 'QuotaError'; this.resetsAt = resetsAt; }
  }
  class RetryableError extends Error {
    constructor(m, afterSeconds) { super(m); this.name = 'RetryableError'; this.afterSeconds = afterSeconds; }
  }

  function create({ fetch, accessToken, base = 'https://api.sigill.ai', version = '0' }) {
    async function call(tool, args) {
      const token = await accessToken();
      let resp;
      try {
        resp = await fetch(base + '/mcp', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
        });
      } catch {
        throw new Error(`${tool}: Sigill could not be reached`);
      }
      if (resp.status === 401 || resp.status === 403) throw new AuthError('Sigill refused the connection; sign in again');
      if (resp.status === 429) throw new RetryableError(`${tool} throttled`, Number(resp.headers.get('Retry-After')) || 2);
      if (resp.status !== 200) throw new Error(`${tool} failed (${resp.status})`);
      let rpc;
      try { rpc = await resp.json(); } catch { throw new Error(`${tool}: unreadable response`); }
      if (rpc.error) throw new Error(`${tool}: protocol error ${rpc.error.code}`);
      const result = rpc.result;
      if (!result) throw new Error(`${tool}: empty result`);
      const sc = result.structuredContent ?? {};
      if (result.isError) {
        if (sc.error === 'agent_evidence_quota_exceeded') throw new QuotaError(sc.resetsAt ?? null);
        if (sc.error === 'rate_limited' || sc.status === 429) throw new RetryableError(`${tool}: ${sc.error ?? 'throttled'}`, Math.max(1, sc.retryAfterSeconds ?? 1));
        throw new Error(`${tool}: ${sc.error ?? 'tool error'}`);
      }
      return sc;
    }

    // Active certificates the organisation can seal agent evidence with.
    async function recordingConfig() {
      return call('sigill_agent_recording_config', {});
    }

    async function seal({ envelopeHash, contentType, certificateId, objects, timestamp, qualified }) {
      const args = {
        envelope_hash_hex: envelopeHash,
        envelope_content_type: contentType,
        certificate_id: certificateId,
        timestamp: Boolean(timestamp),
        objects: objects.map(o => ({ uri: o.uri, hash_hex: o.sha256, content_type: o.contentType })),
      };
      if (qualified && timestamp) args.qualified = true;
      const r = await call('sigill_seal_agent_artifact', args);
      if (!r.signature) throw new Error('the seal carried no signature');
      return r;
    }

    // items: [{ key, envelope (object), signature, object_digests }] → [{ key, status, retryAfterSeconds }]
    async function index(items) {
      const r = await call('sigill_index_agent_artifacts', { items });
      return r.results ?? [];
    }

    return { call, recordingConfig, seal, index };
  }

  return { create, AuthError, QuotaError, RetryableError };
})();

if (typeof module !== 'undefined') module.exports = SigillMcp;
