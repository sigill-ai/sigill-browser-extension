// Envelope regression suite — builds AiEvidenceEnvelopeV1 envelopes from every
// completion turn in test/fixtures/ and validates them against the schema in
// spec/ai-evidence-envelope.v1.json (structural checks: required fields,
// additionalProperties, payloadRef oneOf), plus hash determinism.
//
// Run: node test/envelope.test.js

const fs = require('fs');
const path = require('path');
const adapters = require('../lib/turn-adapters.js');
const evidence = require('../lib/evidence-envelope.js');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'ai-evidence-envelope.v1.json'), 'utf8'));

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

// Structural validation against the schema object itself, so schema edits
// propagate to the tests without rewriting assertions.
function validateEnvelope(label, env) {
  const problems = [];
  for (const key of schema.required) {
    if (!(key in env)) problems.push(`missing required: ${key}`);
  }
  const allowed = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(env)) {
    if (!allowed.has(key)) problems.push(`additionalProperty at top level: ${key}`);
  }
  for (const section of ['purpose', 'actor', 'activity', 'model', 'integrity', 'processingMetadata']) {
    if (!(section in env)) continue;
    const sub = schema.properties[section];
    for (const key of sub.required ?? []) {
      if (!(key in env[section])) problems.push(`${section}: missing required ${key}`);
    }
    if (sub.additionalProperties === false) {
      const subAllowed = new Set(Object.keys(sub.properties));
      for (const key of Object.keys(env[section])) {
        if (!subAllowed.has(key)) problems.push(`${section}: additionalProperty ${key}`);
      }
    }
  }
  const payloadRefs = [
    ...['prompt', 'output'].filter(k => k in env).map(k => [k, env[k]]),
    ...(env.inputs ?? []).map((ref, i) => [`inputs[${i}]`, ref]),
    ...(env.outputArtifacts ?? []).map((ref, i) => [`outputArtifacts[${i}]`, ref]),
  ];
  for (const [refName, ref] of payloadRefs) {
    const hasInline = 'inline' in ref;
    const hasHash = 'hash' in ref;
    if (hasInline === hasHash) problems.push(`${refName}: exactly one of inline|hash required`);
    if (hasHash && !('ref' in ref)) problems.push(`${refName}: hash without ref`);
    if (hasHash && !/^[0-9a-f]+$/.test(ref.hash.hex ?? '')) problems.push(`${refName}: hash.hex not lowercase hex`);
    const refAllowed = new Set(Object.keys(schema.$defs.payloadRef.properties));
    for (const key of Object.keys(ref)) {
      if (!refAllowed.has(key)) problems.push(`${refName}: additionalProperty ${key}`);
    }
  }
  if (env.actor && ['user', 'service', 'system'].indexOf(env.actor.type) === -1) {
    problems.push(`actor.type invalid: ${env.actor.type}`);
  }
  if (env.processingMetadata?.durationMs !== undefined) {
    const d = env.processingMetadata.durationMs;
    if (!Number.isInteger(d) || d < 0) problems.push(`durationMs not a non-negative integer: ${d}`);
  }
  check(`${label}: schema-valid`, problems.length === 0, problems.join('; '));
}

const ACTOR = { type: 'user', id: 'ext-test-device' };
const FIXED = { evidenceId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-07-02T00:00:00Z' };

async function main() {
  const cases = [];
  for (const [file, platforms] of [
    ['chatgpt-basic.json', ['chatgpt']],
    ['chatgpt-lineage.json', ['chatgpt']],
    ['chatgpt-filegen.json', ['chatgpt']],
    ['claude-basic.json', ['claude']],
    ['gemini-basic.json', ['gemini']],
    ['filegen-claude-gemini.json', ['claude', 'gemini']],
  ]) {
    const fixtures = load(file);
    for (const platform of platforms) {
      for (const capture of fixtures.filter(c => adapters[platform].isCompletion(c))) {
        cases.push({ file, platform, capture, turn: adapters[platform].parseCompletion(capture) });
      }
    }
  }
  check('all fixture turns collected', cases.length === 12, `got ${cases.length}`);

  for (const [i, { file, platform, capture, turn }] of cases.entries()) {
    const label = `${file}#${i} (${platform}, ${turn.action ?? '?'})`;
    console.log(`\n${label}`);
    const env = evidence.buildTurnEnvelope({
      turn, capture, actor: ACTOR, extensionVersion: '0.2.0-test', ...FIXED,
    });

    check('output inline is the turn text', env.output.inline === turn.outputText);
    check('capture disclosure present', env.output.metadata?.capture?.method === 'network');
    check('actor.id present', typeof env.actor.id === 'string' && env.actor.id.length > 0);
    check('real model recorded', env.model.name === (turn.model ?? 'unknown'), env.model.name);
    if (turn.action === 'variant') {
      check('variant omits prompt', !('prompt' in env));
      check('variant records parent lineage', typeof env.output.metadata.parentMessageId === 'string');
    } else {
      check('prompt inline matches turn', env.prompt?.inline === turn.promptText);
    }
    if (capture.durationMs != null) {
      check('processing duration recorded', env.processingMetadata?.durationMs === capture.durationMs);
    }
    if (turn.generatedFiles.length) {
      const gf = env.output.metadata.generatedFiles;
      check('generated files declared in metadata', gf?.length === turn.generatedFiles.length, JSON.stringify(gf));
      check('signed URLs never enter the envelope', (gf ?? []).every(f => !('url' in f)));
    }

    // Hash determinism + proof-independence: attaching envelopeHash and proofs
    // must not change the canonical hash (spec §4).
    const h1 = await evidence.envelopeHashHex(env);
    env.integrity.envelopeHash = { alg: 'SHA-256', hex: h1 };
    env.proofs = [{ type: 'rfc3161', tsrBase64: 'dGVzdA==' }];
    const h2 = await evidence.envelopeHashHex(env);
    check('hash is 64 hex chars', /^[0-9a-f]{64}$/.test(h1), h1);
    check('hash unchanged after attaching hash+proofs', h1 === h2);

    // Validate the finished artifact — hash and proofs attached, as logged.
    validateEnvelope(label, env);
  }

  // Attachments become hash-only inputs
  console.log('\nattachments -> inputs');
  {
    const { capture, turn } = cases.find(c => c.platform === 'claude');
    const env = evidence.buildTurnEnvelope({
      turn, capture, actor: ACTOR, extensionVersion: '0.2.0-test', ...FIXED,
      attachments: [{
        name: 'contract.pdf',
        sizeBytes: 48213,
        mediaType: 'application/pdf',
        sha256: 'a'.repeat(64),
        source: 'file-input',
        observedAt: '2026-07-02T00:00:00Z',
      }],
    });
    env.integrity.envelopeHash = { alg: 'SHA-256', hex: await evidence.envelopeHashHex(env) };
    validateEnvelope('attachment envelope', env);
    check('one input recorded', env.inputs?.length === 1);
    check('input is hash-only (no inline)', !('inline' in env.inputs[0]) && env.inputs[0].hash.hex === 'a'.repeat(64));
    check('input carries size + filename', env.inputs[0].hash.sizeBytes === 48213 && env.inputs[0].metadata.filename === 'contract.pdf');
    check('no attachments -> no inputs key', !('inputs' in evidence.buildTurnEnvelope({
      turn, capture, actor: ACTOR, extensionVersion: '0.2.0-test', ...FIXED, attachments: [],
    })));
  }

  // 1:1 binding when the platform declares only a file id (Claude)
  console.log('\nattachment binding: unambiguous 1:1 (id-only declaration)');
  {
    const fixtures = load('fullloop.json');
    const capture = fixtures.filter(c => adapters.claude.isCompletion(c))[0];
    const turn = adapters.claude.parseCompletion(capture);
    const env = evidence.buildTurnEnvelope({
      turn, capture, actor: ACTOR, extensionVersion: '0.4.0-test', ...FIXED,
      attachments: [{
        name: 'bear.png', sizeBytes: 137635, mediaType: 'image/png',
        sha256: 'e'.repeat(64), source: 'file-input', observedAt: '2026-07-02T00:00:00Z',
      }],
    });
    check('bound via 1:1 fallback', /^[0-9a-f-]{36}$/.test(env.inputs?.[0]?.metadata?.platformFileId ?? ''),
      JSON.stringify(env.inputs?.[0]?.metadata));
  }

  // Observed hash binds to the platform-declared file by size
  console.log('\nattachment binding (upload fixture)');
  {
    const fixtures = load('chatgpt-upload.json');
    const capture = fixtures.find(c => adapters.chatgpt.isCompletion(c));
    const turn = adapters.chatgpt.parseCompletion(capture);
    const env = evidence.buildTurnEnvelope({
      turn, capture, actor: ACTOR, extensionVersion: '0.2.0-test', ...FIXED,
      attachments: [{
        name: 'image.png',            // pasted name differs from platform name
        sizeBytes: 140565,
        mediaType: 'image/png',
        sha256: 'b'.repeat(64),
        source: 'paste',
        observedAt: '2026-07-02T00:00:00Z',
      }],
    });
    env.integrity.envelopeHash = { alg: 'SHA-256', hex: await evidence.envelopeHashHex(env) };
    validateEnvelope('upload envelope', env);
    const input = env.inputs?.[0];
    check('bound to platform file id', (input?.metadata?.platformFileId ?? '').startsWith('file_'), JSON.stringify(input?.metadata));
    check('platform name recorded when it differs', input?.metadata?.platformFileName === 'image(34).png');
    check('declared count in output metadata', env.output.metadata.attachmentsDeclared === 1);
  }

  // Artifact envelopes — both honesty classes
  console.log('\nartifact envelope: bytes observed (blob hash)');
  {
    const env = evidence.buildArtifactEnvelope({
      platform: 'chatgpt',
      artifact: {
        filename: 'us_presidents.txt', sizeBytes: 74, mediaType: 'text/plain',
        sha256: 'c'.repeat(64), sourceUrl: 'blob:(client-generated)', downloadedAt: '2026-07-02T06:00:00Z',
      },
      link: {
        conversationId: '6a45f9b8-ed78-83eb-9502-9defd13a86ab',
        messageId: 'ad3ef014-92a4-4857-9ed0-654b3bf700f7',
        sandboxPath: '/mnt/data/us_presidents.txt',
        parentEvidenceId: '00000000-0000-4000-8000-000000000009',
      },
      model: { provider: 'openai', name: 'gpt-5-5-thinking' },
      actor: ACTOR, extensionVersion: '0.4.0-test', ...FIXED,
    });
    env.integrity.envelopeHash = { alg: 'SHA-256', hex: await evidence.envelopeHashHex(env) };
    validateEnvelope('hashed artifact', env);
    check('links parent evidence', env.activity.parentEvidenceId === '00000000-0000-4000-8000-000000000009');
    check('artifact is a binary hash ref', env.outputArtifacts[0].hash?.hex === 'c'.repeat(64) && !('inline' in env.outputArtifacts[0]));
    check('inherits parent model', env.model.name === 'gpt-5-5-thinking');
    check('hashSource disclosed', env.outputArtifacts[0].metadata.hashSource === 'blob-observed');
  }

  console.log('\nartifact envelope: refetch class');
  {
    const env = evidence.buildArtifactEnvelope({
      platform: 'chatgpt',
      artifact: {
        filename: 'male_names.txt', sizeBytes: 18, mediaType: 'text/plain',
        sha256: 'd'.repeat(64), hashSource: 'refetch',
        sourceUrl: 'https://chatgpt.com/backend-api/estuary/content', downloadedAt: '2026-07-02T06:00:00Z',
      },
      link: {
        conversationId: '6a45fc6f-bc2c-83eb-bdbb-f0d9aa05fdd0',
        messageId: 'e2d6cb0a-63c3-4a92-91c0-867cb23b49ed',
        sandboxPath: '/mnt/data/male_names.txt',
        platformFileId: 'file_00000000289c720abdedaf1190eb6e0b',
        parentEvidenceId: '00000000-0000-4000-8000-000000000009',
      },
      model: { provider: 'openai', name: 'gpt-5-5-thinking' },
      actor: ACTOR, extensionVersion: '0.4.0-test', ...FIXED,
    });
    env.integrity.envelopeHash = { alg: 'SHA-256', hex: await evidence.envelopeHashHex(env) };
    validateEnvelope('refetch artifact', env);
    check('hashSource is refetch', env.outputArtifacts[0].metadata.hashSource === 'refetch');
    check('refetch limitation stated', /does not byte-verify/.test(env.outputArtifacts[0].metadata.note ?? ''));
    check('platform file id bound', env.outputArtifacts[0].metadata.platformFileId === 'file_00000000289c720abdedaf1190eb6e0b');
  }

  console.log('\nartifact envelope: bytes NOT observed (event only)');
  {
    const env = evidence.buildArtifactEnvelope({
      platform: 'chatgpt',
      artifact: {
        filename: 'us_presidents.txt', sizeBytes: 74, mediaType: 'text/plain',
        sha256: null, sourceUrl: 'https://files.example.com/download/abc', downloadedAt: '2026-07-02T06:00:00Z',
      },
      link: { conversationId: '6a45f9b8-ed78-83eb-9502-9defd13a86ab', messageId: null, sandboxPath: null, parentEvidenceId: null },
      model: null,
      actor: ACTOR, extensionVersion: '0.4.0-test', ...FIXED,
    });
    env.integrity.envelopeHash = { alg: 'SHA-256', hex: await evidence.envelopeHashHex(env) };
    validateEnvelope('event-only artifact', env);
    check('no parentEvidenceId key when unknown', !('parentEvidenceId' in env.activity));
    check('inline metadata, no hash claim', 'inline' in env.outputArtifacts[0] && !('hash' in env.outputArtifacts[0]));
    check('limitation stated in the record', /not observable/.test(env.outputArtifacts[0].metadata.note ?? ''));
    check('model falls back honestly', env.model.provider === 'openai' && env.model.name === 'unknown');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
