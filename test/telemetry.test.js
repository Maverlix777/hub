import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { readTelemetry, projectTelemetry } from '../src/telemetry.js';

const now = Date.parse('2026-10-25T06:00:00Z');
const sample = () => ({ telemetry: {
  schema_version: 1, producer: 'local-manager-telemetry', as_of: new Date(now).toISOString(),
  events: [{ id: 'event-1', stage: 'result_verified', proof: { secret: 'PRIVATE' }, facts: {
    task_id: 'TEST-1', turn_id: 'turn-1', at_utc: new Date(now).toISOString(), stage: 'result_reported',
  } }], cards: [], counts: {}, unmappedCount: 0, ignored_records: 0, sources: [],
  gemma: { results: [{ model: 'example:12b', run_id: 'run-1', created_at: new Date(now).toISOString(),
    eval_count: 10, eval_seconds: 2, total_seconds: 3, load_seconds: 0.5, prompt_eval_count: 20,
    prompt_eval_seconds: 0.5, finish_reason: 'stop', response: 'PRIVATE' }] },
  gpu: { status: 'measured', samples: [{ device_id: 'gpu-1', measured_at: new Date(now).toISOString(),
    status: 'measured', utilization_percent: 80, memory_used_bytes: 10, memory_total_bytes: 20 }] },
} });
const env = { BOARD_REPO: 'example/private-board', BOARD_GITHUB_TOKEN: 'synthetic-token', BOARD_TELEMETRY_PATH: 'telemetry/current.json' };

test('projection keeps claims distinct from verified completion and drops raw fields', () => {
  const result = projectTelemetry(sample(), now);
  assert.equal(result.status, 'available');
  assert.equal(result.events[0].state, 'result_reported');
  assert.equal(result.events[0].producer_claimed_verified, true);
  assert.equal(result.runs[0].tokens_per_second, 5);
  assert.equal(result.gpu.samples[0].utilization_percent, 80);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  const done = sample(); done.telemetry.events[0].stage = 'done';
  assert.equal(projectTelemetry(done, now).events[0].state, 'unknown');
});

test('missing, stale and future exports cannot display current activity or measurements', () => {
  assert.equal(projectTelemetry({}, now).status, 'unknown');
  for (const offset of [-901000, 1000]) {
    const input = sample(); input.telemetry.as_of = new Date(now + offset).toISOString();
    const result = projectTelemetry(input, now);
    assert.equal(result.status, 'unknown'); assert.equal(result.events.length, 0);
    assert.equal(result.gpu.status, 'unknown');
  }
  const input = sample(); input.telemetry.events[0].facts.at_utc = '2020-01-01T00:00:00Z';
  input.telemetry.gpu.samples[0].measured_at = '2020-01-01T00:00:00Z';
  delete input.telemetry.gemma.results[0].eval_count;
  const result = projectTelemetry(input, now);
  assert.equal(result.events[0].state, 'unknown');
  assert.equal(result.gpu.samples[0].utilization_percent, null);
  assert.equal(result.runs[0].eval_count, null);
  assert.equal(result.runs[0].tokens_per_second, null);
});

test('identical IDs dedupe while conflicting facts reject the export', () => {
  const input = sample(); input.telemetry.events.push(structuredClone(input.telemetry.events[0]));
  input.telemetry.gemma.results.push(structuredClone(input.telemetry.gemma.results[0]));
  assert.equal(projectTelemetry(input, now).events.length, 1);
  assert.equal(projectTelemetry(input, now).runs.length, 1);
  input.telemetry.events[1].stage = 'running';
  assert.equal(projectTelemetry(input, now).status, 'unknown');
});

test('reader is opt-in, pinned to board repo and rejects unsafe paths without fetching', async () => {
  const fail = () => { throw Error('must not fetch'); };
  assert.equal((await readTelemetry({}, fail, now)).reason, 'not_configured');
  for (const path of ['../data.json', 'https://elsewhere/data.json', '/data.json', 'a//b.json', 'a%2fb.json']) {
    assert.equal((await readTelemetry({ ...env, BOARD_TELEMETRY_PATH: path }, fail, now)).reason, 'invalid_source');
  }
  let calls = 0;
  const result = await readTelemetry(env, async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.github.com/repos/example/private-board/contents/telemetry/current.json');
    assert.equal(init.redirect, 'error'); assert.equal(init.method, 'GET');
    assert.ok(init.signal); assert.equal(init.headers.authorization, 'Bearer synthetic-token');
    return Response.json(sample());
  }, now);
  assert.equal(calls, 1); assert.equal(result.status, 'available');
});

test('upstream failures, malformed and oversized payloads fail closed without details', async () => {
  for (const fetcher of [async () => { throw Error('PRIVATE'); }, async () => new Response('PRIVATE', { status: 403 }),
    async () => new Response('{'), async () => new Response('x'.repeat(262145))]) {
    const result = await readTelemetry(env, fetcher, now);
    assert.equal(result.status, 'unknown'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('projection rejects path-like identifiers and does not call empty metrics measured', () => {
  const input = sample();
  input.telemetry.events[0].facts.task_id = 'C:/Users/private/report';
  input.telemetry.gemma.results = [{ run_id: 'empty', model: 'example', created_at: new Date(now).toISOString() }];
  const result = projectTelemetry(input, now);
  assert.equal(result.events[0].task_id, null);
  assert.equal(result.runs[0].status, 'unknown');
  assert.equal(result.runs[0].eval_count, null);
});

test('PR710 synthetic producer envelope supports absent run ID and never trusts proof task identity', async () => {
  const input = JSON.parse(await readFile(new URL('./fixtures/telemetry-v1.synthetic.json', import.meta.url), 'utf8'));
  input.telemetry.gemma.results.push(structuredClone(input.telemetry.gemma.results[0]));
  const result = projectTelemetry(input, now);
  assert.equal(result.status, 'available');
  assert.equal(result.events[0].state, 'running');
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].run_id, null);
  assert.equal(result.runs[0].tokens_per_second, 10);
  input.telemetry.events[0].facts.task_id = null;
  input.telemetry.events[0].stage = 'result_verified';
  input.telemetry.events[0].proof = { task_id: 'DO-NOT-TRUST', private: 'PRIVATE' };
  const claimed = projectTelemetry(input, now);
  assert.equal(claimed.events[0].task_id, null);
  assert.equal(claimed.events[0].state, 'result_reported');
  assert.ok(!JSON.stringify(claimed).includes('DO-NOT-TRUST'));
});

test('closed identifiers reject relative paths and credential-shaped values in every exported ID role', () => {
  const rejected = ['home/alice/private/report.txt', '/home/alice/private/report.txt', 'home\\alice\\report.txt',
    'C:private.txt', '../private.txt', 'ghs_syntheticExampleSecret', 'GHO_syntheticExampleSecret',
    'ghu_syntheticExampleSecret', 'ghr_syntheticExampleSecret', 'ghp_syntheticExampleSecret',
    'github_pat_syntheticExampleSecret', 'sk_syntheticExampleSecret', 'sk-syntheticExampleSecret', 'BearerSynthetic',
    'name with space', 'x'.repeat(161)];
  for (const value of rejected) {
    const input = sample();
    input.telemetry.events[0].facts.task_id = value;
    input.telemetry.events[0].facts.turn_id = value;
    input.telemetry.gemma.results[0].run_id = value;
    const result = projectTelemetry(input, now);
    assert.equal(result.events[0].task_id, null, `task rejected: ${value}`);
    assert.equal(result.events[0].turn_id, null, `turn rejected: ${value}`);
    assert.equal(result.runs[0].run_id, null, `run rejected: ${value}`);
    assert.ok(!JSON.stringify(result).includes(value), `no rejected value emitted: ${value}`);
    const modelInput = sample(); modelInput.telemetry.gemma.results[0].model = value;
    assert.equal(projectTelemetry(modelInput, now).runs[0].model, null, `model rejected: ${value}`);
    const gpuInput = sample(); gpuInput.telemetry.gpu.samples[0].device_id = value;
    assert.equal(projectTelemetry(gpuInput, now).status, 'unknown', 'bad GPU identity fails closed');
    input.telemetry.events[0].id = value;
    assert.equal(projectTelemetry(input, now).status, 'unknown', 'bad event identity fails closed');
  }
});

test('closed identifier grammar preserves UUID, task/run IDs, hashes, GPU IDs and model tags', () => {
  const input = sample();
  input.telemetry.events[0].id = 'a'.repeat(64);
  input.telemetry.events[0].facts.task_id = 'QA-13-PR709-acceptance';
  input.telemetry.events[0].facts.turn_id = '01234567-89ab-cdef-0123-456789abcdef';
  input.telemetry.gemma.results[0].run_id = 'try1_run-20261025.001';
  input.telemetry.gemma.results[0].model = 'gemma4:12b';
  input.telemetry.gpu.samples[0].device_id = 'GPU-01234567-89ab-cdef-0123-456789abcdef';
  const result = projectTelemetry(input, now);
  assert.equal(result.status, 'available');
  assert.equal(result.events[0].id, 'a'.repeat(64));
  assert.equal(result.events[0].task_id, 'QA-13-PR709-acceptance');
  assert.equal(result.events[0].turn_id, '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(result.runs[0].run_id, 'try1_run-20261025.001');
  assert.equal(result.runs[0].model, 'gemma4:12b');
  assert.equal(result.gpu.samples[0].device_id, 'GPU-01234567-89ab-cdef-0123-456789abcdef');
});
