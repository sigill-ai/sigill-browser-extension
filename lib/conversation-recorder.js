// Records observed AI conversations as Agent Evidence Profiles v1 runs
// (spec: sigill-dotnet/spec/agent-client-observed-v1.md):
//
//   conversation  → one run (a run is split into segments at the event limit or
//                   after it was closed for being idle)
//   before        → Control Artifact: the recorder's control set and settings
//   each turn     → model_output event: prompt, attachments and answer as digests
//   generated file→ model_output event with the file's digest
//   idle          → run_end, closing the run
//
// Every artifact is sealed blind through Sigill's MCP tools and timestamped
// (policy "per-event"), then indexed in the organisation's Evidence Store as a
// signed envelope — identifiers and digests, never content.
//
// Dependencies are injected ({ storage, mcp, evidence, now, settings }) so the
// recorder runs under Node with a stub signer.

const SigillConversationRecorder = (() => {
  const RECORDER_ID = 'urn:sigill:recorder:browser-extension';
  const ACTIVITY = 'ai-conversation'; // fixed and neutral: Sigill must not learn what a conversation is about
  const CONTROL_SET_ID = 'sigill-browser-extension-baseline';
  const EXT_KEY = 'ai.sigill.browser-extension';
  const AGENT_VERSION = 'web';
  const ASSISTANT_HOSTS = { claude: 'claude.ai', chatgpt: 'chatgpt.com', gemini: 'gemini.google.com' };
  const MAX_EVENTS = 2000; // common rules §7: ordinary events stop at 1998 so run_end (1999) always fits
  const IDLE_MS = 30 * 60 * 1000;
  const MAX_TURN_INDEX = 5000;
  const INDEX_BATCH = 50;

  const K_RUNS = 'recRuns';
  const K_ACTIVE = 'recActive';
  const K_OUTBOX = 'recOutbox';
  const K_TURNS = 'recTurns';
  const artKey = runId => `recArt:${runId}`;

  function create({ storage, mcp, evidence, now = () => new Date(), settings = async () => ({}), version = '0', checkTimestamp, log = () => {} }) {
    const E = evidence;
    const stampCheck = checkTimestamp ?? E.signatureTimestamp;
    let queue = Promise.resolve();
    const serial = fn => {
      const run = queue.catch(() => {}).then(fn);
      queue = run.catch(() => {});
      return run;
    };

    const get = async (k, dflt) => (await storage.get(k))[k] ?? dflt;
    const set = (k, v) => storage.set({ [k]: v });

    async function saveRun(run) {
      const runs = await get(K_RUNS, {});
      runs[run.id] = run;
      await set(K_RUNS, runs);
    }

    async function convRef(platform, conversationId) {
      return (await E.sha256Hex(new TextEncoder().encode(`${platform}\n${conversationId}`))).slice(0, 32);
    }

    const agentId = platform => `urn:sigill:assistant:${ASSISTANT_HOSTS[platform] ?? platform}`;

    // Seal one artifact and commit it: pending is durable before the request, and a
    // sequence number is never issued twice. Any failure stops the run (common rules §6.3).
    async function commit(run, env, contentType, objects, stamp, name) {
      if (run.broken) throw new Error(`run stopped (${run.broken})`);
      if (run.closed) throw new Error('run closed');
      const { canonical, hash } = await E.envelopeHash(env);
      run.pending = { name, hash };
      await saveRun(run);

      let res;
      let failure = null;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await mcp.seal({ envelopeHash: hash, contentType, certificateId: run.certificateId, objects, timestamp: stamp, qualified: false });
          break;
        } catch (err) {
          if (err.name === 'RetryableError' && attempt < 3) {
            await new Promise(r => setTimeout(r, Math.min(10, err.afterSeconds ?? 1) * 1000));
            continue;
          }
          failure = err;
          break;
        }
      }
      let sig = null;
      let genTime = null;
      if (!failure) {
        sig = await E.signatureSha256(res.signature);
        if (!sig) failure = new Error('the seal has no classical signature');
      }
      if (!failure && stamp) {
        try { genTime = await stampCheck(res.signature); } catch (err) { failure = err; }
      }
      if (failure) {
        run.pending = null;
        run.broken = failure.name === 'QuotaError' ? `not recorded from ${name} on: ${failure.message}` : `${name} could not be sealed: ${failure.message}`;
        await saveRun(run);
        throw failure;
      }

      const arts = await get(artKey(run.id), []);
      arts.push({ name, contentType, envelope: canonical, signature: res.signature, objectDigests: E.digests(objects), genTime, tsaName: res.timestampedBy ?? null });
      await set(artKey(run.id), arts);
      const outbox = await get(K_OUTBOX, []);
      outbox.push({ runId: run.id, i: arts.length - 1 });
      await set(K_OUTBOX, outbox);

      if (name === 'ctrl') {
        run.controlSig = sig;
      } else {
        run.prevSig = sig;
        run.nextSeq += 1;
        run.lastEventAt = now().toISOString();
        if (env.step.type === 'run_end') run.closed = true;
      }
      run.pending = null;
      await saveRun(run);
      return { evidenceId: env.evidenceId, genTime, tsaName: res.timestampedBy ?? null };
    }

    async function sealEvent(run, stepType, step, objects, extensions) {
      const binds = run.nextSeq === 0 ? { controlArtifactSignatureSha256: run.controlSig } : null;
      const env = E.event({
        now: now(), actor: { type: 'agent', id: run.agentId, version: AGENT_VERSION }, activity: ACTIVITY,
        correlationId: run.correlationId, seq: run.nextSeq, prevSig: run.prevSig, binds, stepType, step,
        consequential: false, stamp: true, extensions, objects,
      });
      const name = `${String(run.nextSeq).padStart(4, '0')}-${stepType}`;
      return commit(run, env, E.EXECUTION_CONTENT_TYPE, objects, true, name);
    }

    async function certificateFor() {
      const s = await settings();
      if (s.sealCertificateId) return s.sealCertificateId;
      const cfg = await mcp.recordingConfig();
      const platform = (cfg.certificates ?? []).find(c => c.source === 'platform' && c.id);
      if (!platform) throw new Error('No active Sigill Platform Seal is available');
      return platform.id;
    }

    function controlSet() {
      return JSON.stringify({
        id: CONTROL_SET_ID, version: '1',
        description: 'Recorder baseline: every completed assistant turn the extension observes is sealed and timestamped in capture order, with its prompt, attached files and answer as digests; a conversation idle for 30 minutes is closed.',
        idleCloseMinutes: IDLE_MS / 60000,
      });
    }

    async function startRun(platform, conversationId, segmentOf) {
      const s = await settings();
      const id = `${now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${E.newUUID().slice(0, 8)}`;
      const run = {
        id, platform, convRef: await convRef(platform, conversationId),
        correlationId: 'urn:uuid:' + E.newUUID(), agentId: agentId(platform),
        certificateId: await certificateFor(), nextSeq: 0, prevSig: null, controlSig: null,
        startedAt: now().toISOString(), lastEventAt: null, closed: false, broken: null, pending: null,
        segmentOf: segmentOf ?? null,
      };
      await saveRun(run);
      const policy = { profile: 'per-event', everyEvents: 0, everySeconds: 0, consequential: false };
      const objects = [
        await E.newObject('execution-policy', 'application/json', JSON.stringify({
          recorder: RECORDER_ID, version, platform: ASSISTANT_HOSTS[platform] ?? platform,
          platformsEnabled: s.platformsEnabled ?? null,
        })),
        await E.newObject('control-set', 'application/json', controlSet()),
      ];
      const env = E.controlArtifact({
        now: now(), actor: { type: 'system', id: RECORDER_ID, version }, activity: ACTIVITY,
        correlationId: run.correlationId, agent: { id: run.agentId, version: AGENT_VERSION },
        controlSet: { id: CONTROL_SET_ID, version: '1' }, policy, objects,
      });
      await commit(run, env, E.CONTROL_CONTENT_TYPE, objects, true, 'ctrl');
      const src = { platform: ASSISTANT_HOSTS[platform] ?? platform, conversation: run.convRef, capture: 'client-observed' };
      if (segmentOf) src.segmentOf = segmentOf;
      await sealEvent(run, 'run_start', null, [], { [EXT_KEY]: src });
      const active = await get(K_ACTIVE, {});
      active[`${platform}|${conversationId}`] = run.id;
      await set(K_ACTIVE, active);
      return run;
    }

    async function closeRun(run, disposition) {
      if (run.closed || run.broken || run.nextSeq === 0) return;
      await sealEvent(run, 'run_end', { finalSeq: run.nextSeq, finalPrevSignatureSha256: run.prevSig, runDisposition: disposition }, []);
    }

    // The conversation's open run, or a new segment when it is closed, stopped or full.
    async function runFor(platform, conversationId) {
      const active = await get(K_ACTIVE, {});
      const runs = await get(K_RUNS, {});
      const cur = runs[active[`${platform}|${conversationId}`]];
      if (cur && !cur.closed && !cur.broken && cur.nextSeq < MAX_EVENTS - 2) return cur;
      if (cur && !cur.closed && !cur.broken) await closeRun(cur, 'completed'); // full: close and continue
      return startRun(platform, conversationId, cur?.correlationId);
    }

    async function remember(entry) {
      const turns = await get(K_TURNS, []);
      turns.push(entry);
      await set(K_TURNS, turns.slice(-MAX_TURN_INDEX));
    }

    // One completed assistant turn. attachments: [{ sha256, sizeBytes, mediaType }].
    function recordTurn({ platform, conversationId, messageId, model, promptText, outputText, attachments = [] }) {
      return serial(async () => {
        if (!conversationId) throw new Error('turn has no conversation id');
        const run = await runFor(platform, conversationId);
        const objects = [];
        if (promptText) objects.push(await E.newObject('model-input', 'text/plain', promptText));
        for (const a of attachments) if (a.sha256) objects.push(E.digestObject('model-input', a.mediaType, a.sha256, a.sizeBytes));
        objects.push(await E.newObject('model-output', 'text/markdown', outputText));
        const ext = model ? { [EXT_KEY]: { model } } : null;
        const seq = run.nextSeq;
        const r = await sealEvent(run, 'model_output', null, objects, ext);
        await remember({ platform, conversationId, messageId: messageId ?? null, runId: run.id, seq, evidenceId: r.evidenceId, genTime: r.genTime, tsaName: r.tsaName });
        return { runId: run.id, seq, ...r };
      });
    }

    // A file the assistant produced and the user downloaded, observed as a digest.
    function recordGeneratedFile({ platform, conversationId, sha256, sizeBytes, mediaType }) {
      return serial(async () => {
        if (!conversationId || !sha256) throw new Error('generated file has no conversation or digest');
        const run = await runFor(platform, conversationId);
        const seq = run.nextSeq;
        const r = await sealEvent(run, 'model_output', { detail: 'generated file' }, [E.digestObject('model-output', mediaType, sha256, sizeBytes)]);
        return { runId: run.id, seq, ...r };
      });
    }

    // Close every open run with no event for IDLE_MS. Returns how many were closed.
    function closeIdle() {
      return serial(async () => {
        const runs = await get(K_RUNS, {});
        let n = 0;
        for (const run of Object.values(runs)) {
          if (run.closed || run.broken || run.pending || !run.lastEventAt) continue;
          if (now() - new Date(run.lastEventAt) < IDLE_MS) continue;
          try { await closeRun(run, 'completed'); n++; } catch (err) { log(`close ${run.id}: ${err.message}`); }
        }
        return n;
      });
    }

    // After a restart: a run with a seal request in flight cannot know whether it was
    // sealed, so it stops (its seq is never reused); the next turn starts a new segment.
    function recover() {
      return serial(async () => {
        const runs = await get(K_RUNS, {});
        let changed = false;
        for (const run of Object.values(runs)) {
          if (run.pending) {
            run.broken = `interrupted while sealing ${run.pending.name}`;
            run.pending = null;
            changed = true;
          }
        }
        if (changed) await set(K_RUNS, runs);
      });
    }

    // Index sealed artifacts in the Evidence Store, in order, at most INDEX_BATCH per call.
    function flushOutbox() {
      return serial(async () => {
        const outbox = await get(K_OUTBOX, []);
        if (!outbox.length) return { indexed: 0, pending: 0 };
        const batch = outbox.slice(0, INDEX_BATCH);
        const items = [];
        for (const [k, o] of batch.entries()) {
          const a = (await get(artKey(o.runId), []))[o.i];
          if (a) items.push({ key: String(k), envelope: JSON.parse(a.envelope), signature: a.signature, object_digests: a.objectDigests });
        }
        const results = items.length ? await mcp.index(items) : [];
        const done = new Set();
        for (const r of results) {
          if (r.status === 'indexed' || r.status === 'exists' || r.status === 'rejected') done.add(Number(r.key));
          if (r.status === 'rejected') log(`index rejected item ${r.key}: ${r.code ?? ''}`);
          if (r.status === 'retry') break; // keep order: stop at the first one to retry
        }
        // An item whose artifact disappeared (log cleared) is dropped.
        const rest = outbox.filter((o, k) => !(k < batch.length && (done.has(k) || !items.some(it => it.key === String(k)))));
        await set(K_OUTBOX, rest);
        return { indexed: done.size, pending: rest.length };
      });
    }

    async function stats() {
      const runs = Object.values(await get(K_RUNS, {}));
      const turns = await get(K_TURNS, []);
      return {
        runs: runs.length,
        openRuns: runs.filter(r => !r.closed && !r.broken).length,
        stoppedRuns: runs.filter(r => r.broken).length,
        turns: turns.length,
        lastStop: runs.filter(r => r.broken).sort((a, b) => (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''))[0]?.broken ?? null,
        unindexed: (await get(K_OUTBOX, [])).length,
      };
    }

    async function stampedTurns(platform, conversationId) {
      return (await get(K_TURNS, [])).filter(t => t.platform === platform && (t.conversationId === conversationId || t.conversationId === `c_${conversationId}`));
    }

    async function turnByMessageId(messageId) {
      return (await get(K_TURNS, [])).findLast(t => t.messageId === messageId) ?? null;
    }

    // Every run as an AgentRunBundle, verifiable at sigill.ai/verify-run.
    async function bundles() {
      const runs = Object.values(await get(K_RUNS, {}));
      const out = [];
      for (const run of runs) {
        const arts = await get(artKey(run.id), []);
        const control = arts.find(a => a.name === 'ctrl') ?? null;
        out.push({
          name: run.id,
          status: run.broken ? 'stopped' : run.closed ? 'closed' : 'open',
          bundle: E.bundle({ correlationId: run.correlationId, control, artifacts: arts.filter(a => a.name !== 'ctrl') }),
        });
      }
      return out;
    }

    async function clear() {
      return serial(async () => {
        const runs = await get(K_RUNS, {});
        await storage.remove([K_RUNS, K_ACTIVE, K_OUTBOX, K_TURNS, ...Object.keys(runs).map(artKey)]);
      });
    }

    return { recordTurn, recordGeneratedFile, closeIdle, recover, flushOutbox, stats, stampedTurns, turnByMessageId, bundles, clear };
  }

  return { create, RECORDER_ID, EXT_KEY, IDLE_MS };
})();

if (typeof module !== 'undefined') module.exports = SigillConversationRecorder;
