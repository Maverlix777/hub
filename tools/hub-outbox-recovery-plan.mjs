/** Pure browser-neutral selection. No timer, browser, fetch, secret or owner-text execution. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BOARD = 'https://hub.kolobovdjp.org/hub/apps/board.html';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const USER = /^[A-Za-z0-9_.-]{1,80}$/;
const COOLDOWN = 30 * 60 * 1000;
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => names.includes(key)) && names.every(key => Object.hasOwn(value, key));
const stop = reason => ({ action: 'stop', reason });

/** Admission is trusted operator context, never supplied by page/issue prose. It is not an authorization grant. */
export function planRecovery(observation, admission, policy, now = Date.now()) {
  if (!exact(policy, ['automationId', 'threadId', 'scope']) || !/^[a-z][a-z0-9-]{1,99}$/.test(policy.automationId || '')
    || !UUID.test(policy.threadId || '') || policy.scope !== 'recover-own-hub-outbox') return stop('trusted_policy_required');
  if (!exact(admission, ['automationId', 'threadId', 'turnId', 'approvedScope', 'authenticatedUsername', 'selfOwned', 'stopped', 'remainingMs', 'attempts'])
    || admission.automationId !== policy.automationId || admission.threadId !== policy.threadId
    || !UUID.test(admission.turnId || '') || admission.approvedScope !== policy.scope
    || !USER.test(admission.authenticatedUsername || '') || admission.selfOwned !== true || admission.stopped !== false) return stop('admission_required');
  if (!Number.isFinite(admission.remainingMs) || admission.remainingMs < 40000) return stop('budget_exhausted');
  if (!Number.isSafeInteger(now) || !Array.isArray(admission.attempts) || admission.attempts.length > 500) return stop('invalid_journal');
  const recent = new Map();
  for (const attempt of admission.attempts) {
    if (!exact(attempt, ['turnId', 'itemId', 'state', 'attemptedAt']) || !UUID.test(attempt.turnId || '') || !UUID.test(attempt.itemId || '')
      || !['attempted', 'verified', 'unconfirmed'].includes(attempt.state) || !Number.isSafeInteger(attempt.attemptedAt)
      || attempt.attemptedAt < 0 || attempt.attemptedAt > now) return stop('invalid_journal');
    if (attempt.turnId === admission.turnId) return stop('already_attempted_this_turn');
    recent.set(attempt.itemId, Math.max(recent.get(attempt.itemId) || 0, attempt.attemptedAt));
  }
  if (!exact(observation, ['url', 'observedAt', 'ownerSessionVerified', 'username', 'delivery', 'rows', 'hasMore'])
    || observation.url !== BOARD || observation.ownerSessionVerified !== true
    || observation.username !== admission.authenticatedUsername) return stop('authenticated_owner_browser_required');
  if (!Number.isSafeInteger(observation.observedAt) || observation.observedAt > now || now - observation.observedAt > 30000) return stop('stale_observation');
  if (observation.delivery !== 'enabled') return stop('delivery_not_enabled');
  if (!Array.isArray(observation.rows) || observation.rows.length > 100 || typeof observation.hasMore !== 'boolean') return stop('invalid_observation');
  const seen = new Set();
  for (const row of observation.rows) {
    if (!exact(row, ['id', 'authorUsername', 'status', 'createdAt', 'retryVisible', 'retryEnabled', 'hasReceipt'])
      || !UUID.test(row.id || '') || seen.has(row.id) || !USER.test(row.authorUsername || '')
      || !['pending', 'error', 'conflict', 'synced'].includes(row.status) || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0
      || typeof row.retryVisible !== 'boolean' || typeof row.retryEnabled !== 'boolean' || typeof row.hasReceipt !== 'boolean') return stop('invalid_observation');
    seen.add(row.id);
    if (row.authorUsername !== admission.authenticatedUsername) return stop('author_scope_mismatch');
  }
  const due = observation.rows.filter(row => ['pending', 'error'].includes(row.status) && row.retryVisible && row.retryEnabled && !row.hasReceipt
    && (!recent.has(row.id) || now - recent.get(row.id) >= COOLDOWN))
    .sort((a, b) => (recent.get(a.id) ?? -1) - (recent.get(b.id) ?? -1) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (!due.length) return { action: 'no_op', reason: observation.hasMore ? 'no_eligible_visible_rows_more_uninspected' : 'no_eligible_visible_rows_or_cooldown' };
  const id = due[0].id;
  return { action: 'click_existing_retry', itemId: id, selector: `#outbox-list > [data-receipt-id="${id}"] .retry-delivery`,
    maxClicks: 1, journalBeforeClick: { turnId: admission.turnId, itemId: id, state: 'attempted', attemptedAt: now },
    expectedEffect: 'same-key-owner-post_then_lease-guarded_delivery_or_reconciliation' };
}

function readJSON(path) {
  const bytes = readFileSync(path); if (bytes.length > 64 * 1024) throw new Error('input_too_large');
  return JSON.parse(bytes.toString('utf8'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) throw new Error('usage');
    process.stdout.write(JSON.stringify(planRecovery(readJSON(process.argv[2]), readJSON(process.argv[3]), readJSON(process.argv[4]))) + '\n');
  } catch { process.stderr.write('{"action":"stop","reason":"invalid_input"}\n'); process.exitCode = 1; }
}
