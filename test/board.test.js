import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import worker from '../src/worker.js';
import { buildBoard, columnForState, parseBoard } from '../src/board.js';

// Synthetic data only: this repo is public, never paste real board rows here.
const SAMPLE = `# Board

| ID | Задача | Кому | Состояние | Ветка / PR | Приёмка |
|---|---|---|---|---|---|
| T-1 | Alpha \`a | b\` task | x | Ready | | ok |
| T-2 | Beta | y | Claimed | #2 | ok |
| T-3 | Gamma | y | Review | #3 | ok |
| T-4 | Delta | z | Done (merged) | #4 | ok |
| T-5 | Epsilon | z | Blocked | | нужно слово владельца |
| T-6 | Zeta | z | Blocked | | ждёт CI |
| T-7 | Eta | z | Needs-owner | | ok |
| T-8 | Theta | z | Idea | | ok |
| T-9 | Iota | z | Weird | | ok |

## Закрыто

| ID | Задача | Кто | sha |
|---|---|---|---|
| T-10 | Kappa | q | abc1234 |
`;

test('board: states map to separate review and progress columns', () => {
  assert.equal(columnForState('Ready'), 'planned');
  assert.equal(columnForState('Claimed'), 'progress');
  assert.equal(columnForState('Review (x)'), 'review');
  assert.equal(columnForState('Done (merged PR #1)'), 'done');
  assert.equal(columnForState('Закрыта: superseded'), 'done');
  assert.equal(columnForState('Needs-owner'), 'questions');
  assert.equal(columnForState('Blocked', 'ждёт владельца'), 'questions');
  assert.equal(columnForState('Blocked', 'CI'), 'progress');
  assert.equal(columnForState('Idea'), 'ideas');
  assert.equal(columnForState('???'), null);
});

test('board: parser counts per column, handles pipes in code and the 4-column closed table', () => {
  const { cards, unmapped } = parseBoard(SAMPLE, 'x');
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].id, 'T-9');
  const board = buildBoard([{ name: 'x', text: SAMPLE }]);
  assert.deepEqual(board.counts, { ideas: 1, planned: 1, progress: 2, review: 1, done: 2, questions: 2 });
  assert.equal(cards.find((c) => c.id === 'T-1').title, 'Alpha a | b task');
  assert.equal(cards.find((c) => c.id === 'T-10').column, 'done');
});

const origin = 'https://kolobovdjp.org';
const sql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec(sql);
function statement(query, values = []) {
  return {
    bind(...args) { return statement(query, args); },
    first() { return sqlite.prepare(query).get(...values) || null; },
    all() { return { results: sqlite.prepare(query).all(...values) }; },
    run() { return { meta: { changes: Number(sqlite.prepare(query).run(...values).changes) } }; },
  };
}
const env = {
  HUB_DB: { prepare: statement },
  ASSETS: { async fetch() { return new Response('asset'); } },
  CANONICAL_ORIGIN: origin,
  RP_ID: 'kolobovdjp.org',
  BOARD_OWNER_USERNAME: 'boss',
  BOARD_GITHUB_TOKEN: 'test-token-not-real',
  BOARD_IDEA_PATHS: '',
};
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; sqlite.close(); });

async function login(username, tier, token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = Buffer.from(digest).toString('base64url');
  sqlite.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, 1)').run(`id-${username}`, username);
  sqlite.prepare('INSERT INTO entitlements (user_id, tier, created_at) VALUES (?, ?, 1)').run(`id-${username}`, tier);
  sqlite.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 1, ?)')
    .run(hash, `id-${username}`, Date.now() + 3600_000);
  return { cookie: `__Host-hub_session=${token}` };
}
const ownerToken = 'o'.repeat(43);
const guestToken = 'g'.repeat(43);
const owner = await login('boss', 'free', ownerToken);
const guest = await login('guest', 'paid', guestToken);
const get = (path, who) => worker.fetch(new Request(`${origin}${path}`, { headers: who ? { cookie: who.cookie } : {} }), env);

test('board api: anonymous 401, non-owner 403 even with paid tier', async () => {
  assert.equal((await get('/hub/api/board')).status, 401);
  assert.equal((await get('/hub/api/board', guest)).status, 403);
});

test('board api: owner gets cards, token goes only to api.github.com', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization });
    return new URL(url).pathname.endsWith('/issues') ? Response.json([]) : new Response(SAMPLE);
  };
  const response = await get('/hub/api/board', owner);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.counts, { ideas: 2, planned: 2, progress: 4, review: 2, done: 4, questions: 4 });
  assert.equal(calls.length, 3); // Two Markdown reads plus one complete empty Issue census.
  assert.equal(calls.filter((c) => new URL(c.url).pathname.endsWith('/issues')).length, 1);
  assert.ok(calls.every((c) => c.url.startsWith('https://api.github.com/repos/')));
  assert.ok(!JSON.stringify(body).includes('test-token'));
});


test('board operations: owner GET returns complete Issue census without changing Markdown counts', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const calls = [];
  const serverValue = 'TEST_ONLY_SERVER_VALUE';
  const rows = [
    { number: 11, state: 'open', title: '<img src=x onerror=alert(1)>', labels: [{ name: 'worker:codex' }, { name: 'worker:codex' }, { name: 'worker:claude' }, { name: 'blocked:human' }], html_url: 'https://attacker.invalid/PRIVATE_SENTINEL', body: 'PRIVATE_SENTINEL' },
    { number: 12, state: 'open', title: 'CI wait', labels: [{ name: 'worker:codex' }, { name: 'cloud:blocked' }] },
    { number: 13, state: 'open', title: 'Unassigned owner action', labels: [{ name: 'blocked:human' }] },
    { number: 14, state: 'closed', title: 'Closed', labels: [{ name: 'worker:claude' }, { name: 'blocked:human' }] },
    { number: 15, state: 'open', title: 'Pull request', labels: [{ name: 'worker:codex' }, { name: 'blocked:human' }], pull_request: {} },
    { number: 16, state: 'open', title: 'Unassigned ordinary issue', labels: [] },
  ];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init.headers.authorization, `Bearer ${serverValue}`);
    assert.equal(init.redirect, 'manual');
    if (new URL(url).pathname.endsWith('/issues')) {
      assert.equal(String(url), 'https://api.github.com/repos/Maverlix777/agent-handoffs/issues?state=open&sort=created&direction=asc&per_page=100&page=1');
      return Response.json(rows);
    }
    assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/Maverlix777\/agent-handoffs\/contents\//);
    return new Response(SAMPLE);
  };
  const before = Date.now();
  const response = await worker.fetch(new Request(`${origin}/hub/api/board`, { headers: { cookie: owner.cookie } }),
    { ...env, BOARD_GITHUB_TOKEN: serverValue, BOARD_PRAXIS_URL: 'https://praxis.example.test/dashboard?view=queue#now' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.counts, { ideas: 2, planned: 2, progress: 4, review: 2, done: 4, questions: 4 });
  assert.equal(body.operations?.status, 'ok'); // Baseline route has no operations, a behavioral RED.
  assert.deepEqual(Object.keys(body.operations).sort(), ['as_of', 'human_blockers', 'open_issues', 'praxis_url', 'status', 'workers']);
  assert.equal(body.operations.open_issues, 4);
  assert.deepEqual(body.operations.workers, [{ label: 'worker:claude', count: 1 }, { label: 'worker:codex', count: 2 }]);
  assert.deepEqual(body.operations.human_blockers, [
    { number: 11, title: '<img src=x onerror=alert(1)>', url: 'https://github.com/Maverlix777/agent-handoffs/issues/11' },
    { number: 13, title: 'Unassigned owner action', url: 'https://github.com/Maverlix777/agent-handoffs/issues/13' },
  ]);
  assert.equal(body.operations.praxis_url, 'https://praxis.example.test/dashboard?view=queue#now');
  assert.ok(Date.parse(body.operations.as_of) >= before && Date.parse(body.operations.as_of) <= Date.now());
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((url) => new URL(url).pathname.endsWith('/issues')).length, 1);
  assert.ok(!JSON.stringify(body).includes(serverValue));
  assert.ok(!JSON.stringify(body).includes('PRIVATE_SENTINEL'));
});


test('board operations: unavailable census preserves owner cards and independent Praxis link', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const observed = [];
  for (const failure of ['429', 'throw']) {
    globalThis.fetch = async (url, init) => {
      assert.equal(init.headers.authorization, 'Bearer TEST_ONLY_SERVER_VALUE');
      assert.equal(init.redirect, 'manual');
      if (new URL(url).pathname.endsWith('/issues')) {
        if (failure === 'throw') throw new Error('PRIVATE_TRANSPORT_SENTINEL');
        return new Response('PRIVATE_TRANSPORT_SENTINEL', { status: 429 });
      }
      assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/Maverlix777\/agent-handoffs\/contents\//);
      return new Response(SAMPLE);
    };
    const response = await worker.fetch(new Request(`${origin}/hub/api/board`, { headers: { cookie: owner.cookie } }),
      { ...env, BOARD_GITHUB_TOKEN: 'TEST_ONLY_SERVER_VALUE', BOARD_PRAXIS_URL: 'https://praxis.example.test/queue' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body.counts, { ideas: 2, planned: 2, progress: 4, review: 2, done: 4, questions: 4 });
    assert.equal(body.cards[0].title, 'Alpha a | b task');
    assert.ok(!JSON.stringify(body).includes('TEST_ONLY_SERVER_VALUE'));
    assert.ok(!JSON.stringify(body).includes('PRIVATE_TRANSPORT_SENTINEL'));
    observed.push({ failure, operations: body.operations });
  }
  const expected = { status: 'unavailable', as_of: null, open_issues: null, workers: [], human_blockers: [], praxis_url: 'https://praxis.example.test/queue' };
  assert.deepEqual(observed, [{ failure: '429', operations: expected }, { failure: 'throw', operations: expected }]);
});

test('board operations: actual targeted outbox POST never invokes the Issue census', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  sqlite.exec(await readFile(new URL('../migrations/0002_owner_outbox.sql', import.meta.url), 'utf8'));
  sqlite.exec(await readFile(new URL('../migrations/0003_owner_issues.sql', import.meta.url), 'utf8'));
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init.headers.authorization, 'Bearer TEST_ONLY_SERVER_VALUE');
    assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/Maverlix777\/agent-handoffs\/contents\//);
    return new Response(SAMPLE);
  };
  const bytes = new TextEncoder().encode(SAMPLE);
  const revision = Buffer.from(await crypto.subtle.digest('SHA-1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))).toString('hex');
  const payload = { idempotencyKey: crypto.randomUUID(), kind: 'answer', text: 'Synthetic targeted reply',
    target: { sourcePath: 'proposals/ai-factory-jobforge/BOARD.md', taskId: 'T-1', revision } };
  const response = await worker.fetch(new Request(`${origin}/hub/api/outbox`, {
    method: 'POST', headers: { cookie: owner.cookie, origin, 'content-type': 'application/json', 'X-Hub-Request': '1', 'CF-Connecting-IP': '192.0.2.1' },
    body: JSON.stringify(payload),
  }), { ...env, BOARD_GITHUB_TOKEN: 'TEST_ONLY_SERVER_VALUE', RATE_LIMIT_HMAC_KEY: 'TEST_ONLY_RATE_LIMIT_VALUE_32_CHARACTERS' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.item.status, 'pending');
  assert.equal(body.item.text, payload.text);
  assert.deepEqual(body.item.target, payload.target);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM owner_outbox').get().n, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((url) => new URL(url).pathname.endsWith('/issues')).length, 0);
});

test('board api: no token or no owner configured fails closed', async () => {
  const { BOARD_GITHUB_TOKEN, ...noToken } = env;
  const r1 = await worker.fetch(new Request(`${origin}/hub/api/board`, { headers: { cookie: owner.cookie } }), noToken);
  assert.equal(r1.status, 503);
  const { BOARD_OWNER_USERNAME, ...noOwner } = env;
  const r2 = await worker.fetch(new Request(`${origin}/hub/api/board`, { headers: { cookie: owner.cookie } }), noOwner);
  assert.equal(r2.status, 403);
});

test('board page assets: owner only; session lists board only for owner', async () => {
  assert.equal((await get('/hub/apps/board.html', guest)).status, 403);
  assert.equal((await get('/hub/apps/board.js', guest)).status, 403);
  assert.equal((await get('/hub/apps/board.html', owner)).status, 200);
  assert.ok((await (await get('/hub/api/session', owner)).json()).apps.includes('board'));
  assert.ok(!(await (await get('/hub/api/session', guest)).json()).apps.includes('board'));
});

test('board owner var accepts a comma-separated list', async () => {
  const multi = { ...env, BOARD_OWNER_USERNAME: ' other , BOSS ' };
  const r = await worker.fetch(new Request(`${origin}/hub/api/board`, { headers: { cookie: owner.cookie } }), multi);
  assert.notEqual(r.status, 403);
  const g = await worker.fetch(new Request(`${origin}/hub/api/board`, { headers: { cookie: guest.cookie } }), multi);
  assert.equal(g.status, 403);
});

test('telemetry authorization precedes all reads and optional failure preserves manual board', async () => {
  const configured = { ...env, BOARD_TELEMETRY_PATH: 'telemetry/current.json' };
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (new URL(url).pathname.endsWith('/issues')) return Response.json([]);
    return String(url).endsWith('.json') ? new Response('invalid') : new Response(SAMPLE);
  };
  const request = (who) => new Request(`${origin}/hub/api/board`, { headers: who ? { cookie: who.cookie } : {} });
  assert.equal((await worker.fetch(request(), configured)).status, 401);
  assert.equal((await worker.fetch(request(guest), configured)).status, 403);
  assert.equal((await worker.fetch(request(owner), { ...configured, BOARD_OWNER_USERNAME: '' })).status, 403);
  assert.equal(calls, 0);
  const response = await worker.fetch(request(owner), configured);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.deepEqual(result.counts, { ideas: 2, planned: 2, progress: 4, review: 2, done: 4, questions: 4 });
  assert.equal(result.cards[0].who, 'x');
  assert.equal(result.telemetry.status, 'unknown');
  assert.equal(calls, 4); // Two Markdown reads, telemetry, and one Issue census.
  // The artifact exists before the request; do not timestamp it later inside fetch.
  const artifactTime = new Date(Date.now() - 1000).toISOString();
  globalThis.fetch = async (url) => new URL(url).pathname.endsWith('/issues') ? Response.json([]) : String(url).endsWith('.json') ? Response.json({ telemetry: {
    schema_version: 1, producer: 'local-manager-telemetry', as_of: artifactTime,
    events: [], gemma: { results: [] }, gpu: { samples: [] },
  } }) : new Response(SAMPLE);
  const available = await (await worker.fetch(request(owner), configured)).json();
  assert.equal(available.telemetry.status, 'available');
  assert.equal(available.telemetry.verification, 'producer_report_only');
  assert.equal(available.cards[0].who, 'x');
  assert.deepEqual(available.counts, result.counts);
});

test('T2: markdown dates are not evidence of a label transition', () => {
  const table = '| ID | Task | State |\n|---|---|---|\n| T-1 | Task | Review 2026-10-20 |';
  const card = buildBoard([{name:'s', text:table}]).cards[0];
  assert.equal(card.statusSince, '');
  assert.equal(card.statusAgeLabel, 'нет данных');
  assert.equal(parseBoard(table, 's').cards[0].statusSince, '');
});
