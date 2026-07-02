// Adapter regression suite — runs lib/turn-adapters.js against real captured
// traffic in test/fixtures/. Central check: the answer text reconstructed
// from each completion *stream* must equal the text the platform's own
// *history endpoint* reports for the same message ID — two independent
// sources agreeing.
//
// Run: node test/adapters.test.js

const fs = require('fs');
const path = require('path');
const adapters = require('../lib/turn-adapters.js');

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function noUnknownWarnings(label, turn) {
  const unknown = turn.warnings.filter(w => /^(unknown|unparseable|unrecognized)/.test(w));
  check(`${label}: no unknown-shape warnings`, unknown.length === 0, unknown.join('; '));
}

// ---------- ChatGPT: basic ----------
console.log('\nchatgpt-basic.json');
{
  const fixtures = load('chatgpt-basic.json');
  const completions = fixtures.filter(c => adapters.chatgpt.isCompletion(c));
  eq('one completion stream', completions.length, 1);
  const turn = adapters.chatgpt.parseCompletion(completions[0]);
  eq('platform', turn.platform, 'chatgpt');
  eq('prompt', turn.promptText, 'hello, give me a timestamp.');
  eq('action', turn.action, 'next');
  eq('conversationId', turn.conversationId, '6a458172-d3f4-83ed-9710-110eb1417821');
  eq('model from stream', turn.model, 'gpt-5-5-thinking');
  eq('messageId', turn.messageId, '17cd8dfa-ef42-494c-bc08-215f923c22cc');
  check('output starts with the timestamp', turn.outputText.startsWith('2026-07-01T23:07:00+02:00'), turn.outputText.slice(0, 60));
  check('widget ref detected', turn.contentRefs === true);
  check('tool/thinking machinery flagged', turn.thinkingPresent === true);
  check('complete', turn.complete === true);
  eq('attachmentCount unknown (no metadata.attachments key)', turn.attachmentCount, null);
  noUnknownWarnings('basic turn', turn);
}

// ---------- ChatGPT: lineage (baseline, follow-up, regenerate, edit) ----------
console.log('\nchatgpt-lineage.json');
{
  const fixtures = load('chatgpt-lineage.json');
  const completions = fixtures.filter(c => adapters.chatgpt.isCompletion(c));
  eq('four completion streams', completions.length, 4);
  const turns = completions.map(c => adapters.chatgpt.parseCompletion(c));
  const [baseline, followup, regen, edit] = turns;

  eq('baseline action', baseline.action, 'next');
  eq('baseline prompt', baseline.promptText, 'name three colors');
  eq('followup prompt', followup.promptText, 'now three animals');
  check('followup parent is a real message id', /^[0-9a-f-]{36}$/.test(followup.parentMessageId ?? ''), followup.parentMessageId);

  eq('regenerate action', regen.action, 'variant');
  eq('regenerate has no new prompt', regen.promptText, null);
  eq('regenerate parent = follow-up user message', regen.parentMessageId, followup.promptMessageId);
  check('regenerate produced a different message id', regen.messageId && regen.messageId !== followup.messageId);

  eq('edit action', edit.action, 'next');
  eq('edit prompt', edit.promptText, 'name four colors');
  check('edit is a new user message id', edit.promptMessageId && edit.promptMessageId !== baseline.promptMessageId);

  for (const [i, t] of turns.entries()) {
    check(`turn ${i} complete`, t.complete === true, t.warnings.join('; '));
    noUnknownWarnings(`turn ${i}`, t);
  }

  // Cross-validation: stream-reconstructed text vs history-tree text
  const historyCapture = fixtures.find(c => adapters.chatgpt.isHistory(c));
  check('history capture present', Boolean(historyCapture));
  const history = adapters.chatgpt.parseHistory(historyCapture);
  check('history has nodes', history.nodes.length > 0);
  const byId = new Map(history.nodes.map(n => [n.id, n]));
  for (const [i, t] of turns.entries()) {
    const node = byId.get(t.messageId);
    check(`turn ${i}: answer message id exists in history tree`, Boolean(node), t.messageId);
    if (node) {
      eq(`turn ${i}: stream text == history text`, t.outputText, node.text);
      eq(`turn ${i}: stream model == history model`, t.model, node.modelSlug);
    }
    if (t.promptMessageId) {
      const promptNode = byId.get(t.promptMessageId);
      check(`turn ${i}: prompt message id exists in history tree`, Boolean(promptNode), t.promptMessageId);
      if (promptNode) eq(`turn ${i}: prompt text == history text`, t.promptText, promptNode.text);
    }
  }
  // The regenerate and the original answer must be siblings under the same prompt
  const regenNode = byId.get(regen.messageId);
  const followupAnswerNode = byId.get(followup.messageId);
  check('regenerate + original are on branches of the same prompt subtree',
    Boolean(regenNode && followupAnswerNode) && regen.parentMessageId === followup.promptMessageId);
}

// ---------- ChatGPT: attachment upload ----------
console.log('\nchatgpt-upload.json');
{
  const fixtures = load('chatgpt-upload.json');
  const completions = fixtures.filter(c => adapters.chatgpt.isCompletion(c));
  eq('one completion stream', completions.length, 1);
  const turn = adapters.chatgpt.parseCompletion(completions[0]);
  eq('attachmentCount declared', turn.attachmentCount, 1);
  check('declared attachment descriptor', Boolean(turn.declaredAttachments?.[0]?.id), JSON.stringify(turn.declaredAttachments));
  eq('declared size', turn.declaredAttachments[0].sizeBytes, 140565);
  eq('declared media type', turn.declaredAttachments[0].mediaType, 'image/png');
  check('prompt excludes asset-pointer part', typeof turn.promptText === 'string' && !turn.promptText.includes('asset_pointer'));
  check('complete', turn.complete === true, turn.warnings.join('; '));
  noUnknownWarnings('upload turn', turn);
}

// ---------- ChatGPT: code-interpreter file generation ----------
console.log('\nchatgpt-filegen.json');
{
  const fixtures = load('chatgpt-filegen.json');
  const completions = fixtures.filter(c => adapters.chatgpt.isCompletion(c));
  eq('three completion streams', completions.length, 3);
  const turns = completions.map(c => adapters.chatgpt.parseCompletion(c));
  for (const [i, t] of turns.entries()) {
    check(`turn ${i} complete`, t.complete === true, t.warnings.join('; '));
    noUnknownWarnings(`filegen turn ${i}`, t);
  }
  const fileTurn = turns.at(-1);
  check('tool machinery flagged on interpreter turn', fileTurn.thinkingPresent === true);
  check('final answer is the sandbox download link',
    fileTurn.outputText.includes('sandbox:/mnt/data/us_presidents.txt'), fileTurn.outputText.slice(0, 80));
  check('generated file declared from sandbox link',
    fileTurn.generatedFiles.some(f => f.name === 'us_presidents.txt' && f.path === '/mnt/data/us_presidents.txt'),
    JSON.stringify(fileTurn.generatedFiles));
  check('interpreter/download is not treated as a completion',
    !fixtures.some(c => (c.url ?? '').includes('/interpreter/download') && adapters.chatgpt.isCompletion(c)));
}

// ---------- Claude ----------
console.log('\nclaude-basic.json');
{
  const fixtures = load('claude-basic.json');
  const completions = fixtures.filter(c => adapters.claude.isCompletion(c));
  eq('one completion stream', completions.length, 1);
  const turn = adapters.claude.parseCompletion(completions[0]);
  eq('platform', turn.platform, 'claude');
  eq('prompt', turn.promptText, 'hello');
  eq('model', turn.model, 'claude-haiku-4-5-20251001');
  eq('stopReason', turn.stopReason, 'end_turn');
  check('thinking present and excluded', turn.thinkingPresent === true && !/thinking/i.test(turn.outputText));
  check('complete', turn.complete === true, turn.warnings.join('; '));
  eq('attachmentCount provably zero (request declares arrays)', turn.attachmentCount, 0);
  noUnknownWarnings('claude turn', turn);

  const historyCapture = fixtures.find(c => adapters.claude.isHistory(c));
  check('history capture present', Boolean(historyCapture));
  const history = adapters.claude.parseHistory(historyCapture);
  eq('history conversation matches stream', history.conversationId, turn.conversationId);
  const node = history.nodes.find(n => n.id === turn.messageId);
  check('answer message id exists in history', Boolean(node), turn.messageId);
  if (node) {
    eq('stream text == history text', turn.outputText, node.text);
    check('history confirms thinking block', node.blockTypes.includes('thinking'));
  }
  const userNode = history.nodes.find(n => n.role === 'user');
  check('history links answer to prompt', Boolean(node && userNode) && node.parentId === userNode.id);
}

// ---------- Claude: CRLF stream framing (July 2026 serving change) ----------
console.log('\nclaude-crlf.json');
{
  const fixtures = load('claude-crlf.json');
  const turn = adapters.claude.parseCompletion(fixtures.find(c => adapters.claude.isCompletion(c)));
  check('CRLF-framed stream parses complete', turn.complete === true, turn.warnings.join('; '));
  eq('model', turn.model, 'claude-fable-5');
  eq('output', turn.outputText, 'Hi Raymond! What can I help you with today?');
  check('parent lineage from parent_uuid', /^[0-9a-f-]{36}$/.test(turn.parentMessageId ?? ''), turn.parentMessageId);
  noUnknownWarnings('crlf turn', turn);
  const history = adapters.claude.parseHistory(fixtures.find(c => adapters.claude.isHistory(c)));
  check('stream uuid exists in history', history.nodes.some(n => n.id === turn.messageId));
}

// ---------- Claude + Gemini: file generation ----------
console.log('\nfilegen-claude-gemini.json');
{
  const fixtures = load('filegen-claude-gemini.json');

  const claudeTurns = fixtures.filter(c => adapters.claude.isCompletion(c)).map(c => adapters.claude.parseCompletion(c));
  eq('one claude completion', claudeTurns.length, 1);
  const ct = claudeTurns[0];
  check('claude turn complete', ct.complete === true, ct.warnings.join('; '));
  noUnknownWarnings('claude filegen turn', ct);
  check('tool machinery flagged', ct.thinkingPresent === true);
  check('tool plumbing excluded from output', ct.outputText.startsWith('Done!'), ct.outputText.slice(0, 60));
  check('claude generated file declared (present_files)',
    ct.generatedFiles.some(f => f.name === 'names.txt' && f.path === '/mnt/user-data/outputs/names.txt' && f.mediaType === 'text/plain'),
    JSON.stringify(ct.generatedFiles));

  const geminiTurns = fixtures.filter(c => adapters.gemini.isCompletion(c)).map(c => adapters.gemini.parseCompletion(c));
  eq('one gemini completion', geminiTurns.length, 1);
  const gt = geminiTurns[0];
  check('gemini turn complete', gt.complete === true, gt.warnings.join('; '));
  check('gemini generated file declared (signed usercontent url)',
    gt.generatedFiles.some(f => f.name === 'male_names.txt' && /usercontent\.google\.com\/download/.test(f.url ?? '')),
    JSON.stringify(gt.generatedFiles.map(f => f.name)));
}

// ---------- Full loop: uploads + generated files, all platforms ----------
console.log('\nfullloop.json');
{
  const fixtures = load('fullloop.json');
  const byPlatform = {};
  for (const platform of ['claude', 'chatgpt', 'gemini']) {
    byPlatform[platform] = fixtures.filter(c => adapters[platform].isCompletion(c)).map(c => adapters[platform].parseCompletion(c));
    eq(`${platform}: two completions`, byPlatform[platform].length, 2);
    for (const [i, t] of byPlatform[platform].entries()) {
      check(`${platform} turn ${i} complete`, t.complete === true, t.warnings.join('; '));
      noUnknownWarnings(`${platform} turn ${i}`, t);
    }
  }
  const [claudeUp, claudeGen] = byPlatform.claude;
  eq('claude upload: count', claudeUp.attachmentCount, 1);
  check('claude upload: file uuid declared', /^[0-9a-f-]{36}$/.test(claudeUp.declaredAttachments?.[0]?.id ?? ''),
    JSON.stringify(claudeUp.declaredAttachments));
  check('claude filegen declared', claudeGen.generatedFiles.some(f => f.name === 'joke.txt'));

  const [gptUp, gptGen] = byPlatform.chatgpt;
  eq('chatgpt upload: count', gptUp.attachmentCount, 1);
  eq('chatgpt upload: declared size', gptUp.declaredAttachments?.[0]?.sizeBytes, 137635);
  check('chatgpt filegen declared', gptGen.generatedFiles.some(f => f.name === 'programmer_joke.txt'));

  const [gemUp, gemGen] = byPlatform.gemini;
  eq('gemini upload: count', gemUp.attachmentCount, 1);
  eq('gemini upload: declared name', gemUp.declaredAttachments?.[0]?.name, 'image_5f1d74.png');
  eq('gemini upload: declared media type', gemUp.declaredAttachments?.[0]?.mediaType, 'image/png');
  check('gemini filegen declared', gemGen.generatedFiles.some(f => f.name === 'basketball_bear_joke.txt'));
}

// ---------- Gemini ----------
console.log('\ngemini-basic.json');
{
  const fixtures = load('gemini-basic.json');
  const completions = fixtures.filter(c => adapters.gemini.isCompletion(c));
  eq('one completion stream', completions.length, 1);
  const turn = adapters.gemini.parseCompletion(completions[0]);
  eq('platform', turn.platform, 'gemini');
  eq('prompt', turn.promptText, 'hello there');
  check('conversationId is a c_ id', (turn.conversationId ?? '').startsWith('c_'), turn.conversationId);
  check('messageId is an r_ id', (turn.messageId ?? '').startsWith('r_'), turn.messageId);
  check('candidateId is an rc_ id', (turn.candidateId ?? '').startsWith('rc_'), turn.candidateId);
  check('output text present', turn.outputText.startsWith('Hello there!'), turn.outputText.slice(0, 60));
  check('server build recorded', (turn.modelVersion ?? '').includes('bard-web-server'), turn.modelVersion);
  eq('text-only turn: attachmentCount provably zero', turn.attachmentCount, 0);
  check('complete', turn.complete === true, turn.warnings.join('; '));
  const unexpected = turn.warnings.filter(w => w !== 'model name not present in StreamGenerate payload');
  check('no unexpected warnings', unexpected.length === 0, unexpected.join('; '));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
