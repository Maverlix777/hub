import { Buffer } from 'node:buffer';

const DEFAULT_REPO = 'Maverlix777/agent-handoffs';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PAGE_BYTES = 1024 * 1024;
const TOTAL_BYTES = 8 * PAGE_BYTES;
const CONTROL = /[\u0000-\u001f\u007f]/;

function praxisURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || CONTROL.test(value) || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

// Optional owner-GET census only. No persistence, outbox reads, or client credential.
export async function loadBoardOperations(env, fetchImpl = fetch, now = Date.now) {
  const praxis_url = praxisURL(env.BOARD_PRAXIS_URL);
  const unavailable = () => ({ status: 'unavailable', as_of: null, open_issues: null, workers: [], human_blockers: [], praxis_url });
  const repo = env.BOARD_REPO || DEFAULT_REPO;
  const token = env.BOARD_GITHUB_TOKEN;
  if (typeof token !== 'string' || !token.trim() || CONTROL.test(token)
    || typeof repo !== 'string' || !REPO.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) return unavailable();

  const controller = new AbortController();
  let reader = null;
  let totalBytes = 0;
  let timer;
  const cancelReader = () => {
    const owned = reader; reader = null;
    try { if (owned) Promise.resolve(owned.cancel()).catch(() => {}); } catch { /* Best effort, never extend the deadline. */ }
  };
  const checkDeadline = () => { if (controller.signal.aborted) throw new Error(); };
  async function readPage(response) {
    if (Number(response.headers.get('content-length')) > PAGE_BYTES || !response.body) throw new Error();
    reader = response.body.getReader();
    const owned = reader;
    const chunks = [];
    let pageBytes = 0;
    try {
      for (;;) {
        checkDeadline();
        const { done, value } = await owned.read();
        checkDeadline();
        if (done) break;
        pageBytes += value.byteLength; totalBytes += value.byteLength;
        if (pageBytes > PAGE_BYTES || totalBytes > TOTAL_BYTES) throw new Error();
        chunks.push(value);
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } finally { cancelReader(); }
  }
  async function census() {
    const seen = new Set();
    const workers = new Map();
    const human_blockers = [];
    let open_issues = 0;
    for (let page = 1; page <= 20; page++) {
      checkDeadline();
      const response = await fetchImpl(`https://api.github.com/repos/${repo}/issues?state=open&sort=created&direction=asc&per_page=100&page=${page}`, {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'hub-board', 'x-github-api-version': '2022-11-28' },
        redirect: 'manual', signal: controller.signal,
      });
      try {
        checkDeadline();
        if (!response.ok || response.redirected || (response.status >= 300 && response.status < 400)) throw new Error();
        const rows = await readPage(response);
        checkDeadline();
        if (!Array.isArray(rows) || rows.length > 100) throw new Error();
        for (const row of rows) {
          if (!row || !Number.isSafeInteger(row.number) || row.number <= 0 || seen.has(row.number)
            || !['open', 'closed'].includes(row.state) || typeof row.title !== 'string' || !Array.isArray(row.labels)
            || row.labels.some(label => !label || typeof label !== 'object' || Array.isArray(label)
              || typeof label.name !== 'string' || !label.name.trim() || CONTROL.test(label.name))) throw new Error();
          seen.add(row.number);
          if (row.state !== 'open' || Object.hasOwn(row, 'pull_request')) continue;
          open_issues++;
          const labels = new Set(row.labels.map(label => label.name));
          for (const label of labels) {
            if (label.startsWith('worker:') && label.slice(7).trim()) workers.set(label, (workers.get(label) || 0) + 1);
          }
          if (labels.has('blocked:human')) human_blockers.push({ number: row.number, title: Array.from(row.title).slice(0, 240).join(''), url: `https://github.com/${repo}/issues/${row.number}` });
        }
        if (rows.length < 100) return {
          status: 'ok', as_of: new Date(now()).toISOString(), open_issues,
          workers: [...workers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([label, count]) => ({ label, count })),
          human_blockers: human_blockers.sort((a, b) => a.number - b.number), praxis_url,
        };
      } finally {
        // Failed HTTP/header reads may never acquire a reader; cancel that body too.
        if (response.body && !response.body.locked) {
          try { Promise.resolve(response.body.cancel()).catch(() => {}); } catch { /* Best effort only. */ }
        }
      }
    }
    throw new Error(); // A full final page cannot establish completeness.
  }
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error()); }, 10000);
    });
    return await Promise.race([census(), deadline]);
  } catch { return unavailable(); }
  finally { clearTimeout(timer); controller.abort(); cancelReader(); }
}
