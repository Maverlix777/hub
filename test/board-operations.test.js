import assert from 'node:assert/strict';
import { test } from 'node:test';

// The producer is deliberately lazy: real Worker RED is recorded separately.
// Module-absence errors are never counted as behavioral RED evidence.
const load = async (...args) => (await import('../src/board-operations.js')).loadBoardOperations(...args);
const env = { BOARD_GITHUB_TOKEN: 'TEST_ONLY_SERVER_VALUE' };
const repo = 'Maverlix777/agent-handoffs';
const when = Date.UTC(2026, 10, 10, 20, 0, 0);
const now = () => when;
const issue = (number, labels = [], extra = {}) => ({ number, state: 'open', title: `Issue ${number}`, labels: labels.map(name => ({ name })), ...extra });
const page = (first, count = 100, labels = []) => Array.from({ length: count }, (_, index) => issue(first + index, labels));
const unavailable = (praxis_url = null) => ({ status: 'unavailable', as_of: null, open_issues: null, workers: [], human_blockers: [], praxis_url });
const empty = (praxis_url = null) => ({ status: 'ok', as_of: new Date(when).toISOString(), open_issues: 0, workers: [], human_blockers: [], praxis_url });

function transport(responses) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    const number = calls.length + 1;
    calls.push({ url: String(url), init });
    assert.equal(String(url), `https://api.github.com/repos/${repo}/issues?state=open&sort=created&direction=asc&per_page=100&page=${number}`);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, 'Bearer TEST_ONLY_SERVER_VALUE');
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(number <= responses.length, 'Unexpected retry or page outside supplied complete fixture');
    const response = responses[number - 1];
    return typeof response === 'function' ? response(init) : response;
  } };
}

test('operations: complete101-row census has unique issue and independent multiworker counts', async () => {
  const t = transport([Response.json(page(1, 100, ['worker:codex'])), Response.json([
    issue(101, ['worker:claude', 'worker:codex', 'worker:claude', 'blocked:human'], { title: '<b>Owner action</b>', html_url: 'https://attacker.invalid/PRIVATE_SENTINEL', body: 'PRIVATE_SENTINEL' }),
  ])]);
  assert.deepEqual(await load(env, t.fetch, now), {
    status: 'ok', as_of: new Date(when).toISOString(), open_issues: 101,
    workers: [{ label: 'worker:claude', count: 1 }, { label: 'worker:codex', count: 101 }],
    human_blockers: [{ number: 101, title: '<b>Owner action</b>', url: `https://github.com/${repo}/issues/101` }], praxis_url: null,
  });
  assert.equal(t.calls.length, 2);
});

test('operations:100 rows require an empty terminal page while an empty first page is genuine zero', async () => {
  const t = transport([Response.json(page(1)), Response.json([])]);
  assert.deepEqual(await load(env, t.fetch, now), { ...empty(), open_issues: 100 });
  assert.equal(t.calls.length, 2);
  assert.deepEqual(await load(env, transport([Response.json([])]).fetch, now), empty());
});

test('operations: native labels distinguish open, closed, PR, unassigned and exact human blockers', async () => {
  const t = transport([Response.json([
    issue(9, ['worker:z', 'worker:a', 'worker:z', 'blocked:human']),
    issue(2, ['blocked:human']), issue(3, []),
    issue(4, ['cloud:blocked', 'blocked:human-extra']),
    issue(5, ['worker:z', 'blocked:human'], { state: 'closed' }),
    issue(6, ['worker:z', 'blocked:human'], { pull_request: {} }),
  ])]);
  assert.deepEqual(await load(env, t.fetch, now), {
    ...empty(), open_issues: 4, workers: [{ label: 'worker:a', count: 1 }, { label: 'worker:z', count: 1 }],
    human_blockers: [2, 9].map(number => ({ number, title: `Issue ${number}`, url: `https://github.com/${repo}/issues/${number}` })),
  });
});

test('operations: blocker title is bounded by displayed code points without forwarding other fields', async () => {
  const title = 'A'.repeat(239) + '🛠' + 'DROP_ME';
  const result = await load(env, transport([Response.json([issue(1, ['blocked:human'], { title, body: 'PRIVATE_SENTINEL', html_url: 'https://attacker.invalid/PRIVATE_SENTINEL' })])]).fetch, now);
  assert.equal(result.human_blockers[0].title, 'A'.repeat(239) + '🛠');
  assert.equal(Array.from(result.human_blockers[0].title).length, 240);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
});

test('operations: duplicates within and across pages reject the entire census', async () => {
  assert.deepEqual(await load(env, transport([Response.json([issue(1), issue(1)])]).fetch, now), unavailable());
  const t = transport([Response.json(page(1)), Response.json([issue(1)])]);
  assert.deepEqual(await load(env, t.fetch, now), unavailable());
  assert.equal(t.calls.length, 2);
});

test('operations: full twentieth page never claims complete2000 or requests page21', async () => {
  const t = transport(Array.from({ length: 20 }, (_, index) => Response.json(page(index * 100 + 1))));
  assert.deepEqual(await load(env, t.fetch, now), unavailable());
  assert.equal(t.calls.length, 20);
});

test('operations: invalid token or repository fails before any network read', async () => {
  for (const changes of [{ BOARD_GITHUB_TOKEN: '' }, { BOARD_GITHUB_TOKEN: null }, { BOARD_GITHUB_TOKEN: 42 },
    { BOARD_REPO: 'owner/repo/extra' }, { BOARD_REPO: 'owner/repo?PRIVATE_SENTINEL' }, { BOARD_REPO: 'https://attacker.invalid' }]) {
    let calls = 0;
    assert.deepEqual(await load({ ...env, ...changes }, async () => { calls++; throw new Error('PRIVATE_SENTINEL'); }, now), unavailable());
    assert.equal(calls, 0);
  }
});

test('operations: malformed JSON, shape, row identity, state or native label rejects without partial totals', async () => {
  const malformed = [null, {}, [issue(1), null], [issue(0)], [issue('1')], [issue(Number.MAX_SAFE_INTEGER + 1)],
    [issue(1, [], { state: 'unknown' })], [issue(1, [], { labels: null })], [issue(1, [], { labels: [null] })],
    [issue(1, [], { labels: [{ name: 42 }] })], [issue(1, ['blocked:human'], { title: {} })]];
  for (const rows of malformed) assert.deepEqual(await load(env, transport([Response.json(rows)]).fetch, now), unavailable());
  assert.deepEqual(await load(env, transport([new Response('{PRIVATE_SENTINEL')]).fetch, now), unavailable());
  assert.deepEqual(await load(env, transport([Response.json(page(1, 101))]).fetch, now), unavailable());
});

test('operations: HTTP failures, redirects and thrown transport errors are finite and never retried', async () => {
  for (const status of [301, 302, 401, 403, 404, 429, 500]) {
    const t = transport([new Response('PRIVATE_SENTINEL', { status })]);
    assert.deepEqual(await load(env, t.fetch, now), unavailable());
    assert.equal(t.calls.length, 1);
  }
  const redirected = Response.json([]);
  Object.defineProperty(redirected, 'redirected', { value: true });
  assert.deepEqual(await load(env, transport([redirected]).fetch, now), unavailable());
  assert.deepEqual(await load(env, transport([() => { throw new Error('PRIVATE_SENTINEL'); }]).fetch, now), unavailable());
});

test('operations: streamed page byte limit cannot be bypassed by a false Content-Length', async () => {
  let cancelled = false;
  const bytes = new TextEncoder().encode(JSON.stringify([issue(1)]) + ' '.repeat(1048576));
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, 524288)); controller.enqueue(bytes.subarray(524288)); },
    cancel() { cancelled = true; },
  });
  assert.deepEqual(await load(env, transport([new Response(stream, { headers: { 'content-length': '1' } })]).fetch, now), unavailable());
  assert.equal(cancelled, true);
});

test('operations: response declared above the page limit rejects without reporting a count', async () => {
  assert.deepEqual(await load(env, transport([new Response('[]', { headers: { 'content-length': '1048577' } })]).fetch, now), unavailable());
});

test('operations: eight exact1MiB pages plus another valid row exceed the shared8MiB budget', async () => {
  const responses = Array.from({ length: 8 }, (_, index) => {
    const text = JSON.stringify(page(index * 100 + 1));
    return new Response(text + ' '.repeat(1048576 - Buffer.byteLength(text)));
  });
  const t = transport([...responses, Response.json([issue(801)])]);
  assert.deepEqual(await load(env, t.fetch, now), unavailable());
  assert.equal(t.calls.length, 9);
});

test('operations: body stream errors cannot leak text or turn failure into zero', async () => {
  const stream = new ReadableStream({ pull(controller) { controller.error(new Error('PRIVATE_SENTINEL')); } });
  assert.deepEqual(await load(env, transport([new Response(stream)]).fetch, now), unavailable());
});

test('operations: one scoped deadline bounds a fetch that ignores AbortSignal', async (t) => {
  const { loadBoardOperations } = await import('../src/board-operations.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  let calls = 0;
  const pending = loadBoardOperations(env, async () => { calls++; return new Promise(() => {}); }, now);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  t.mock.timers.tick(10000);
  assert.deepEqual(await pending, unavailable());
});

test('operations: same deadline includes stalled body reads and cancels the owned reader', async (t) => {
  const { loadBoardOperations } = await import('../src/board-operations.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = loadBoardOperations(env, transport([response]).fetch, now);
  await new Promise(setImmediate);
  t.mock.timers.tick(10000);
  assert.deepEqual(await pending, unavailable());
  assert.equal(cancelled, true);
});

test('operations: page transition does not reset the single whole-census deadline', async (t) => {
  const { loadBoardOperations } = await import('../src/board-operations.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const transportFixture = transport([
    () => { t.mock.timers.tick(6000); return Response.json(page(1)); },
    () => { t.mock.timers.tick(6000); return Response.json([issue(101)]); },
  ]);
  assert.deepEqual(await loadBoardOperations(env, transportFixture.fetch, now), unavailable());
  assert.equal(transportFixture.calls.length, 2);
});

test('operations: Praxis is optional validated navigation and survives census unavailability', async () => {
  for (const value of [undefined, '', '   ', 42, 'http://praxis.example.test/', '/relative', 'https://u:p@praxis.example.test/',
    'https://praxis.example.test/\nPRIVATE_SENTINEL', 'https://praxis.example.test/' + 'x'.repeat(20000)]) {
    assert.deepEqual(await load({ ...env, BOARD_PRAXIS_URL: value }, transport([Response.json([])]).fetch, now), empty());
  }
  const configured = { ...env, BOARD_PRAXIS_URL: 'https://PRAXIS.example.test/dashboard?a=1#queue' };
  const expected = 'https://praxis.example.test/dashboard?a=1#queue';
  assert.deepEqual(await load(configured, transport([Response.json([])]).fetch, now), empty(expected));
  assert.deepEqual(await load(configured, transport([new Response('PRIVATE_SENTINEL', { status: 429 })]).fetch, now), unavailable(expected));
});
