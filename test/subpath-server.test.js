import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createServer } = require('../tests/check-subpath.cjs');

test('subpath trap serves the synthetic board API and still rejects missing routes', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = await (await fetch(`${base}/hub/api/session`)).json();
    assert.deepEqual(session.apps, ['board', 'chat', 'downloads']);
    assert.match(await (await fetch(`${base}/hub/`)).text(), /id="columns"/);
    assert.match(await (await fetch(`${base}/hub/index.html`)).text(), /id="grid"/);
    assert.match(await (await fetch(`${base}/hub/apps/board.html`)).text(), /id="columns"/);
    const response = await fetch(`${base}/hub/api/board`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.cards[0].id, 'SYNTHETIC-1');
    assert.equal(body.cards[0].who, 'test');
    assert.equal(body.counts.review, 1);
    assert.equal(body.cards[0].column, 'review');
    assert.equal(body.telemetry.status, 'unknown');
    const outbox = await fetch(`${base}/hub/api/outbox`);
    assert.equal(outbox.status, 200);
    assert.deepEqual(await outbox.json(), { items: [], nextCursor: null, delivery: { status: 'not_configured' } });
    const pushConfig = await fetch(`${base}/hub/api/push/config`);
    assert.equal(pushConfig.status, 200);
    assert.equal(pushConfig.headers.get('cache-control'), 'no-store');
    const publicKey = (await pushConfig.json()).publicKey;
    assert.match(publicKey, /^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
    assert.equal(Buffer.from(publicKey, 'base64url')[0], 4);
    assert.equal((await fetch(`${base}/api/push/config`)).status, 404);
    assert.equal((await fetch(`${base}/hub/api/push/config`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/hub/api/push/subscriptions`)).status, 404);
    assert.equal((await fetch(`${base}/api/outbox`)).status, 404);
    assert.equal((await fetch(`${base}/hub/api/outbox`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/api/board`)).status, 404);
    assert.equal((await fetch(`${base}/hub/api/missing`)).status, 404);
    assert.equal((await fetch(`${base}/hub/missing.js`)).status, 404);
    assert.equal((await fetch(`${base}/hub/api/board`, { method: 'POST' })).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
