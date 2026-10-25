// Read-only projection of local-manager-telemetry v1. Producer claims are not Hub verification.
const MAX_BYTES = 256 * 1024;
// Closed diagnostics only: never expose upstream text, response bodies or credentials.
function httpFailure(status) {
  if ([401, 403, 404, 429].includes(status)) return 'http_' + status;
  return status >= 500 && status <= 599 ? 'http_5xx' : 'http_other';
}

const MAX_AGE = 15 * 60 * 1000;
const states = new Set(['dispatched', 'ack', 'running', 'result_reported', 'error', 'unknown']);
// IDs are bounded opaque labels, never paths. Keep model tags (gemma4:12b),
// UUIDs and task/run IDs; reject credential-shaped prefixes and drive-relative paths.
const id = (value) => typeof value === 'string' && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)
  && !/^(?:sk[-_]|gh[pousr]_|github_pat_|bearer|[A-Za-z]:)/i.test(value)
  && !value.includes('..') ? value : null;
const time = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const fresh = (value, now) => time(value) && now >= Date.parse(value) && now - Date.parse(value) <= MAX_AGE;
const number = (value, integer = false) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && (!integer || Number.isSafeInteger(value)) ? value : null;
const unknown = (reason) => ({ status: 'unknown', reason, as_of: null, producer: 'local-manager-telemetry',
  verification: 'producer_report_only', events: [], runs: [], gpu: { status: 'unknown', samples: [] } });

function unique(rows, key) {
  const found = new Map();
  for (const row of rows) {
    const identity = key(row);
    if (!identity) throw Error('missing_identity');
    if (found.has(identity) && JSON.stringify(found.get(identity)) !== JSON.stringify(row)) throw Error('conflict');
    found.set(identity, row);
  }
  return [...found.values()];
}

export function projectTelemetry(input, now = Date.now()) {
  try {
    const t = input?.telemetry;
    if (!t || t.schema_version !== 1 || t.producer !== 'local-manager-telemetry'
      || !Array.isArray(t.events) || t.events.length > 2000
      || !Array.isArray(t.gemma?.results) || t.gemma.results.length > 100
      || !Array.isArray(t.gpu?.samples) || t.gpu.samples.length > 16) return unknown('invalid');
    if (!fresh(t.as_of, now)) return unknown('stale');
    const events = unique(t.events.map((e) => {
      const f = e.facts || {};
      const claimed = e.stage === 'result_verified';
      const state = claimed ? 'result_reported' : (states.has(e.stage) ? e.stage : 'unknown');
      return { id: id(e.id), task_id: id(f.task_id), turn_id: id(f.turn_id), observed_at: time(f.at_utc),
        state: fresh(f.at_utc, now) ? state : 'unknown', producer_claimed_verified: claimed };
    }), (e) => e.id);
    const runs = unique(t.gemma.results.map((r) => {
      const current = Boolean(fresh(r.created_at, now));
      const row = { run_id: id(r.run_id), model: id(r.model), created_at: time(r.created_at), status: current ? 'measured' : 'unknown' };
      for (const key of ['eval_count', 'prompt_eval_count', 'total_seconds', 'load_seconds', 'eval_seconds', 'prompt_eval_seconds']) {
        row[key] = current ? number(r[key], key.endsWith('_count')) : null;
      }
      row.tokens_per_second = row.eval_count !== null && row.eval_seconds > 0 ? row.eval_count / row.eval_seconds : null;
      if (row.eval_count === null && row.prompt_eval_count === null && row.total_seconds === null
        && row.load_seconds === null && row.eval_seconds === null && row.prompt_eval_seconds === null) row.status = 'unknown';
      row.finish_reason = ['stop', 'length', 'error', 'load', 'unload'].includes(r.finish_reason) ? r.finish_reason : null;
      return row;
    }), (r) => r.run_id || (r.model && r.created_at ? `${r.model}|${r.created_at}` : null));
    const samples = unique(t.gpu.samples.map((s) => {
      const utilization = number(s.utilization_percent);
      const current = fresh(s.measured_at, now) && s.status === 'measured' && utilization !== null && utilization <= 100;
      return { device_id: id(s.device_id), measured_at: time(s.measured_at), status: current ? 'measured' : 'unknown',
        utilization_percent: current ? utilization : null,
        memory_used_bytes: current ? number(s.memory_used_bytes, true) : null,
        memory_total_bytes: current ? number(s.memory_total_bytes, true) : null };
    }), (s) => s.device_id && s.measured_at ? `${s.device_id}|${s.measured_at}` : null);
    return { status: 'available', reason: null, as_of: t.as_of, producer: t.producer,
      verification: 'producer_report_only', events, runs,
      gpu: { status: samples.some((s) => s.status === 'measured') ? 'measured' : 'unknown', samples } };
  } catch { return unknown('invalid'); }
}

export async function readTelemetry(env, fetchImpl = fetch, now = Date.now()) {
  const path = env.BOARD_TELEMETRY_PATH;
  if (!path) return unknown('not_configured');
  const repo = env.BOARD_REPO || 'Maverlix777/agent-handoffs';
  if (typeof path !== 'string' || path.length > 300 || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.json$/.test(path)
    || path.includes('..') || path.includes('//') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    || !env.BOARD_GITHUB_TOKEN) return unknown('invalid_source');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let reader; let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { accept: 'application/vnd.github.raw+json', authorization: `Bearer ${env.BOARD_GITHUB_TOKEN}`,
        'user-agent': 'hub-board', 'x-github-api-version': '2022-11-28' },
    });
    if (response.redirected) return unknown('redirect_rejected');
    if (!response.ok) return unknown(httpFailure(response.status));
    if (Number(response.headers.get('content-length')) > MAX_BYTES) return unknown('oversized');
    if (!response.body) return unknown('empty_response');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0; let text = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) return unknown('oversized');
      try { text += decoder.decode(value, { stream: true }); } catch { return unknown('invalid_json'); }
    }
    let data;
    try { text += decoder.decode(); data = JSON.parse(text); } catch { return unknown('invalid_json'); }
    return projectTelemetry(data, now);
  } catch (error) {
    return unknown(controller.signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_error');
  } finally {
    clearTimeout(timer);
    if (reader) await reader.cancel().catch(() => {});
    else if (response?.body) await response.body.cancel().catch(() => {});
  }
}
