// Sigill turn adapters — parse captured platform API traffic into normalized
// TurnRecords. Written against real fixtures (test/fixtures/), which are the
// regression suite: run `node test/adapters.test.js` after touching this file.
//
// Pure functions, no chrome.* dependencies — loadable from the MV3 service
// worker via importScripts() and from Node via require() for the tests.
//
// A TurnRecord is the adapter-neutral shape phase 2 maps onto
// AiEvidenceEnvelopeV1:
//   {
//     platform, conversationId, messageId, parentMessageId,
//     action,              // 'next' | 'variant' (regenerate) | null
//     model,               // provider-reported model string, null if absent
//     modelVersion,        // extra build/version info when available
//     promptMessageId, promptText,   // null for regenerates (no new prompt)
//     outputText,          // final-channel answer text only
//     thinkingPresent,     // stream contained reasoning content (excluded)
//     contentRefs,         // embedded non-text content refs (widgets, genui)
//     stopReason, complete,
//     warnings: []         // anything the adapter saw but didn't understand
//   }
// Adapters must degrade loudly: unknown shapes land in warnings, and
// complete=false unless the platform's own terminal event was seen.

const SigillTurnAdapters = (() => {
  // ---------- shared helpers ----------

  function joinChunks(capture) {
    return (capture.chunks ?? []).map(c => c.text).join('');
  }

  function tryJson(str) {
    try { return JSON.parse(str); } catch { return undefined; }
  }

  // Server-sent events: blocks separated by blank lines, `event:`/`data:` lines.
  // The spec allows \r\n, \n, or \r as line terminators — claude.ai switched
  // to \r\n in July 2026 and silently broke a \n-only parser; normalize first.
  function parseSse(text) {
    const events = [];
    for (const block of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\n/)) {
      let event = null;
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (event !== null || data.length) events.push({ event, data: data.join('\n') });
    }
    return events;
  }

  function baseTurn(platform) {
    return {
      platform,
      conversationId: null,
      messageId: null,
      parentMessageId: null,
      action: null,
      model: null,
      modelVersion: null,
      promptMessageId: null,
      promptText: null,
      outputText: '',
      thinkingPresent: false,
      contentRefs: false,
      stopReason: null,
      complete: false,
      // How many attachments the request itself declared: 0 = provably none,
      // >0 = files were sent, null = this platform/turn doesn't reveal it.
      attachmentCount: null,
      // Platform-declared attachment descriptors when the request carries
      // them: [{ id, name, sizeBytes, mediaType }]
      declaredAttachments: null,
      // Files this turn produced, as declared by the stream itself:
      // [{ name, path?, url?, mediaType? }] — matched against downloads later.
      generatedFiles: [],
      warnings: [],
    };
  }

  // Private-use-area chars mark embedded content references (ChatGPT genui
  // widgets etc.) — non-text content the UI renders in place of the marker.
  const PUA_RE = /[\uE000-\uF8FF]/;

  // ---------- ChatGPT ----------
  //
  // Completion stream: SSE with `delta_encoding: "v1"`. Messages are added as
  // full objects ({o:'add', v:{message}}), then mutated by JSON-pointer-ish
  // operations. A delta with no p/o repeats the previous operation; a bare
  // array value is a patch list. Lifecycle events are plain JSON objects with
  // a `type` field. The final answer is the message flagged by a
  // `message_marker` event with marker 'final_channel' / 'user_visible'.

  const chatgpt = {
    isCompletion(capture) {
      return (capture.responseContentType ?? '').startsWith('text/event-stream') &&
        /\/backend-(api|anon)\/(f\/)?conversation$/.test((capture.url ?? '').split('?')[0]);
    },

    isHistory(capture) {
      return capture.method === 'GET' &&
        /\/backend-(api|anon)\/conversation\/[0-9a-f-]{8,}$/.test((capture.url ?? '').split('?')[0]);
    },

    parseCompletion(capture) {
      const turn = baseTurn('chatgpt');
      const req = tryJson(capture.requestBody) ?? {};
      turn.action = req.action ?? null;
      turn.model = req.model ?? null;
      turn.conversationId = req.conversation_id ?? null;
      turn.parentMessageId = req.parent_message_id ?? null;
      const reqMsg = req.messages?.[0];
      if (reqMsg) {
        turn.promptMessageId = reqMsg.id ?? null;
        turn.promptText = (reqMsg.content?.parts ?? []).filter(p => typeof p === 'string').join('\n') || null;
        // Attachments ride on message metadata; absent key on text-only turns,
        // so only a present array is evidence either way.
        if (Array.isArray(reqMsg.metadata?.attachments)) {
          turn.attachmentCount = reqMsg.metadata.attachments.length;
          turn.declaredAttachments = reqMsg.metadata.attachments.map(a => ({
            id: a.id ?? null,
            name: a.name ?? null,
            sizeBytes: Number.isInteger(a.size) ? a.size : null,
            mediaType: a.mime_type ?? null,
          }));
        }
      }

      // id -> { role, channel, recipient, parts, status, modelSlug, stopReason }
      const messages = new Map();
      let currentId = null;
      let lastPath = null;
      let lastOp = null;
      let finalMessageId = null;
      let streamComplete = false;

      const registerMessage = msg => {
        if (!msg?.id) return;
        const meta = msg.metadata ?? {};
        const content = msg.content ?? {};
        messages.set(msg.id, {
          role: msg.author?.role ?? null,
          channel: meta.channel ?? null,
          recipient: msg.recipient ?? null,
          parts: Array.isArray(content.parts) ? content.parts.map(String)
            : typeof content.text === 'string' ? [content.text] : [''],
          status: msg.status ?? null,
          modelSlug: meta.model_slug ?? null,
          stopReason: meta.finish_details?.type ?? null,
          parentId: meta.parent_id ?? null,
        });
        currentId = msg.id;
      };

      const applyOp = (p, o, v) => {
        if ((o === 'patch' || (o == null && Array.isArray(v))) && Array.isArray(v)) {
          for (const op of v) applyOp(op?.p, op?.o, op?.v);
          return;
        }
        if (v && typeof v === 'object' && v.message) {
          registerMessage(v.message);
          return;
        }
        const path = p ?? lastPath;
        const op = o ?? lastOp ?? 'append';
        if (p != null) lastPath = p;
        if (o != null) lastOp = o;
        const target = currentId ? messages.get(currentId) : null;
        if (!target) return;
        if (op === 'append' && typeof v === 'string') {
          // Only content paths accumulate output — appends to metadata paths
          // (content_references etc.) must not leak into the answer text.
          const m = (path ?? '').match(/^\/message\/content\/(?:parts\/(\d+)|text)$/);
          if (!m) return;
          const idx = m[1] ? Number(m[1]) : 0;
          while (target.parts.length <= idx) target.parts.push('');
          target.parts[idx] += v;
        } else if (op === 'replace') {
          if (path === '/message/status' && typeof v === 'string') target.status = v;
          else if (path === '/message/metadata/finish_details/type' && typeof v === 'string') target.stopReason = v;
          else if (path === '/message/metadata/model_slug' && typeof v === 'string') target.modelSlug = v;
        }
        // 'add'/'remove' on metadata paths: irrelevant to the turn record
      };

      for (const ev of parseSse(joinChunks(capture))) {
        if (ev.event === 'delta_encoding') {
          const enc = tryJson(ev.data);
          if (enc !== 'v1') turn.warnings.push(`unknown delta_encoding: ${ev.data}`);
          continue;
        }
        const d = tryJson(ev.data);
        if (d === undefined) {
          if (ev.data && ev.data !== '[DONE]') turn.warnings.push(`unparseable data: ${ev.data.slice(0, 80)}`);
          continue;
        }
        if (d && typeof d === 'object' && !Array.isArray(d) && typeof d.type === 'string') {
          // lifecycle event
          if (d.conversation_id) turn.conversationId = d.conversation_id;
          if (d.type === 'message_marker') {
            const marker = String(d.marker ?? '');
            if (marker.startsWith('final_channel') || marker.startsWith('user_visible')) {
              finalMessageId = d.message_id ?? finalMessageId;
            }
          } else if (d.type === 'message_stream_complete') {
            streamComplete = true;
          } else if (d.type === 'input_message') {
            if (!turn.promptMessageId) turn.promptMessageId = d.input_message?.id ?? null;
          }
          continue;
        }
        if (Array.isArray(d)) { applyOp(null, 'patch', d); continue; }
        if (d && typeof d === 'object') { applyOp(d.p, d.o, d.v); continue; }
        turn.warnings.push(`unrecognized event shape: ${String(ev.data).slice(0, 80)}`);
      }

      // Pick the answer message: marker-flagged, else last visible assistant
      // message with content.
      let answer = finalMessageId ? messages.get(finalMessageId) : null;
      if (answer) turn.messageId = finalMessageId;
      if (!answer) {
        for (const [id, m] of messages) {
          if (m.role === 'assistant' && m.channel !== 'thoughts' && (m.recipient == null || m.recipient === 'all') &&
              m.parts.join('').trim()) {
            answer = m;
            turn.messageId = id;
          }
        }
        if (answer) turn.warnings.push('no final-channel marker — used last visible assistant message');
      }
      for (const m of messages.values()) {
        if (m.channel === 'thoughts' || m.role === 'tool') turn.thinkingPresent = true;
      }
      if (answer) {
        turn.outputText = answer.parts.join('\n').trim();
        turn.contentRefs = PUA_RE.test(turn.outputText);
        turn.model = answer.modelSlug ?? turn.model;
        turn.stopReason = answer.stopReason ?? answer.status ?? null;
        // Files offered for download appear as sandbox: links in the answer
        for (const m of turn.outputText.matchAll(/sandbox:((?:\/[^\s)"'\]]+)+)/g)) {
          turn.generatedFiles.push({ name: m[1].split('/').pop(), path: m[1] });
        }
      } else {
        turn.warnings.push('no assistant answer message found in stream');
      }
      turn.complete = streamComplete && Boolean(answer);
      return turn;
    },

    // GET /backend-api/conversation/<uuid> — the message tree, ground truth
    // for lineage. Returns { conversationId, currentNode, nodes: Map-like [] }.
    parseHistory(capture) {
      const body = tryJson(joinChunks(capture));
      if (!body?.mapping) return { warnings: ['no mapping in history body'], nodes: [] };
      const nodes = [];
      for (const [id, node] of Object.entries(body.mapping)) {
        const msg = node.message;
        if (!msg) continue;
        nodes.push({
          id,
          parentId: node.parent ?? null,
          childIds: node.children ?? [],
          role: msg.author?.role ?? null,
          channel: msg.metadata?.channel ?? null,
          text: (msg.content?.parts ?? []).filter(p => typeof p === 'string').join('\n').trim(),
          modelSlug: msg.metadata?.model_slug ?? null,
          createTime: msg.create_time ?? null,
          status: msg.status ?? null,
        });
      }
      return {
        conversationId: body.conversation_id ?? null,
        currentNode: body.current_node ?? null,
        defaultModelSlug: body.default_model_slug ?? null,
        nodes,
        warnings: [],
      };
    },
  };

  // ---------- Claude ----------
  //
  // Completion stream: standard Anthropic SSE — message_start carries the
  // message uuid + real model string; content blocks are typed (thinking vs
  // text); message_delta carries stop_reason; message_stop is terminal.

  const claude = {
    isCompletion(capture) {
      return (capture.responseContentType ?? '').startsWith('text/event-stream') &&
        /\/(completion|retry_completion)$/.test((capture.url ?? '').split('?')[0]);
    },

    isHistory(capture) {
      return capture.method === 'GET' &&
        /\/chat_conversations\/[0-9a-f-]{8,}$/.test((capture.url ?? '').split('?')[0]);
    },

    parseCompletion(capture) {
      const turn = baseTurn('claude');
      const req = tryJson(capture.requestBody) ?? {};
      turn.promptText = typeof req.prompt === 'string' && req.prompt ? req.prompt : null;
      turn.model = req.model ?? null;
      turn.action = /retry_completion$/.test((capture.url ?? '').split('?')[0]) ? 'variant' : 'next';
      if (Array.isArray(req.attachments) || Array.isArray(req.files)) {
        turn.attachmentCount = (req.attachments?.length ?? 0) + (req.files?.length ?? 0);
        if (turn.attachmentCount > 0) {
          // files: bare uuids; attachments: extracted-content objects
          turn.declaredAttachments = [
            ...(req.files ?? []).map(id => ({ id: typeof id === 'string' ? id : null, name: null, sizeBytes: null, mediaType: null })),
            ...(req.attachments ?? []).map(a => ({
              id: a?.id ?? null,
              name: a?.file_name ?? a?.name ?? null,
              sizeBytes: Number.isInteger(a?.file_size) ? a.file_size : null,
              mediaType: a?.file_type ?? null,
            })),
          ].filter(a => a.id || a.name);
        }
      }
      const urlMatch = (capture.url ?? '').match(/\/chat_conversations\/([0-9a-f-]{8,})\//);
      turn.conversationId = urlMatch?.[1] ?? null;

      const blocks = new Map(); // index -> { type, text }
      let sawStop = false;

      for (const ev of parseSse(joinChunks(capture))) {
        const d = tryJson(ev.data);
        if (d === undefined) continue;
        switch (ev.event ?? d?.type) {
          case 'message_start': {
            const m = d.message ?? {};
            turn.messageId = m.uuid ?? m.id ?? null;
            turn.model = m.model ?? turn.model;
            turn.parentMessageId = m.parent_message_uuid ?? m.parent_uuid ?? turn.parentMessageId;
            break;
          }
          case 'content_block_start': {
            const cb = d.content_block ?? {};
            blocks.set(d.index, { type: cb.type ?? 'unknown', text: '' });
            // File-creation tool results carry the produced files' metadata
            if (cb.type === 'tool_result' && cb.name === 'present_files') {
              for (const item of cb.content ?? []) {
                if (item?.file_path || item?.name) {
                  // item.name is a display name without extension — the path
                  // basename is what the download will actually be called
                  turn.generatedFiles.push({
                    name: String(item.file_path ?? '').split('/').pop() || item.name,
                    path: item.file_path ?? null,
                    mediaType: item.mime_type ?? null,
                  });
                }
              }
            }
            break;
          }
          case 'content_block_delta': {
            const block = blocks.get(d.index);
            if (!block) break;
            if (d.delta?.type === 'text_delta') block.text += d.delta.text ?? '';
            else if (d.delta?.type === 'thinking_delta') block.text += d.delta.thinking ?? '';
            else if (d.delta?.type === 'thinking_summary_delta') block.text += d.delta.summary?.summary ?? '';
            else if (d.delta?.type === 'input_json_delta' || d.delta?.type === 'tool_use_block_update_delta') {
              // tool-call plumbing, not turn content — excluded like thinking
            } else if (d.delta?.type) turn.warnings.push(`unknown delta type: ${d.delta.type}`);
            break;
          }
          case 'message_delta':
            turn.stopReason = d.delta?.stop_reason ?? turn.stopReason;
            break;
          case 'message_stop':
            sawStop = true;
            break;
          case 'content_block_stop':
          case 'conversation_ready':
          case 'message_limit':
          case 'ping':
            break;
          default:
            turn.warnings.push(`unknown event: ${ev.event ?? d?.type ?? '?'}`);
        }
      }

      const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
      // thinking blocks AND tool machinery — anything excluded from the output
      turn.thinkingPresent = ordered.some(b => b.type !== 'text');
      turn.outputText = ordered.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      turn.contentRefs = PUA_RE.test(turn.outputText);
      turn.complete = sawStop && Boolean(turn.outputText);
      if (!turn.messageId) turn.warnings.push('no message_start seen');
      return turn;
    },

    parseHistory(capture) {
      const body = tryJson(joinChunks(capture));
      if (!body?.chat_messages) return { warnings: ['no chat_messages in history body'], nodes: [] };
      return {
        conversationId: body.uuid ?? null,
        currentNode: body.current_leaf_message_uuid ?? null,
        nodes: body.chat_messages.map(m => ({
          id: m.uuid,
          parentId: m.parent_message_uuid ?? null,
          role: m.sender === 'human' ? 'user' : m.sender,
          text: (m.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim(),
          blockTypes: (m.content ?? []).map(b => b.type),
          createTime: m.created_at ?? null,
        })),
        warnings: [],
      };
    },
  };

  // ---------- Gemini ----------
  //
  // StreamGenerate over XHR: anti-XSSI ")]}'"  prefix, then length-prefixed
  // lines where each JSON line is a frame of [["wrb.fr", <rpc>, "<payload>"]]
  // envelopes and the payload is itself a JSON string. Frames are cumulative
  // snapshots, not deltas — the last parseable snapshot is the full answer.
  // Known payload paths: [1][0]=c_<conversationId>, [1][1]=r_<responseId>,
  // [4][0][0]=rc_<candidateId>, [4][0][1][0]=answer text.

  const gemini = {
    isCompletion(capture) {
      return ((capture.url ?? '').split('?')[0]).includes('StreamGenerate');
    },

    parseCompletion(capture) {
      const turn = baseTurn('gemini');

      // request: form-encoded, f.req=[null, "<inner json>"] — prompt at inner[0][0]
      try {
        const params = new URLSearchParams(capture.requestBody ?? '');
        const outer = tryJson(params.get('f.req'));
        const inner = typeof outer?.[1] === 'string' ? tryJson(outer[1]) : outer?.[1];
        const prompt = inner?.[0]?.[0];
        if (typeof prompt === 'string') turn.promptText = prompt;
        else turn.warnings.push('prompt not found at f.req[0][0]');
        // Uploads ride at f.req[0][3]: [[["<contrib-service ref>",1,null,"<mime>"],"<filename>"],...]
        // Text-only turns carry an explicit null there — provably no files.
        const atts = inner?.[0]?.[3];
        if (Array.isArray(atts)) {
          turn.declaredAttachments = atts.map(a => ({
            id: typeof a?.[0]?.[0] === 'string' ? a[0][0] : null,
            name: typeof a?.[1] === 'string' ? a[1] : null,
            sizeBytes: null,
            mediaType: typeof a?.[0]?.[3] === 'string' ? a[0][3] : null,
          })).filter(a => a.id || a.name);
          turn.attachmentCount = turn.declaredAttachments.length;
        } else if (Array.isArray(inner?.[0]) && inner[0].length > 3) {
          turn.attachmentCount = 0;
        }
      } catch {
        turn.warnings.push('unparseable request body');
      }
      const bl = ((capture.url ?? '').match(/[?&]bl=([^&]+)/) ?? [])[1];
      if (bl) turn.modelVersion = decodeURIComponent(bl);

      // response: collect wrb.fr payloads in order
      const payloads = [];
      const text = joinChunks(capture);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === ")]}'"  || /^\d+$/.test(trimmed)) continue;
        const frame = tryJson(trimmed);
        if (!Array.isArray(frame)) continue;
        for (const item of frame) {
          if (Array.isArray(item) && item[0] === 'wrb.fr' && typeof item[2] === 'string') {
            const payload = tryJson(item[2]);
            if (payload !== undefined) payloads.push(payload);
          }
        }
      }
      if (!payloads.length) {
        turn.warnings.push('no wrb.fr payloads parsed from stream');
        return turn;
      }

      // last snapshot with a candidate wins
      let best = null;
      for (const p of payloads) {
        const candidate = p?.[4]?.[0];
        if (Array.isArray(candidate) && typeof candidate[0] === 'string') best = p;
      }
      if (!best) {
        turn.warnings.push('no snapshot with candidates found');
        return turn;
      }
      turn.conversationId = typeof best?.[1]?.[0] === 'string' ? best[1][0] : null;
      turn.parentMessageId = null; // lineage lives in candidate ids (rc_*), not parents
      const responseId = typeof best?.[1]?.[1] === 'string' ? best[1][1] : null;
      const candidate = best[4][0];
      const candidateId = typeof candidate[0] === 'string' ? candidate[0] : null;
      turn.messageId = responseId ?? candidateId;
      turn.candidateId = candidateId;
      const answer = candidate?.[1]?.[0];
      if (typeof answer === 'string') {
        turn.outputText = answer.trim();
        turn.contentRefs = PUA_RE.test(turn.outputText);
      } else {
        turn.warnings.push('answer text not found at candidate[1][0]');
      }
      // Files Gemini offers for download appear in the snapshots as signed
      // usercontent.google.com URLs with a filename param — the only reliable
      // way to attribute the later download to this turn. Not every snapshot
      // carries them (later ones may drop the URL), so scan all of them.
      const scanFiles = x => {
        if (Array.isArray(x)) { x.forEach(scanFiles); return; }
        if (x !== null && typeof x === 'object') { Object.values(x).forEach(scanFiles); return; }
        if (typeof x !== 'string' || !x.includes('usercontent.google.com/download')) return;
        for (const m of x.matchAll(/https:\/\/[a-z0-9.-]+\.usercontent\.google\.com\/download\?[^"\s\\]+/g)) {
          try {
            const u = new URL(m[0]);
            const name = u.searchParams.get('filename');
            if (name && !turn.generatedFiles.some(f => f.url === m[0])) {
              turn.generatedFiles.push({ name, url: m[0] });
            }
          } catch { /* malformed url in payload */ }
        }
      };
      payloads.forEach(scanFiles);

      // Gemini exposes neither a model string nor a stop reason in this
      // stream; the bl= build label is the closest version marker.
      turn.warnings.push('model name not present in StreamGenerate payload');
      turn.complete = Boolean(turn.outputText) && !capture.error && !capture.truncated;
      return turn;
    },
  };

  return { chatgpt, claude, gemini, parseSse };
})();

if (typeof module !== 'undefined') module.exports = SigillTurnAdapters;
