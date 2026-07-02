// Envelope construction and canonicalization for AiEvidenceEnvelopeV1
// (spec/ai-evidence-envelope.v1.json). Pure functions, no chrome.*
// dependencies — loadable from the MV3 service worker via importScripts()
// and from Node via require() for the tests.

const SigillEvidence = (() => {
  const PROVIDER = { claude: 'anthropic', chatgpt: 'openai', gemini: 'google' };

  // Minimal RFC 8785 (JCS): sort object keys lexicographically, no whitespace.
  // Sufficient for envelopes: strings, booleans, integers, plain objects/arrays.
  function jcs(v) {
    if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
    if (v !== null && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  }

  // Hash of the canonical envelope with integrity.envelopeHash and proofs
  // removed before canonicalization (spec §4).
  async function envelopeHashHex(envelope) {
    const stripped = JSON.parse(JSON.stringify(envelope));
    if (stripped.integrity) delete stripped.integrity.envelopeHash;
    delete stripped.proofs;
    const canonical = jcs(stripped);
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Drop null/undefined values (booleans and empty strings survive) so the
  // canonical envelope never carries fields we don't actually know.
  function prune(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && v !== undefined) out[k] = v;
    }
    return out;
  }

  // Map an adapter TurnRecord (lib/turn-adapters.js) + its capture onto the
  // envelope schema. Returns a schema-shaped envelope WITHOUT
  // integrity.envelopeHash — the caller computes and attaches it, then stamps.
  //
  //   turn             normalized TurnRecord from an adapter
  //   capture          the network capture (url, startedAt, endedAt, durationMs)
  //   actor            { type, id, tenantId? } — id is REQUIRED by the schema
  //   attachments      hashed files observed for this turn:
  //                    [{ name, sizeBytes, mediaType, sha256, source, observedAt }]
  //                    — become `inputs` payloadRefs (hash-only, never content)
  //   extensionVersion manifest version, disclosed in capture metadata
  //   evidenceId, createdAt  supplied by the caller (deterministic in tests)
  function buildTurnEnvelope({ turn, capture, actor, attachments, extensionVersion, evidenceId, createdAt }) {
    if (!actor?.id) throw new Error('actor.id is required by AiEvidenceEnvelopeV1');

    // Capture-method disclosure. The schema has no top-level home for this
    // (additionalProperties: false) until schema 1.1 adds a `capture` block —
    // interim home is payloadRef.metadata, which is free-form by design.
    const captureInfo = prune({
      method: 'network',
      extensionVersion,
      adapter: turn.platform,
      url: capture.url ? capture.url.split('?')[0] : null,
      warnings: turn.warnings?.length ? turn.warnings : null,
    });

    const envelope = {
      schemaName: 'AiEvidenceEnvelope',
      schemaVersion: '1',
      evidenceId,
      createdAt,
      purpose: {
        category: 'chat.completion',
        businessContext: 'sigill-browser-extension: network-layer capture of a consumer AI chat turn',
      },
      actor: prune({ type: actor.type ?? 'user', id: actor.id, tenantId: actor.tenantId }),
      activity: {
        name: 'chat.completion',
        correlationId: turn.conversationId ?? 'unknown',
      },
      model: prune({
        provider: PROVIDER[turn.platform] ?? turn.platform,
        name: turn.model ?? 'unknown',
        version: turn.modelVersion,
      }),
    };

    // Regenerates ('variant') carry no new prompt — the schema allows omitting
    // it, which is more honest than repeating a prompt this request never sent.
    if (turn.promptText != null) {
      envelope.prompt = {
        contentType: 'text/plain',
        encoding: 'utf-8',
        inline: turn.promptText,
        metadata: prune({ role: 'user', messageId: turn.promptMessageId }),
      };
    }

    if (attachments?.length) {
      // Bind each locally hashed file to the platform's own declared
      // attachment. Match passes, strongest first: exact size (ChatGPT
      // declares it), exact filename (Gemini declares name but not size),
      // then the unambiguous 1:1 case (Claude declares only a file uuid).
      // The platform file id in the hashed envelope ties our hash to the
      // exact asset the provider saw.
      const unclaimed = [...(turn.declaredAttachments ?? [])];
      const oneToOne = attachments.length === 1 && unclaimed.length === 1;
      envelope.inputs = attachments.map(a => {
        let declaredIdx = unclaimed.findIndex(d => d.sizeBytes != null && d.sizeBytes === a.sizeBytes);
        if (declaredIdx === -1) declaredIdx = unclaimed.findIndex(d => d.name != null && d.name === a.name);
        if (declaredIdx === -1 && oneToOne) declaredIdx = 0;
        const declared = declaredIdx === -1 ? null : unclaimed.splice(declaredIdx, 1)[0];
        return {
          contentType: a.mediaType ?? 'application/octet-stream',
          encoding: 'binary',
          ref: a.name,
          hash: prune({
            alg: 'SHA-256',
            hex: a.sha256,
            sizeBytes: Number.isInteger(a.sizeBytes) ? a.sizeBytes : null,
          }),
          metadata: prune({
            filename: a.name,
            source: a.source,
            observedAt: a.observedAt,
            platformFileId: declared?.id,
            platformFileName: declared && declared.name !== a.name ? declared.name : null,
          }),
        };
      });
    }

    envelope.output = {
      contentType: 'text/plain',
      encoding: 'utf-8',
      inline: turn.outputText,
      metadata: prune({
        role: 'assistant',
        messageId: turn.messageId,
        parentMessageId: turn.parentMessageId,
        candidateId: turn.candidateId,
        action: turn.action,
        attachmentsDeclared: turn.attachmentCount,
        // files this turn offered for download, declared at stamp time —
        // the matching artifact envelope later proves the content hash
        generatedFiles: turn.generatedFiles?.length
          ? turn.generatedFiles.map(f => prune({ name: f.name, path: f.path, mediaType: f.mediaType }))
          : null,
        thinkingPresent: turn.thinkingPresent,
        contentRefs: turn.contentRefs,
        capture: captureInfo,
      }),
    };

    const processing = prune({
      startedAt: capture.startedAt,
      completedAt: capture.endedAt,
      durationMs: Number.isInteger(capture.durationMs) && capture.durationMs >= 0 ? capture.durationMs : null,
      stopReason: turn.stopReason,
    });
    if (Object.keys(processing).length) envelope.processingMetadata = processing;

    envelope.integrity = { canonicalization: 'RFC8785' };
    return envelope;
  }

  // Evidence for a file the platform produced, captured at download time.
  // Lives in its own envelope (the parent turn is already stamped and
  // immutable when the user clicks download) and links back via
  // activity.parentEvidenceId. Three honesty classes, disclosed via
  // metadata.hashSource:
  //   - 'blob-observed' → bytes hashed at URL.createObjectURL time, the
  //     strongest class: the hash is of exactly what the page built.
  //   - 'refetch'       → bytes hashed from an immediate second fetch of the
  //     same signed URL; corroborates but does not byte-verify the user's copy.
  //   - 'none'          → only the download *event* was observable:
  //     outputArtifacts carries the file metadata inline, and says so.
  //
  //   platform          'chatgpt' | 'claude' | 'gemini'
  //   artifact          { filename, sizeBytes, mediaType, sha256|null,
  //                       hashSource, sourceUrl (query-stripped), downloadedAt }
  //   link              { conversationId, messageId, sandboxPath,
  //                       platformFileId, parentEvidenceId } — known subset
  //   model             parent turn's model object, or null
  function buildArtifactEnvelope({ platform, artifact, link, model, actor, extensionVersion, evidenceId, createdAt }) {
    if (!actor?.id) throw new Error('actor.id is required by AiEvidenceEnvelopeV1');

    const HASH_NOTES = {
      refetch: 'hashed from an immediate re-fetch of the same signed download URL — corroborates but does not byte-verify the user\'s copy',
    };

    const captureInfo = prune({ method: 'network', extensionVersion, adapter: platform });
    const common = prune({
      filename: artifact.filename,
      downloadedAt: artifact.downloadedAt,
      sourceUrl: artifact.sourceUrl,
      sandboxPath: link?.sandboxPath,
      messageId: link?.messageId,
      platformFileId: link?.platformFileId,
      capture: captureInfo,
    });

    const ref = artifact.sha256
      ? {
        contentType: artifact.mediaType ?? 'application/octet-stream',
        encoding: 'binary',
        ref: artifact.filename,
        hash: prune({
          alg: 'SHA-256',
          hex: artifact.sha256,
          sizeBytes: Number.isInteger(artifact.sizeBytes) ? artifact.sizeBytes : null,
        }),
        metadata: prune({
          ...common,
          hashSource: artifact.hashSource ?? 'blob-observed',
          note: HASH_NOTES[artifact.hashSource] ?? null,
        }),
      }
      : {
        contentType: 'application/json',
        encoding: 'utf-8',
        inline: prune({
          filename: artifact.filename,
          sizeBytes: artifact.sizeBytes,
          mediaType: artifact.mediaType,
        }),
        metadata: {
          ...common,
          hashSource: 'none',
          note: 'file bytes were not observable in-browser — this records the download event, not the content',
        },
      };

    return {
      schemaName: 'AiEvidenceEnvelope',
      schemaVersion: '1',
      evidenceId,
      createdAt,
      purpose: {
        category: 'artifact.download',
        businessContext: 'sigill-browser-extension: file produced by an AI chat turn, captured at download',
      },
      actor: prune({ type: actor.type ?? 'user', id: actor.id, tenantId: actor.tenantId }),
      activity: prune({
        name: 'artifact.download',
        correlationId: link?.conversationId ?? 'unknown',
        parentEvidenceId: link?.parentEvidenceId,
      }),
      model: model ?? { provider: PROVIDER[platform] ?? platform, name: 'unknown' },
      outputArtifacts: [ref],
      integrity: { canonicalization: 'RFC8785' },
    };
  }

  return { jcs, envelopeHashHex, buildTurnEnvelope, buildArtifactEnvelope, PROVIDER };
})();

if (typeof module !== 'undefined') module.exports = SigillEvidence;
