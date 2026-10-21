import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import worker from '../src/worker.js';

const origin = 'https://kolobovdjp.org';
const rpID = 'kolobovdjp.org';
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
const db = {
  prepare: statement,
  batch(items) {
    sqlite.exec('BEGIN');
    try {
      const results = items.map((item) => item.run());
      sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
};
const env = {
  HUB_DB: db,
  ASSETS: { async fetch() { return new Response('asset'); } },
  CANONICAL_ORIGIN: origin,
  RP_ID: rpID,
  RP_NAME: 'Hub Test',
  RATE_LIMIT_HMAC_KEY: 'test-only-secret-not-logged-test-only',
};
after(() => sqlite.close());

function post(path, body, { ip = '192.0.2.50', headers = {} } = {}) {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'CF-Connecting-IP': ip, ...headers },
    body: JSON.stringify(body),
  });
}

test('site13: without env.CANONICAL_ORIGIN the default origin passes the Origin check', async () => {
  const { CANONICAL_ORIGIN, ...bare } = env;
  const response = await worker.fetch(post('/hub/api/login/options', { username: 'nobody.here' }, { ip: '192.0.2.52' }), bare);
  assert.notEqual(response.status, 403);
  assert.equal(response.status, 401);
});

test('site13: POST with a foreign Origin is 403 forbidden_origin', async () => {
  const response = await worker.fetch(post('/hub/api/login/options', { username: 'nobody.here' },
    { ip: '192.0.2.53', headers: { origin: 'https://evil.example' } }), env);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'forbidden_origin' });
});
