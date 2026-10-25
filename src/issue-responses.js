// Read-only projection of explicitly trusted executor comments. Never executes
// comment content and never infers acknowledgment from delivery or labels.
const REPO = 'Maverlix777/agent-handoffs';
const API = `https://api.github.com/repos/${REPO}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\[bot\])?$/i;
const MAX_ISSUES = 5;
const MAX_PAGES = 2;
const MAX_BYTES = 256 * 1024;
const MAX_TEXT = 8000;
const DEADLINE_MS = 5000;
const failure = (reason) => Object.assign(new Error(reason), { reason });

function receiptIssue(item) {
  const r = item?.receipt;
  if (item?.status !== 'synced' || !UUID.test(item.id || '') || !r
    || !['issue', 'comment'].includes(r.kind) || !Number.isSafeInteger(r.issueNumber) || r.issueNumber < 1) return null;
  try {
    const url = new URL(r.url);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search
      || url.pathname !== `/${REPO}/issues/${r.issueNumber}`) return null;
    if (r.kind === 'issue' ? (url.hash || r.commentId !== null)
      : (!Number.isSafeInteger(r.commentId) || r.commentId < 1 || url.hash !== `#issuecomment-${r.commentId}`)) return null;
    return r.issueNumber;
  } catch { return null; }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(failure('timeout')); return; }
    const aborted = () => reject(failure('timeout'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function readPage(response, signal) {
  if (response.redirected || !response.body || Number(response.headers.get('content-length')) > MAX_BYTES) throw failure('invalid_response');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = ''; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw failure('oversized');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const rows = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length > 100) throw failure('invalid_response');
    return rows;
  } finally { reader.cancel().catch(() => {}); }
}

async function commentsForIssue(issue, token, signal, fetchImpl) {
  const comments = []; const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await abortable(fetchImpl(`${API}/issues/${issue}/comments?per_page=100&page=${page}`, {
      method: 'GET', redirect: 'manual', signal,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
        'user-agent': 'hub-issue-responses', 'x-github-api-version': '2022-11-28' },
    }), signal);
    if (!response.ok) throw failure([401, 403, 404, 429].includes(response.status) ? `github_${response.status}` : 'github_unavailable');
    const rows = await readPage(response, signal);
    for (const row of rows) {
      if (!Number.isSafeInteger(row?.id) || row.id < 1) throw failure('invalid_response');
      if (seen.has(row.id)) throw failure('pagination_overlap');
      seen.add(row.id); comments.push(row);
    }
    // Never follow a URL provided by the response: pages use our fixed API path.
    const next = /;\s*rel="next"/i.test(response.headers.get('link') || '');
    if (!next) { if (rows.length === 100) throw failure('page_limit'); return comments; }
    if (page === MAX_PAGES) throw failure('page_limit');
  }
  return comments;
}

function responseForItem(item, issue, comments, trustedLogin, trustedId) {
  const matches = { ack: [], result: [] };
  const prefix = `<!-- hub-response:${item.id}:`;
  for (const comment of comments) {
    if (comment.user?.id !== trustedId || typeof comment.user?.login !== 'string' || comment.user.login.toLowerCase() !== trustedLogin.toLowerCase()
      || typeof comment.body !== 'string' || !comment.body.startsWith(prefix)) continue;
    const match = /^<!-- hub-response:([0-9a-f-]+):(ack|result) -->\r?\n([\s\S]*)$/.exec(comment.body);
    if (!match || match[1] !== item.id) continue;
    const text = match[3].trim();
    const url = `https://github.com/${REPO}/issues/${issue}#issuecomment-${comment.id}`;
    const created = Date.parse(comment.created_at); const updated = Date.parse(comment.updated_at);
    if (!text || text.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
      || comment.html_url !== url || comment.issue_url !== `${API}/issues/${issue}`
      || typeof comment.created_at !== 'string' || typeof comment.updated_at !== 'string'
      || !Number.isFinite(created) || !Number.isFinite(updated) || updated < created) throw failure('invalid_response');
    matches[match[2]].push({ text, url, createdAt: comment.created_at, updatedAt: comment.updated_at, author: comment.user.login });
  }
  if (matches.ack.length > 1 || matches.result.length > 1) return { agentAck: null, agentResult: null, responseStatus: { status: 'conflict', reason: 'duplicate_marker' } };
  return { agentAck: matches.ack[0] || null, agentResult: matches.result[0] || null,
    responseStatus: { status: matches.ack.length || matches.result.length ? 'available' : 'empty' } };
}

/** Annotate an owner-scoped page of persisted items. No database writes or cache. */
export async function readIssueResponses(env, items, fetchImpl = fetch) {
  const trustedId = Number(env.HUB_RESPONSE_GITHUB_ID);
  const configured = /^[1-9][0-9]*$/.test(String(env.HUB_RESPONSE_GITHUB_ID || '')) && Number.isSafeInteger(trustedId) && typeof env.HUB_RESPONSE_GITHUB_LOGIN === 'string' && LOGIN.test(env.HUB_RESPONSE_GITHUB_LOGIN)
    && typeof env.HUB_ISSUES_GITHUB_TOKEN === 'string' && Boolean(env.HUB_ISSUES_GITHUB_TOKEN);
  const result = items.map(item => ({ ...item, agentAck: null, agentResult: null,
    responseStatus: { status: configured ? 'not_delivered' : 'not_configured' } }));
  if (!configured) return result;
  const groups = new Map();
  for (const item of result) {
    const issue = receiptIssue(item); if (!issue) continue;
    item.responseStatus = { status: 'not_inspected', reason: 'issue_limit' };
    const group = groups.get(issue) || { issue, items: [], newest: 0 };
    group.items.push(item);
    group.newest = Math.max(group.newest, Number(item.updatedAt) || Number(item.createdAt) || 0);
    groups.set(issue, group);
  }
  const selected = [...groups.values()].sort((a, b) => b.newest - a.newest).slice(0, MAX_ISSUES);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    for (const group of selected) {
      if (controller.signal.aborted) {
        for (const item of group.items) item.responseStatus = { status: 'not_inspected', reason: 'budget_exhausted' };
        continue;
      }
      try {
        const comments = await commentsForIssue(group.issue, env.HUB_ISSUES_GITHUB_TOKEN, controller.signal, fetchImpl);
        for (const item of group.items) {
          try { Object.assign(item, responseForItem(item, group.issue, comments, env.HUB_RESPONSE_GITHUB_LOGIN, trustedId)); }
          catch { item.responseStatus = { status: 'error', reason: 'invalid_response' }; }
        }
      } catch (error) {
        const reason = controller.signal.aborted || error?.name === 'AbortError' ? 'timeout'
          : ['github_401', 'github_403', 'github_404', 'github_429', 'github_unavailable', 'page_limit', 'pagination_overlap', 'oversized', 'invalid_response'].includes(error?.reason)
            ? error.reason : 'unavailable';
        for (const item of group.items) item.responseStatus = { status: ['page_limit', 'pagination_overlap'].includes(reason) ? 'incomplete' : 'error', reason };
      }
    }
  } finally { clearTimeout(timer); }
  return result;
}
