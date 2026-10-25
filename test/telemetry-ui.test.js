import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const code = await readFile(new URL('../public/apps/board.js', import.meta.url), 'utf8');
class Node {
  constructor() { this.children = []; this.textContent = ''; this.value = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener() {}
  text() { return this.textContent + this.children.map((node) => node.text()).join(' '); }
}
async function render(telemetry) {
  const nodes = Object.fromEntries(['status', 'columns', 'q', 'telemetry'].map((id) => [id, new Node()]));
  vm.runInNewContext(code, {
    document: { getElementById: (id) => nodes[id], createElement: () => new Node() },
    window: { location: { replace() { throw Error('unexpected redirect'); } } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ cards: [{ id: 'manual', title: 'Manual title', who: 'Owner', state: 'Done', column: 'done' }], telemetry }) }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  return nodes;
}
test('UI separates source reports from manual board and labels unavailable metrics', async () => {
  const missing = await render(undefined);
  assert.match(missing.telemetry.text(), /unknown/);
  assert.match(missing.columns.text(), /Manual title/);
  const nodes = await render({ status: 'available', as_of: '2026-10-25T06:00:00Z',
    events: [{ task_id: 'TEST-1', state: 'result_reported', producer_claimed_verified: true, observed_at: '2026-10-25T06:00:00Z' }],
    runs: [{ model: 'example', eval_count: null, eval_seconds: null, tokens_per_second: null }],
    gpu: { status: 'unknown', samples: [] } });
  assert.match(nodes.telemetry.text(), /result_reported/);
  assert.match(nodes.telemetry.text(), /unknown/);
  assert.match(nodes.telemetry.text(), /не подтверждение/);
  assert.match(nodes.columns.text(), /Manual title/);
  assert.doesNotMatch(nodes.columns.text(), /TEST-1/);
});
