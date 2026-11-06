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
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), auth: init.headers.authorization }); return new Response(SAMPLE); };
  const response = await get('/hub/api/board', owner);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.counts, { ideas: 2, planned: 2, progress: 4, review: 2, done: 4, questions: 4 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.url.startsWith('https://api.github.com/repos/')));
  assert.ok(!JSON.stringify(body).includes('test-token'));
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
  assert.equal(calls, 3);
  // The artifact exists before the request; do not timestamp it later inside fetch.
  const artifactTime = new Date(Date.now() - 1000).toISOString();
  globalThis.fetch = async (url) => String(url).endsWith('.json') ? Response.json({ telemetry: {
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
