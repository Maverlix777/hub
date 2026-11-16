import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/worker.js';

const origin = 'https://hub.kolobovdjp.org';
let assetPaths = [];
const env = {
  HUB_DB: { prepare() { throw new Error('D1 must not be touched for /locationfusion/'); } },
  ASSETS: { async fetch(request) {
    const { pathname } = new URL(request.url);
    assetPaths.push(pathname);
    return new Response(`asset:${pathname}`, { headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'x=1' } });
  } },
  CANONICAL_ORIGIN: origin,
  RP_ID: 'kolobovdjp.org',
};

function get(path, { method = 'GET' } = {}) {
  assetPaths = [];
  return worker.fetch(new Request(`${origin}${path}`, { method }), env);
}

for (const page of ['privacy', 'support']) {
  test(`GET /locationfusion/${page}/ is public, cookie-free, public cache`, async () => {
    const res = await get(`/locationfusion/${page}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), `asset:/locationfusion/${page}/index.html`);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.deepEqual(assetPaths, [`/locationfusion/${page}/index.html`]);
  });
}

test('other /locationfusion/ paths and non-GET methods are not served', async () => {
  for (const path of ['/locationfusion/', '/locationfusion/install/', '/locationfusion/privacy/x', '/locationfusion/privacy']) {
    const res = await get(path);
    assert.notEqual(res.status, 200, path);
    assert.deepEqual(assetPaths, [], path);
  }
  const post = await get('/locationfusion/privacy/', { method: 'POST' });
  assert.equal(post.status, 405);
});
