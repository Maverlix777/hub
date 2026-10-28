import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/worker.js';

const origin = 'https://kolobovdjp.org';
const token = '0123456789abcdef0123456789abcdef';
const env = {
  HUB_DB: { prepare() { throw new Error('D1 must not be touched for hidden pages'); } },
  ASSETS: { async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(`/s/${token}/`)) return new Response(`asset:${pathname}`, { headers: { 'content-type': 'text/plain', 'set-cookie': 'x=1' } });
    return new Response('missing', { status: 404 });
  } },
  CANONICAL_ORIGIN: origin,
  HUB_GATEWAY_ORIGIN: 'https://kolobovdjp-hub.workers.dev',
  HUB_GATEWAY_SECRET: 'test-gateway-secret-with-at-least-32-bytes',
  RP_ID: 'kolobovdjp.org',
};
const get = (path, method = 'GET') => worker.fetch(new Request(`${origin}${path}`, { method }), env);

test('hidden page is public, noindex, no cookie', async () => {
  const res = await get(`/hub/s/${token}/`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), `asset:/s/${token}/index.html`);
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.match(res.headers.get('content-type'), /^text\/html/);
});

test('hidden file downloads as attachment', async () => {
  const res = await get(`/hub/s/${token}/LocationFusion-Start.shortcut`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="LocationFusion-Start\.shortcut"$/);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
});

test('wrong token, short token, other file types and writes are refused', async () => {
  for (const path of ['/hub/s/ffffffffffffffffffffffffffffffff/', '/hub/s/abc/', `/hub/s/${token}/secret.txt`, `/hub/s/${token}/../x`]) {
    const res = await get(path);
    assert.ok([302, 400, 404].includes(res.status), `${path} -> ${res.status}`);
    assert.notEqual(res.status, 200);
  }
  assert.equal((await get(`/hub/s/${token}/`, 'POST')).status, 405);
});
