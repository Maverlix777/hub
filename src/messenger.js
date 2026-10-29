// Mini messenger over GitHub issues. The token stays in the Worker; the browser only sees
// sanitized thread data for issues that this owner's own synced outbox items created.
const REPO = 'Maverlix777/agent-handoffs';
const API = `https://api.github.com/repos/${REPO}`;
const MAX_TEXT = 8000;
const MARKER = /^<!-- hub-(?:outbox|reply):[^>]*-->/;
const AGENT_MARKER = /^<!-- agent:(claude|codex|snezhana|pedro) -->(?:\r?\n|$)/;
const LEGACY_AGENT_MARKER = /^<!-- snezhana-answer -->(?:\r?\n|\\n|$)/;
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', snezhana: 'Снежана', pedro: 'Педро' };
const failure = (code) => Object.assign(new Error(code), { code });

function tokenReady(env) {
  return env.HUB_ISSUES_ENABLED === 'true' && typeof env.HUB_ISSUES_GITHUB_TOKEN === 'string' && env.HUB_ISSUES_GITHUB_TOKEN.length >= 20;
}

async function gh(env, path, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${API}${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${env.HUB_ISSUES_GITHUB_TOKEN}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'user-agent': 'hub-messenger', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw failure('github_unavailable');
  return response.json();
}

// Hub-written bodies carry the owner text in a fenced block; anything else is shown as is.
export function ownerText(body) {
  const text = String(body || '');
  if (!MARKER.test(text)) {
    const agent = AGENT_MARKER.exec(text);
    const marker = agent || LEGACY_AGENT_MARKER.exec(text);
    return { mine: false, ...(marker ? { author: AGENT_NAMES[agent ? agent[1] : 'snezhana'] } : {}),
      text: text.slice(marker ? marker[0].length : 0).slice(0, MAX_TEXT) };
  }
  const match = /(`{3,})text\n([\s\S]*?)\n\1\s*$/.exec(text);
  return { mine: true, text: (match ? match[2] : text.replace(MARKER, '').trim()).slice(0, MAX_TEXT) };
}

function ownedRows(db, ownerId, issue = null) {
  const query = `SELECT id, payload_json, receipt_json, status, created_at FROM owner_outbox
    WHERE owner_id = ? AND status = 'synced' AND json_extract(receipt_json, '$.kind') = 'issue'
      AND json_extract(payload_json, '$.addressee') IS NOT NULL
      ${issue ? "AND json_extract(receipt_json, '$.issueNumber') = ?" : ''}
    ORDER BY created_at DESC, id DESC LIMIT 30`;
  const statement = db.prepare(query);
  return (issue ? statement.bind(ownerId, issue) : statement.bind(ownerId)).all();
}

export async function listThreads(db, ownerId) {
  const rows = (await ownedRows(db, ownerId)).results || [];
  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json);
    return { issue: JSON.parse(row.receipt_json).issueNumber, addressee: payload.addressee, mode: payload.mode === 'chat' ? 'chat' : 'task',
      preview: String(payload.text).slice(0, 120), createdAt: row.created_at };
  });
}

async function ownedThread(db, ownerId, issue) {
  if (!Number.isSafeInteger(issue) || issue < 1) throw failure('invalid_issue');
  const row = ((await ownedRows(db, ownerId, issue)).results || [])[0];
  if (!row) throw failure('not_found');
  return JSON.parse(row.payload_json);
}

export async function readThread(db, env, ownerId, issue, fetchImpl = fetch) {
  const payload = await ownedThread(db, ownerId, issue);
  if (!tokenReady(env)) throw failure('not_configured');
  const head = await gh(env, `/issues/${issue}`, null, fetchImpl);
  if (!head || head.number !== issue || head.pull_request) throw failure('github_unavailable');
  const comments = [];
  for (let page = 1; page <= 2; page += 1) {
    const rows = await gh(env, `/issues/${issue}/comments?per_page=100&page=${page}`, null, fetchImpl);
    if (!Array.isArray(rows)) throw failure('github_unavailable');
    comments.push(...rows);
    if (rows.length < 100) break;
  }
  const messages = [{ id: `i${issue}`, ...ownerText(head.body), author: 'Максим', at: head.created_at },
    ...comments.map((c) => ({ id: String(c.id), author: c.user?.login || 'agent', ...ownerText(c.body), at: c.created_at }))]
    .map((m) => ({ ...m, author: m.mine ? 'Максим' : String(m.author).slice(0, 60) }));
  return { issue, addressee: payload.addressee, mode: payload.mode === 'chat' ? 'chat' : 'task', state: head.state, messages };
}

export async function replyToThread(db, env, ownerId, issue, text, author, fetchImpl = fetch) {
  await ownedThread(db, ownerId, issue);
  if (!tokenReady(env)) throw failure('not_configured');
  const fence = '`'.repeat(Math.max(3, ...((text.match(/`+/g) || []).map((x) => x.length + 1))));
  const body = `<!-- hub-reply:${crypto.randomUUID()} -->\nHub author: ${author}\n\n${fence}text\n${text}\n${fence}\n`;
  const created = await gh(env, `/issues/${issue}/comments`, { body }, fetchImpl);
  if (!created || !Number.isSafeInteger(created.id)) throw failure('github_unavailable');
  return { id: String(created.id) };
}
