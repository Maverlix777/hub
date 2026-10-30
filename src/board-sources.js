import { Buffer } from 'node:buffer';
import { buildBoard, statusAgeLabel } from './board.js';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PATH = /^[A-Za-z0-9_./-]+\.md$/;
export const DEFAULT_BOARD_PATHS = Object.freeze(['proposals/ai-factory-jobforge/BOARD.md', 'proposals/site-kolobovdjp/BOARD.md']);
// These are existing records, not an invented active idea registry. No private content is bundled.
export const DEFAULT_IDEA_SOURCES = Object.freeze([
  {path: 'reports/2026-10-21-case-studio-start/ideas-3dprint-apps.md', kind: 'ideas', name: 'Идеи приложений · запись 2026-10-21', provenance: 'historical-record'},
  {path: 'handoffs/doktor-workspace/20261020T072914Z-69fdd611e5a7f348/reports/01-2026-10-20-cloud-idea-factory-20-games.md', kind: 'ideas', name: 'Идеи игр · снимок 2026-10-20', provenance: 'historical-snapshot'},
  {path: 'proposals/site-kolobovdjp/plans/2026-10-23-personal-task-dashboard.md', kind: 'idea-document', name: 'Идея личного хаба · 2026-10-23', provenance: 'proposal'},
]);
const MAX_BYTES = 2 * 1024 * 1024;
// Closed diagnostics only: never expose upstream text, response bodies or credentials.
function httpFailure(status) {
  if ([401, 403, 404, 429].includes(status)) return 'http_' + status;
  return status >= 500 && status <= 599 ? 'http_5xx' : 'http_other';
}
class SourceReadError extends Error {
  constructor(code) { super(); this.code = code; }
}
function descriptors(env) {
  const boards = (env.BOARD_PATHS || DEFAULT_BOARD_PATHS.join(',')).split(',').map(path => path.trim()).filter(Boolean).map(path => ({path, kind: 'board', name: path.split('/').slice(-2, -1)[0] || path, provenance: 'task-board'}));
  const ideas = typeof env.BOARD_IDEA_PATHS === 'string'
    ? env.BOARD_IDEA_PATHS.split(',').map(path => path.trim()).filter(Boolean).map(path => ({path, kind: 'ideas', name: path, provenance: 'configured-record'}))
    : DEFAULT_IDEA_SOURCES;
  return [...new Map([...boards, ...ideas].map(s => [s.path, s])).values()];
}
async function boundedText(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new SourceReadError('oversized');
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  try {
    for (;;) { const {done, value} = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_BYTES) throw new SourceReadError('oversized'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
async function blobRevision(text) {
  const body = new TextEncoder().encode(text); const prefix = new TextEncoder().encode(`blob ${body.byteLength}\0`);
  const input = new Uint8Array(prefix.length + body.length); input.set(prefix); input.set(body, prefix.length);
  return Buffer.from(await crypto.subtle.digest('SHA-1', input)).toString('hex');
}
// Only explicit same-repository Issue links identify a task; PRs and task IDs are not Issues.
function issueForCard(card, repo) {
  const numbers = new Set();
  for (const match of card.description.matchAll(/https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)(?=$|[\s)#?])/g)) {
    if (match[1].toLowerCase() === repo.toLowerCase()) numbers.add(match[2]);
  }
  for (const link of card.evidence) {
    const url = new URL(link.url);
    const match = /^\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (url.hostname === 'github.com' && match?.[1].toLowerCase() === repo.toLowerCase()) numbers.add(match[2]);
  }
  return numbers.size === 1 ? [...numbers][0] : '';
}
const STATUS_LABELS = Object.freeze({
  'cloud:running': 'progress', 'cloud:review': 'review', 'cloud:ready': 'planned',
  'cloud:done': 'done', 'cloud:blocked': 'progress',
  claimed: 'progress', changes: 'progress', 'in-progress': 'progress', progress: 'progress',
  review: 'review', ready: 'planned', planned: 'planned', done: 'done', blocked: 'progress',
  'needs-owner': 'questions', idea: 'ideas',
});
async function labelStatus(env, repo, number, fetchImpl, signal) {
  const active = new Map();
  try {
    // Bounded complete history. A truncated history must never claim a current age.
    for (let page = 1; page <= 5; page++) {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${number}/events?per_page=100&page=${page}`, {
        headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${env.BOARD_GITHUB_TOKEN}`, 'user-agent': 'hub-board', 'x-github-api-version': '2022-11-28'},
        redirect: 'manual', signal,
      });
      let events;
      try {
        if (!response.ok || response.redirected) return null;
        events = JSON.parse(await boundedText(response));
      } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
      if (!Array.isArray(events)) return null;
      for (const event of events) {
        const label = event?.label?.name?.toLowerCase();
        if (!Object.hasOwn(STATUS_LABELS, label) || !['labeled', 'unlabeled'].includes(event.event)) continue;
        const time = Date.parse(event.created_at);
        if (!Number.isFinite(time) || time > Date.now() + 5 * 60000) return null;
        const previous = active.get(label);
        if (!previous || time >= previous.time) active.set(label, {time, since: event.created_at, column: STATUS_LABELS[label], active: event.event === 'labeled'});
      }
      if (events.length < 100) return [...active.values()].filter(s => s.active).sort((a, b) => b.time - a.time)[0] || null;
    }
  } catch { /* Optional event data cannot make the Markdown board unavailable. */ }
  return null;
}
async function addStatusAges(board, env, repo, fetchImpl) {
  const candidates = board.cards.filter(c => ['progress', 'review'].includes(c.column));
  const issues = [...new Set(candidates.map(c => issueForCard(c, repo)).filter(Boolean))];
  const statuses = new Map();
  // Sequential reads bound upstream concurrency and fan-out independently of board size.
  const signal = AbortSignal.timeout(10000);
  for (const number of issues.slice(0, 20)) {
    if (signal.aborted) break;
    statuses.set(number, await labelStatus(env, repo, number, fetchImpl, signal));
  }
  for (const card of candidates) {
    const status = statuses.get(issueForCard(card, repo));
    card.statusSince = status?.column === card.column ? status.since : '';
    card.statusAgeLabel = statusAgeLabel(card.statusSince);
  }
}
export async function loadBoardSources(env, fetchImpl = fetch) {
  const repo = env.BOARD_REPO || 'Maverlix777/agent-handoffs'; const sources = descriptors(env);
  if (!env.BOARD_GITHUB_TOKEN || !REPO.test(repo) || !sources.length || sources.length > 20 || sources.some(s => !PATH.test(s.path) || s.path.includes('..'))) return {error: 'board_unavailable'};
  const loaded = await Promise.all(sources.map(async source => {
    const base = {...source, url: `https://github.com/${repo}/blob/main/${source.path}`};
    const signal = AbortSignal.timeout(10000);
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${source.path.split('/').map(encodeURIComponent).join('/')}`, {
        headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${env.BOARD_GITHUB_TOKEN}`, 'user-agent': 'hub-board', 'x-github-api-version': '2022-11-28'},
        redirect: 'manual', signal,
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) return {...base, error: 'redirect_rejected'};
      if (!response.ok) return {...base, error: httpFailure(response.status)};
      const raw = await boundedText(response); let text = raw; let revision;
      if (/json/i.test(response.headers.get('content-type') || '')) {
        let data;
        try { data = JSON.parse(raw); } catch { throw new SourceReadError('invalid_json'); }
        if (!data || data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string' || !/^[a-f0-9]{40}$/.test(data.sha || '')) throw new SourceReadError('invalid_blob');
        text = Buffer.from(data.content, 'base64').toString('utf8'); revision = data.sha;
        if (Buffer.byteLength(text) > MAX_BYTES) throw new SourceReadError('oversized');
        if (await blobRevision(text) !== revision) throw new SourceReadError('invalid_blob');
      } else { revision = await blobRevision(text); }
      return {...base, text, revision};
    } catch (error) {
      const code = error instanceof SourceReadError ? error.code
        : signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_error';
      return {...base, error: code};
    } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }));
  const board = buildBoard(loaded);
  await addStatusAges(board, env, repo, fetchImpl);
  board.sources = board.sources.map((s, index) => ({...s, provenance: loaded[index].provenance}));
  return {board: {...board, fetchedAt: new Date().toISOString()}};
}
