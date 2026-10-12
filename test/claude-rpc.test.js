// claude.ai timeline stream suite. The fixture is a live StreamTimeline capture
// reduced to protobuf field trees; it is re-encoded here as Connect frames (gzip
// for timeline items, as the live stream does) and fed in arbitrary chunk sizes.
//
// Run: node test/claude-rpc.test.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const rpc = require('../lib/claude-rpc.js');

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

function varint(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}
function encode(tree) {
  const parts = [];
  for (const [f, v] of tree) {
    if (typeof v === 'number') { parts.push(varint(f * 8), varint(v)); continue; }
    const body = typeof v === 'string' ? Buffer.from(v, 'utf8') : encode(v);
    parts.push(varint(f * 8 + 2), varint(body.length), body);
  }
  return Buffer.concat(parts);
}
function frame(tree) {
  let body = encode(tree);
  const isItem = JSON.stringify(tree).startsWith('[[1,[[1,');
  if (isItem) body = zlib.gzipSync(body);
  const head = Buffer.alloc(5);
  head[0] = isItem ? 1 : 0;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'claude-rpc-timeline.json'), 'utf8'));
const stream = Buffer.concat([...fx.frames.map(frame), Buffer.from([2, 0, 0, 0, 2]), Buffer.from('{}')]);

async function feed(bytes, sizes) {
  const p = rpc.createParser();
  const turns = [];
  let i = 0, k = 0;
  while (i < bytes.length) {
    const n = sizes[k++ % sizes.length];
    turns.push(...await p.push(new Uint8Array(bytes.subarray(i, i + n))));
    i += n;
  }
  return { turns, warnings: p.warnings };
}

(async () => {
  console.log('stream path');
  check('StreamTimeline is recognised', rpc.isTimelineStream(fx.url));
  check('PerformAction is not', !rpc.isTimelineStream('https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction'));

  for (const [label, sizes] of [['whole stream', [stream.length]], ['7-byte chunks', [7]], ['mixed chunks', [1, 300, 13, 4096, 2]]]) {
    console.log(`turns (${label})`);
    const { turns, warnings } = await feed(stream, sizes);
    check('two answers completed while watching', turns.length === fx.expectTurns.length, `got ${turns.length}`);
    fx.expectTurns.forEach((want, n) => {
      const t = turns[n] ?? {};
      check(`turn ${n + 1}: message id`, t.messageId === want.messageId);
      check(`turn ${n + 1}: prompt from the parent message`, t.promptText === want.promptText, JSON.stringify(t.promptText));
      check(`turn ${n + 1}: answer text (snapshot + deltas)`, t.outputText === want.outputText, JSON.stringify(t.outputText?.slice(0, 60)));
      check(`turn ${n + 1}: complete, model, conversation`, t.complete && t.model === 'claude-opus-5-5' && t.conversationId === '73bd49e8-fb84-40d9-a1f2-e70f0261b8da');
    });
    check('thinking text is never part of the answer', turns.every(t => !/plankton/.test(t.promptText ?? '')));
    check('no unreadable frames', warnings.length === 0, warnings.join('; '));
  }

  console.log('history replay');
  {
    // Opening an existing conversation replays messages already complete: nothing is recorded.
    const completeOnly = fx.frames.filter(f => /\[7,1\]/.test(JSON.stringify(f)));
    const { turns } = await feed(Buffer.concat(completeOnly.map(frame)), [64]);
    check('a completed message seen only as history is not a new turn', turns.length === 0, `got ${turns.length}`);
  }

  console.log('robustness');
  {
    const p = rpc.createParser();
    const junk = Buffer.concat([Buffer.from([1, 0, 0, 0, 4]), Buffer.from('nope'), frame(fx.frames[3])]);
    const turns = await p.push(new Uint8Array(junk));
    check('a corrupt frame is skipped with a warning, the next one still parsed', turns.length === 0 && p.warnings.length === 1);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
