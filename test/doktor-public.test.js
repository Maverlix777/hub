import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/worker.js';

const origin = 'https://kolobovdjp.org';
let assetPaths = [];
const env = {
  HUB_DB: { prepare() { throw new Error('D1 must not be touched for /doktor/'); } },
  ASSETS: { async fetch(request) {
    const { pathname } = new URL(request.url);
    assetPaths.push(pathname);
    if (pathname.endsWith('nope.html')) return new Response('missing', { status: 404 });
    return new Response(`asset:${pathname}`, { headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'x=1' } });
  } },
  CANONICAL_ORIGIN: origin,
  HUB_GATEWAY_ORIGIN: 'https://kolobovdjp-hub.workers.dev',
  HUB_GATEWAY_SECRET: 'test-gateway-secret-with-at-least-32-bytes',
  RP_ID: 'kolobovdjp.org',
};

function get(path, { method = 'GET', base = origin } = {}) {
  assetPaths = [];
  return worker.fetch(new Request(`${base}${path}`, { method }), env);
}

test('GET /doktor/privacy.html is public with security headers and public cache', async () => {
  const res = await get('/doktor/privacy.html');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'asset:/doktor/privacy.html');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(res.headers.get('set-cookie'), null);
  assert.deepEqual(assetPaths, ['/doktor/privacy.html']);
});

test('HEAD /doktor/privacy.html is 200', async () => {
  const res = await get('/doktor/privacy.html', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
});

test('/doktor redirects to /doktor/', async () => {
  const res = await get('/doktor');
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), `${origin}/doktor/`);
});

test('directories resolve to index.html', async () => {
  await get('/doktor/');
  assert.deepEqual(assetPaths, ['/doktor/index.html']);
  await get('/doktor/blog/');
  assert.deepEqual(assetPaths, ['/doktor/blog/index.html']);
});

test('traversal attempts never reach /hub/ content', async () => {
  const dotted = await get('/doktor/../hub/index.html');
  assert.notEqual(dotted.status, 200);
  assert.equal(dotted.headers.get('location'), `${origin}/hub/login/`);
  assert.deepEqual(assetPaths, []);
  // URL parsing folds %2E%2E into /hub/index.html, which still needs a session.
  const encoded = await get('/doktor/%2E%2E/hub/index.html');
  assert.equal(encoded.status, 302);
  assert.equal(encoded.headers.get('location'), `${origin}/hub/login/`);
  assert.deepEqual(assetPaths, []);
  for (const path of ['/doktor/%2e%2e/x', '/doktor/a%5c..%5cb', '/doktor/%252e%252e/x']) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
    assert.deepEqual(assetPaths, [], path);
  }
});

test('non-GET methods are 405', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await get('/doktor/privacy.html', { method });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
    assert.deepEqual(assetPaths, []);
  }
});

test('missing page is 404 and not cached publicly', async () => {
  const res = await get('/doktor/nope.html');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('noncanonical origin without gateway is 404 before assets', async () => {
  for (const base of ['https://example.com', 'https://kolobovdjp-hub.workers.dev']) {
    const res = await get('/doktor/privacy.html', { base });
    assert.equal(res.status, 404);
    assert.deepEqual(assetPaths, []);
  }
});

test('valid gateway request reaches /doktor/ assets', async () => {
  assetPaths = [];
  const res = await worker.fetch(new Request('https://kolobovdjp-hub.workers.dev/doktor/terms.html', {
    headers: { 'x-hub-gateway-token': env.HUB_GATEWAY_SECRET, 'x-hub-client-ip': '192.0.2.44' },
  }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(assetPaths, ['/doktor/terms.html']);
});
