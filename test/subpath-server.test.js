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
