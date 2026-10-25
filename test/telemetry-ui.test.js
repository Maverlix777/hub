import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const code = await readFile(new URL('../public/apps/board.js', import.meta.url), 'utf8');
// Focus, dialog and event behavior are covered by the real browser suite. This
// small DOM model independently checks the source-claim rendering boundary.
class Node {
  constructor() { this.children = []; this.textContent = ''; this.value = ''; this.dataset = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener() {}
  setAttribute() {}
  querySelector(selector) { this.queries ||= {}; return this.queries[selector] ||= new Node(); }
  text() { return this.textContent + this.children.map((node) => node.text()).join(' '); }
}
async function render(telemetry) {
  const nodes = {};
  const get = (id) => nodes[id] ||= new Node();
  vm.runInNewContext(code, {
    URL, Date,
    history: {state:null},
    document: { getElementById: get, createElement: () => new Node(), createTextNode: (text) => Object.assign(new Node(),{textContent:text}), addEventListener() {} },
    window: { location: { replace() { throw Error('unexpected redirect'); } }, addEventListener() {}, setInterval() {} },
    fetch: async (url) => ({ ok: true, status: 200, json: async () => url.endsWith('/outbox') ? {items:[],delivery:{status:'not_configured'}} : { cards: [{ id: 'manual', title: 'Manual title', who: 'Owner', state: 'Done', column: 'done' }], telemetry } }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  return nodes;
}
test('UI separates source reports from manual board and labels unavailable metrics', async () => {
  const missing = await render(undefined);
  assert.match(missing.telemetry.text(), /Свежесть неизвестна/);
  assert.match(missing.telemetry.text(), /Последняя проверка Hub Нет данных/);
  assert.match(missing.columns.text(), /Manual title/);
  const nodes = await render({ status: 'available', as_of: '2026-10-25T06:00:00Z',
    events: [{ task_id: 'TEST-1', state: 'result_reported', producer_claimed_verified: true, observed_at: '2026-10-25T06:00:00Z' }],
    runs: [{ model: 'example', eval_count: null, eval_seconds: null, tokens_per_second: null }],
    gpu: { status: 'unknown', samples: [] } });
  assert.match(nodes.telemetry.text(), /Результат заявлен источником/);
  assert.match(nodes.telemetry.text(), /Проверка заявлена источником; Хаб её не выполнял/);
  assert.match(nodes.telemetry.text(), /Исполнитель: не указан/);
  assert.match(nodes.telemetry.text(), /не подтверждение/);
  assert.match(nodes.columns.text(), /Manual title/);
  assert.doesNotMatch(nodes.columns.text(), /TEST-1/);
});
