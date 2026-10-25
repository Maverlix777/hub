import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readIssueResponses } from '../src/issue-responses.js';

const id = '11111111-1111-4111-8111-111111111111';
const env = { HUB_RESPONSE_GITHUB_ID: '12345', HUB_RESPONSE_GITHUB_LOGIN: 'trusted-agent', HUB_ISSUES_GITHUB_TOKEN: 'synthetic-secret' };
const repo = 'Maverlix777/agent-handoffs';
const item = (overrides = {}) => ({ id, status: 'synced', createdAt: 1, updatedAt: 1,
  receipt: { kind: 'issue', issueNumber: 12, commentId: null, url: `https://github.com/${repo}/issues/12` }, ...overrides });
const comment = (stage = 'ack', overrides = {}) => ({ id: stage === 'ack' ? 1 : 2,
  body: `<!-- hub-response:${id}:${stage} -->\nSynthetic ${stage} text`, user: { id: 12345, login: 'trusted-agent' },
  html_url: `https://github.com/${repo}/issues/12#issuecomment-${stage === 'ack' ? 1 : 2}`,
  issue_url: `https://api.github.com/repos/${repo}/issues/12`,
  created_at: '2026-10-25T12:00:00Z', updated_at: '2026-10-25T12:00:00Z', ...overrides });
const response = (rows, headers = {}) => new Response(JSON.stringify(rows), { headers });
const read = async (rows, source = item()) => (await readIssueResponses(env, [source], async () => response(rows)))[0];

test('trusted exact ACK/result markers produce separate plain-text evidence without mutating items', async () => {
  const source = item({ agentAck: { text: 'untrusted pre-existing projection' } });
  const original = structuredClone(source);
  const result = await read([comment(), comment('result', { body: `<!-- hub-response:${id}:result -->\n<img src=x onerror=alert(1)>\n<script>unsafe()</script>` })], source);
  assert.equal(result.responseStatus.status, 'available');
  assert.equal(result.agentAck.author, 'trusted-agent');
  assert.equal(result.agentAck.url, `https://github.com/${repo}/issues/12#issuecomment-1`);
  assert.match(result.agentResult.text, /<script>unsafe/);
  assert.deepEqual(source, original);
});
test('result does not fabricate ACK and delivery alone does not fabricate either stage', async () => {
  const result = await read([comment('result')]); assert.equal(result.agentAck, null); assert.ok(result.agentResult);
  const empty = await read([]); assert.equal(empty.responseStatus.status, 'empty'); assert.equal(empty.agentAck, null); assert.equal(empty.agentResult, null);
});
test('missing/invalid explicit author config or token makes no network call', async () => {
  for (const config of [{}, { ...env, HUB_RESPONSE_GITHUB_ID: '' }, { ...env, HUB_RESPONSE_GITHUB_ID: '0' }, { ...env, HUB_RESPONSE_GITHUB_LOGIN: '' }, { ...env, HUB_RESPONSE_GITHUB_LOGIN: 'a,b' }, { ...env, HUB_ISSUES_GITHUB_TOKEN: '' }]) {
    const [row] = await readIssueResponses(config, [item()], () => { throw Error('must not fetch'); });
    assert.equal(row.responseStatus.status, 'not_configured'); assert.equal(row.agentAck, null);
  }
});
test('pending or forged/mismatched receipt never causes a comment request', async () => {
  for (const source of [item({ status: 'pending' }), item({ receipt: { ...item().receipt, url: 'https://evil.example/issues/12' } }), item({ receipt: { ...item().receipt, issueNumber: 13 } }), item({ id: 'not-a-uuid' })]) {
    const [row] = await readIssueResponses(env, [source], () => { throw Error('must not fetch'); });
    assert.equal(row.responseStatus.status, 'not_delivered');
  }
});
test('wrong author, quoted marker, other message marker and nonexact marker are ignored', async () => {
  for (const row of [comment('ack', { user: { id: 12345, login: 'other-agent' } }), comment('ack', { body: `Quoted:\n<!-- hub-response:${id}:ack -->\nclaimed` }),
    comment('ack', { body: '<!-- hub-response:22222222-2222-4222-8222-222222222222:ack -->\nother' }),
    comment('ack', { body: `<!-- hub-response:${id}:ACK -->\nwrong case` })]) {
    const result = await read([row]); assert.equal(result.responseStatus.status, 'empty'); assert.equal(result.agentAck, null);
  }
});
test('GitHub login identity matching is case insensitive but output attribution remains source login', async () => {
  const result = await read([comment('ack', { user: { id: 12345, login: 'Trusted-Agent' } })]); assert.equal(result.agentAck.author, 'Trusted-Agent');
});
test('duplicate trusted markers conflict rather than selecting a convenient latest answer', async () => {
  const result = await read([comment(), comment('ack', { id: 3, html_url: `https://github.com/${repo}/issues/12#issuecomment-3` })]);
  assert.deepEqual(result.responseStatus, { status: 'conflict', reason: 'duplicate_marker' }); assert.equal(result.agentAck, null); assert.equal(result.agentResult, null);
});
test('empty/oversized/control-character answer and false comment evidence are rejected', async () => {
  const cases = [comment('ack', { body: `<!-- hub-response:${id}:ack -->\n ` }),
    comment('ack', { body: `<!-- hub-response:${id}:ack -->\n${'x'.repeat(8001)}` }),
    comment('ack', { body: `<!-- hub-response:${id}:ack -->\ntext\u0000` }),
    comment('ack', { html_url: `https://github.com/${repo}/issues/99#issuecomment-1` }),
    comment('ack', { issue_url: 'https://api.github.com/repos/other/repo/issues/12' }),
    comment('ack', { updated_at: 'invalid' })];
  for (const row of cases) { const result = await read([row]); assert.equal(result.responseStatus.status, 'error'); assert.equal(result.agentAck, null); }
});
test('follows only generated same-repo page paths and refuses incomplete pagination', async () => {
  const paths = [];
  const [result] = await readIssueResponses(env, [item()], async (url, options) => {
    paths.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, 'Bearer synthetic-secret');
    return response(paths.length === 1 ? [comment()] : [], { link: '<https://evil.example/>; rel="next"' });
  });
  assert.equal(paths.length, 2); assert.ok(paths.every(url => url.startsWith(`https://api.github.com/repos/${repo}/issues/12/comments?`)));
  assert.deepEqual(result.responseStatus, { status: 'incomplete', reason: 'page_limit' }); assert.equal(result.agentAck, null);
});
test('two complete pages are accepted; overlapping pagination remains unknown', async () => {
  let page = 0;
  const [complete] = await readIssueResponses(env, [item()], async () => ++page === 1 ? response([comment()], { link: '<https://example.invalid/>; rel="next"' }) : response([comment('result')]));
  assert.ok(complete.agentAck); assert.ok(complete.agentResult);
  page = 0;
  const [overlap] = await readIssueResponses(env, [item()], async () => response([comment()], ++page === 1 ? { link: '<https://example.invalid/>; rel="next"' } : {}));
  assert.deepEqual(overlap.responseStatus, { status: 'incomplete', reason: 'pagination_overlap' });
});
test('at most five newest issue groups are inspected; other rows explicitly say not_inspected', async () => {
  const items = Array.from({ length: 7 }, (_, i) => item({ updatedAt: i + 1, receipt: { ...item().receipt, issueNumber: i + 1, url: `https://github.com/${repo}/issues/${i + 1}` } }));
  const urls = [];
  const rows = await readIssueResponses(env, items, async url => { urls.push(url); return response([]); });
  assert.equal(urls.length, 5); assert.match(urls[0], /issues\/7\/comments/);
  assert.equal(rows[0].responseStatus.status, 'not_inspected'); assert.equal(rows[1].responseStatus.status, 'not_inspected'); assert.equal(rows[6].responseStatus.status, 'empty');
});
test('items sharing a receipt issue share one fetch, but markers bind to their exact outbox IDs', async () => {
  let calls = 0;
  const rows = await readIssueResponses(env, [item(), item({ id: '22222222-2222-4222-8222-222222222222' })], async () => { calls++; return response([comment()]); });
  assert.equal(calls, 1); assert.ok(rows[0].agentAck); assert.equal(rows[1].agentAck, null);
});
test('upstream authorization/errors/bodies never become ACK or leak raw error strings', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const [row] = await readIssueResponses(env, [item()], async () => new Response('synthetic-secret private stack', { status }));
    assert.equal(row.responseStatus.status, 'error'); assert.equal(row.agentResult, null); assert.doesNotMatch(JSON.stringify(row), /synthetic-secret|private stack/);
  }
});
test('oversized streaming body, malformed JSON and redirect are unavailable, not completion', async () => {
  for (const make of [() => new Response('x'.repeat(256 * 1024 + 1)), () => new Response('{broken'), () => ({ ok: true, redirected: true, headers: new Headers(), body: {} })]) {
    const [row] = await readIssueResponses(env, [item()], async () => make()); assert.equal(row.responseStatus.status, 'error'); assert.equal(row.agentAck, null);
  }
});
test('five-second batch deadline bounds an unresponsive transport and leaves later groups uninspected', async () => {
  const rows = await readIssueResponses(env, [item({ updatedAt: 2 }), item({ receipt: { ...item().receipt, issueNumber: 13, url: `https://github.com/${repo}/issues/13` } })], () => new Promise(() => {}));
  assert.deepEqual(rows[0].responseStatus, { status: 'error', reason: 'timeout' });
  assert.deepEqual(rows[1].responseStatus, { status: 'not_inspected', reason: 'budget_exhausted' });
});

test('login alone or numeric ID alone cannot impersonate configured actor', async () => {
  for (const user of [{id:999,login:'trusted-agent'}, {login:'trusted-agent'}, {id:12345,login:'forged'}]) {
    const result = await read([comment('ack', {user})]); assert.equal(result.agentAck,null); assert.equal(result.responseStatus.status,'empty');
  }
});

test('stream that never finishes is bounded by the shared deadline', async () => {
 const [row] = await readIssueResponses(env, [item()], async () => new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('[')); }})));
 assert.equal(row.responseStatus.reason,'timeout'); assert.equal(row.agentResult,null);
});
