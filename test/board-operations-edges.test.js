import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBoardOperations } from '../src/board-operations.js';

// Synthetic transport only: no GitHub/Praxis request or deployment binding read.
const env = { BOARD_GITHUB_TOKEN: 'TEST_ONLY_EDGE_FIXTURE' };
const when = Date.UTC(2026, 10, 10, 20, 0, 0);
const unavailable = { status: 'unavailable', as_of: null, open_issues: null, workers: [], human_blockers: [], praxis_url: null };
const turn = () => new Promise(setImmediate);

test('operations edge: serialized Praxis URL cap rejects expanded Unicode while short Unicode remains valid', async (t) => {
  let calls = 0;
  const fetchFixture = async () => { calls++; return Response.json([]); };
  const short = 'https://example.test/кафе/🛠';
  const shortHref = new URL(short).href;
  assert.ok(shortHref.length <= 2048);
  const accepted = await loadBoardOperations({ ...env, BOARD_PRAXIS_URL: short }, fetchFixture, () => when);
  assert.equal(accepted.status, 'ok');
  assert.equal(accepted.open_issues, 0);
  assert.equal(accepted.praxis_url, shortHref, 'Unicode itself is valid; normalization must preserve a short HTTPS URL');

  const expanded = 'https://example.test/' + '🛠'.repeat(200);
  const normalized = new URL(expanded).href;
  assert.equal(expanded.length, 421);
  assert.equal(normalized.length, 2421);
  assert.ok(expanded.length <= 2048 && normalized.length > 2048);
  t.diagnostic(`synthetic URL UTF16 units: raw=${expanded.length}, normalized=${normalized.length}`);
  const rejected = await loadBoardOperations({ ...env, BOARD_PRAXIS_URL: expanded }, fetchFixture, () => when);
  assert.equal(calls, 2, 'Each complete synthetic census needs exactly one request');
  assert.equal(rejected.status, 'ok', 'An optional oversized URL must not invalidate a complete census');
  assert.equal(rejected.open_issues, 0);
  assert.ok(rejected.praxis_url === null, 'Serialized HTTPS href exceeds 2048 UTF16 code units and must be rejected');
});

test('operations edge: response arriving after the whole deadline is cancelled without another request or unhandled rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  let release; let released = false; let calls = 0; let cancelled = 0; let signal;
  const deferred = new Promise(resolve => { release = resolve; });
  const response = new Response(new ReadableStream({
    cancel() { cancelled++; return Promise.reject(new Error('SYNTHETIC_CANCEL_REFUSAL')); },
  }));
  const pending = loadBoardOperations(env, async (_url, init) => {
    calls++; signal = init.signal; return deferred; // Deliberately ignores AbortSignal.
  }, () => when);
  try {
    await turn();
    assert.equal(calls, 1);
    let settled = false;
    pending.then(() => { settled = true; });
    t.mock.timers.tick(9999); await turn();
    assert.equal(settled, false, 'The one whole-census deadline has not elapsed');
    t.mock.timers.tick(1);
    const result = await pending;
    assert.deepEqual(result, unavailable);
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, 0, 'The response is not owned until the deferred fetch resolves');
    released = true; release(response);
    await turn(); await turn();
    assert.equal(cancelled, 1, 'Late owned body must receive best-effort cancellation');
    assert.equal(calls, 1, 'Deadline must not trigger retries or a second request');
    assert.deepEqual(result, unavailable, 'The already settled result cannot become a successful late census');
    // node:test treats an unhandled rejection as a failure; the rejecting cancel
    // above must be consumed by the producer, including after it returned.
  } finally {
    if (!released) { released = true; release(response); }
    t.mock.timers.tick(10000);
    await pending; await turn(); await turn();
    if (!response.body.locked) await response.body.cancel().catch(() => {});
  }
});
