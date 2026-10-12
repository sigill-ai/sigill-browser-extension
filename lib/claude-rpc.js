// claude.ai timeline stream (October 2026 transport): the answer to a prompt no
// longer arrives as SSE from /completion but on a long-lived Connect server stream,
//   POST /claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline
//   application/connect+proto — frames of [flags u8][length u32 BE][protobuf],
//   flags & 0x01 = gzip-compressed message, flags & 0x02 = end-of-stream trailer.
// One stream stays open for the conversation and carries every turn, so it is
// parsed incrementally and emits a TurnRecord (lib/turn-adapters.js shape) each
// time an assistant message completes.
//
// There is no published schema; field numbers were read off live traffic
// (test/vectors/claude-rpc-timeline.json):
//   StreamTimelineResponse.1            event
//     event.1                           timeline item
//       item.2  conversation            .1 id, .6.2 model
//       item.3  message                 .1 id, .2 conversation id, .3 sender (1 human, 2 assistant),
//                                       .4 index, .7 = 1 complete, .11 parent message id
//       item.4  content group           .1 group id, .2 message id
//       item.5  content block           .1 block id, .2 group id, .9 text so far (snapshot),
//                                       .10.1 block kind (2 text, 1 thinking)
//     event.2   text delta              .1 block id, .2 appended text
//     event.6   heartbeat
// Unknown shapes degrade loudly (warnings), and a turn is emitted only for an
// assistant message this stream saw being produced — never for history replayed
// when a conversation is opened.
//
// Pure: no chrome.* — loadable from the service worker and from Node. Needs
// DecompressionStream (service workers, Node 18+).

const SigillClaudeRpc = (() => {
  const STREAM_PATH = /\/claudeai-rpc\/anthropic\.bard\.api\.v[0-9a-z]+\.ConversationService\/StreamTimeline$/;

  function isTimelineStream(url) {
    try { return STREAM_PATH.test(new URL(url).pathname); } catch { return false; }
  }

  // ---------- protobuf wire format (schema-less) ----------

  function varint(b, i) {
    let r = 0, s = 0, x;
    do {
      if (i >= b.length) throw new Error('truncated varint');
      x = b[i++];
      r += (x & 0x7f) * 2 ** s;
      s += 7;
    } while (x & 0x80);
    return [r, i];
  }

  // Map of field number → array of values (Uint8Array for length-delimited, number for varint).
  function fields(b) {
    const out = new Map();
    let i = 0;
    while (i < b.length) {
      let key;
      [key, i] = varint(b, i);
      const f = Math.floor(key / 8), w = key & 7;
      if (f === 0) throw new Error('field 0');
      let v;
      if (w === 0) [v, i] = varint(b, i);
      else if (w === 2) {
        let l;
        [l, i] = varint(b, i);
        if (i + l > b.length) throw new Error('truncated field');
        v = b.subarray(i, i + l);
        i += l;
      } else if (w === 1) { i += 8; continue; }
      else if (w === 5) { i += 4; continue; }
      else throw new Error(`wire type ${w}`);
      if (!out.has(f)) out.set(f, []);
      out.get(f).push(v);
    }
    return out;
  }

  const td = new TextDecoder('utf-8');
  const first = (m, f) => m.get(f)?.[0];
  const str = (m, f) => { const v = first(m, f); return v instanceof Uint8Array ? td.decode(v) : null; };
  const num = (m, f) => { const v = first(m, f); return typeof v === 'number' ? v : null; };
  const sub = (m, f) => { const v = first(m, f); return v instanceof Uint8Array ? fields(v) : null; };
  const subs = (m, f) => (m.get(f) ?? []).filter(v => v instanceof Uint8Array).map(fields);

  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---------- stream state ----------

  function createParser() {
    let buf = new Uint8Array(0);
    let conversationModel = null;
    const messages = new Map(); // id → { sender, conversationId, parentId, complete, seenOpen, emitted }
    const groups = new Map();   // group id → message id
    const blocks = new Map();   // block id → { groupId, kind, text, order }
    let order = 0;
    const warnings = [];

    function message(id) {
      if (!messages.has(id)) messages.set(id, { sender: null, conversationId: null, parentId: null, complete: false, seenOpen: false, emitted: false });
      return messages.get(id);
    }

    function textOf(messageId, kind) {
      return [...blocks.values()]
        .filter(b => groups.get(b.groupId) === messageId && b.kind === kind)
        .sort((a, b) => a.order - b.order)
        .map(b => b.text)
        .join('\n')
        .trim();
    }

    function onItem(item, done) {
      const conv = sub(item, 2);
      if (conv) {
        const model = str(sub(conv, 6) ?? new Map(), 2);
        if (model) conversationModel = model;
      }
      for (const m of subs(item, 3)) {
        const id = str(m, 1);
        if (!id) continue;
        const rec = message(id);
        rec.sender = num(m, 3) ?? rec.sender ?? 1; // proto3 default: an absent sender is the first enum value
        rec.conversationId = str(m, 2) ?? rec.conversationId;
        rec.parentId = str(m, 11) ?? rec.parentId;
        const complete = num(m, 7) === 1;
        if (!complete) rec.seenOpen = true;
        if (complete && !rec.complete) {
          rec.complete = true;
          if (rec.sender === 2) done.push(id);
        }
      }
      for (const g of subs(item, 4)) {
        const id = str(g, 1), msg = str(g, 2);
        if (id && msg) groups.set(id, msg);
      }
      for (const b of subs(item, 5)) {
        const id = str(b, 1);
        if (!id) continue;
        if (!blocks.has(id)) blocks.set(id, { groupId: null, kind: null, text: '', order: order++ });
        const blk = blocks.get(id);
        blk.groupId = str(b, 2) ?? blk.groupId;
        const kind = num(sub(b, 10) ?? new Map(), 1);
        if (kind !== null) blk.kind = kind;
        const text = str(b, 9);
        if (text !== null) blk.text = text; // snapshot: the block's text so far
      }
    }

    function onEvent(ev, done) {
      const item = sub(ev, 1);
      if (item) onItem(item, done);
      for (const d of subs(ev, 2)) {
        const blk = blocks.get(str(d, 1));
        const delta = str(d, 2);
        if (blk && delta) blk.text += delta;
      }
    }

    function turnFor(id) {
      const m = messages.get(id);
      const parent = m.parentId ? messages.get(m.parentId) : null;
      const outputText = textOf(id, 2);
      const turn = {
        platform: 'claude',
        conversationId: m.conversationId,
        messageId: id,
        parentMessageId: m.parentId,
        action: null,
        model: conversationModel,
        modelVersion: null,
        promptMessageId: parent?.sender === 1 ? m.parentId : null,
        promptText: parent?.sender === 1 ? (textOf(m.parentId, 2) || null) : null,
        outputText,
        thinkingPresent: textOf(id, 1).length > 0,
        contentRefs: false,
        stopReason: null,
        complete: Boolean(outputText),
        attachmentCount: null,
        generatedFiles: [],
        warnings: [...warnings],
      };
      if (!outputText) turn.warnings.push('assistant message completed without text blocks');
      return turn;
    }

    // Feed raw stream bytes; returns the turns completed by them.
    async function push(bytes) {
      const merged = new Uint8Array(buf.length + bytes.length);
      merged.set(buf);
      merged.set(bytes, buf.length);
      buf = merged;
      const done = [];
      let pos = 0;
      while (pos + 5 <= buf.length) {
        const flags = buf[pos];
        const len = ((buf[pos + 1] << 24) >>> 0) + (buf[pos + 2] << 16) + (buf[pos + 3] << 8) + buf[pos + 4];
        if (pos + 5 + len > buf.length) break;
        let body = buf.subarray(pos + 5, pos + 5 + len);
        pos += 5 + len;
        if (flags & 0x02) continue; // end-of-stream trailer (JSON)
        try {
          if (flags & 0x01) body = await gunzip(body);
          const top = fields(body);
          for (const ev of subs(top, 1)) onEvent(ev, done);
        } catch (err) {
          if (warnings.length < 20) warnings.push(`unreadable frame: ${err.message}`);
        }
      }
      buf = buf.slice(pos);
      const turns = [];
      for (const id of done) {
        const m = messages.get(id);
        // Only answers produced while this stream watched: history replayed on
        // open arrives already complete and is never recorded as new.
        if (m.emitted || !m.seenOpen) continue;
        m.emitted = true;
        turns.push(turnFor(id));
      }
      return turns;
    }

    return { push, get warnings() { return warnings; } };
  }

  return { isTimelineStream, createParser, fields };
})();

if (typeof module !== 'undefined') module.exports = SigillClaudeRpc;
