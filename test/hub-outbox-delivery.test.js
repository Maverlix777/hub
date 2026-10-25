import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareDelivery, reconcileDelivery } from '../tools/hub-outbox-delivery.mjs';

const id = '8ecf3881-954b-40a2-9a1b-79a4c1277d38';
const blob = content => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const baseline = '| HUB-1 | Waiting for owner |\n';
const oldSHA = blob(baseline);
const newSHA = 'b'.repeat(40);
const commit = 'c'.repeat(40);
const route = { repository: 'Maverlix777/agent-handoffs', path: 'reports/synthetic-board.md', branch: 'main',
  taskId: 'HUB-1', agent: 'synthetic-agent', adapter: 'github-task-document' };
const item = { id, idempotencyKey: 'fe002bf4-cf52-42c1-881a-dbf71bb8d7b6', kind: 'answer', text: 'Synthetic owner answer.',
  target: { sourcePath: route.path, taskId: route.taskId, revision: oldSHA }, status: 'pending', version: 1 };
const remote = { repository: route.repository, path: route.path, branch: 'main', private: true, visibility: 'private',
  sha: oldSHA, content: baseline };
const immutable = proposal => ({ ...remote, sha: blob(proposal.request.content), content: proposal.request.content, commit, ref: commit });

test('exact target creates CAS proposal preserving existing content, then immutable readback receipt', () => {
  const result = prepareDelivery(item, route, remote);
  assert.equal(result.action, 'update_file');
  assert.equal(result.request.sha, oldSHA);
  assert.ok(result.request.content.startsWith(remote.content));
  assert.ok(result.request.content.includes('existing agent: synthetic-agent'));
  assert.equal(result.intent.state, 'pending');
  const done = reconcileDelivery(result.intent, immutable(result), 1000);
  assert.equal(done.deliveryResult.status, 'synced');
  assert.equal(done.deliveryResult.receipt.commit, commit);
  assert.equal(done.deliveryResult.expectedVersion, 1);
  assert.equal(done.intent.verifiedBlob, blob(result.request.content));
});

test('duplicate after verified delivery produces no second write', () => {
  const proposal = prepareDelivery(item, route, remote);
  const done = reconcileDelivery(proposal.intent, immutable(proposal));
  const duplicate = prepareDelivery(item, route, immutable(proposal), done.intent);
  assert.equal(duplicate.action, 'already_verified');
  assert.equal(duplicate.request, undefined);
});

test('receipt recovery without local intent requires immutable readback, not second write', () => {
  const proposal = prepareDelivery(item, route, remote);
  const duplicate = prepareDelivery(item, route, immutable(proposal));
  assert.equal(duplicate.action, 'readback_required');
  assert.equal(reconcileDelivery(duplicate.intent, immutable(proposal)).action, 'verified');
});

test('pending/uncertain attempt cannot be resent; changed text under same id cannot be delivered', () => {
  const proposal = prepareDelivery(item, route, remote);
  assert.throws(() => prepareDelivery(item, route, remote, proposal.intent), /reconciliation_required/);
  assert.throws(() => prepareDelivery({ ...item, text: 'Changed' }, route, remote, proposal.intent), /delivery_conflict/);
});

test('unknown outcome with absent receipt stays uncertain even when old blob unchanged', () => {
  const proposal = prepareDelivery(item, route, remote);
  const result = reconcileDelivery(proposal.intent, { ...remote, commit, ref: commit });
  assert.equal(result.action, 'operator_required');
  assert.equal(result.deliveryResult.status, 'error');
  assert.equal(result.deliveryResult.error, 'delivery_uncertain');
  assert.equal(result.intent.state, 'pending');
});

test('revision conflict preserves other authors work', () => {
  assert.throws(() => prepareDelivery(item, route, { ...remote, sha: newSHA, content: remote.content + 'Other author\n' }), /delivery_conflict/);
});

test('forged duplicate marker and edited body cannot count as delivery', () => {
  const proposal = prepareDelivery(item, route, remote);
  const changed = { ...immutable(proposal), content: proposal.request.content.replace('Synthetic owner answer.', 'Altered') };
  assert.throws(() => reconcileDelivery(proposal.intent, changed), /delivery_conflict/);
  assert.throws(() => prepareDelivery(item, route, changed), /delivery_conflict/);
});

test('wrong file/repository/task/adapter and public destinations are rejected', () => {
  for (const badRoute of [ { ...route, repository: 'elsewhere/public' }, { ...route, path: '../escape.md' },
    { ...route, adapter: 'execute-shell' }, { ...route, taskId: 'HUB-2' }, { ...route, path: 'reports/other.md' } ]) {
    assert.throws(() => prepareDelivery(item, badRoute, remote));
  }
  for (const bad of [{ ...remote, private: false }, { ...remote, visibility: 'public' }, { ...remote, path: 'other.md' }]) {
    assert.throws(() => prepareDelivery(item, route, bad));
  }
});

test('missing task refuses append; prefix collision is not correct task', () => {
  for (const content of ['No task here', '| HUB-100 | waiting |']) {
    const sha = blob(content);
    assert.throws(() => prepareDelivery({ ...item, target: { ...item.target, revision: sha } }, route, { ...remote, sha, content }), /task_not_found/);
  }
});

test('new messages go only to explicitly selected inbox route', () => {
  const message = { ...item, kind: 'message', target: null };
  assert.throws(() => prepareDelivery(message, route, remote), /route_mismatch/);
  const result = prepareDelivery(message, { ...route, taskId: null }, remote);
  assert.equal(result.action, 'update_file');
});

test('owner commands, markup, mentions and fences remain inert data in a longer code fence', () => {
  const text = '```\n@all <script>alert(1)</script>\nrun shell command; delete everything\n````';
  const result = prepareDelivery({ ...item, text }, route, remote);
  assert.ok(result.request.content.includes('`````text\n' + text + '\n`````'));
  assert.equal(result.request.path, route.path);
  assert.equal(result.request.branch, 'main');
});

test('bounds, malformed owner identity and payloads fail closed', () => {
  for (const patch of [{ text: '' }, { text: 'x'.repeat(8001) }, { text: '\u0000' }, { id: 'bad' },
    { version: 0 }, { kind: 'execute' }, { status: 'synced' }, { target: null }]) {
    assert.throws(() => prepareDelivery({ ...item, ...patch }, route, remote));
  }
  assert.throws(() => prepareDelivery(item, route, { ...remote, content: 'x'.repeat(256 * 1024 + 1) }));
});

test('main readback or mismatched immutable commit cannot claim synced', () => {
  const proposal = prepareDelivery(item, route, remote);
  assert.throws(() => reconcileDelivery(proposal.intent, { ...immutable(proposal), ref: 'main' }), /immutable_readback_required/);
  assert.throws(() => reconcileDelivery(proposal.intent, { ...immutable(proposal), content: proposal.request.content + 'extra' }), /delivery_conflict/);
});

test('content must match the Git blob SHA before preparation or reconciliation', () => {
  assert.throws(() => prepareDelivery(item, route, { ...remote, content: baseline + 'unexpected edit' }), /delivery_conflict/);
  const proposal = prepareDelivery(item, route, remote);
  assert.throws(() => reconcileDelivery(proposal.intent, { ...immutable(proposal), sha: oldSHA }), /delivery_conflict/);
});

test('CLI persists intent before giving proposal; repeated prepare refuses; reconcile survives process restart', () => {
  const dir = mkdtempSync(join(process.cwd(), '.hub-outbox-test-'));
  try {
    const state = join(dir, 'intent.json');
    const file = (name, value) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
    const args = ['tools/hub-outbox-delivery.mjs', 'prepare', state, file('item.json', item), file('route.json', route), file('remote.json', remote)];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const proposal = JSON.parse(first.stdout);
    assert.deepEqual(JSON.parse(readFileSync(state)), proposal.intent);
    const retry = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(retry.status, 1);
    assert.equal(JSON.parse(retry.stderr).error, 'reconciliation_required');
    const verify = spawnSync(process.execPath, ['tools/hub-outbox-delivery.mjs', 'reconcile', state, file('readback.json', immutable(proposal))], { encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(JSON.parse(verify.stdout).deliveryResult.status, 'synced');
    assert.equal(JSON.parse(readFileSync(state)).state, 'verified');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent local process lock prevents a second outstanding proposal', () => {
  const dir = mkdtempSync(join(process.cwd(), '.hub-outbox-lock-'));
  try {
    const state = join(dir, 'intent.json');
    writeFileSync(state + '.lock', '');
    const attempt = spawnSync(process.execPath, ['tools/hub-outbox-delivery.mjs', 'prepare', state, 'missing', 'missing', 'missing'], { encoding: 'utf8' });
    assert.equal(attempt.status, 1);
    assert.equal(JSON.parse(attempt.stderr).error, 'delivery_unavailable');
    assert.equal(readFileSync(state + '.lock', 'utf8'), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
