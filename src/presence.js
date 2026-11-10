import { bearerAuthorized, bearerConfigured } from './bearer.js';

const MAX_BODY = 2048;
const DAY = 86400_000;
const MAX_KEYS = 200;
const STALE_MS = 15 * 60_000;
const STATES = new Set(['working', 'idle', 'blocked', 'done']);
const FIELDS = new Set(['owner', 'agent', 'machine', 'state', 'card', 'note']);
const NAME = /^[a-z0-9_-]{1,32}$/;
const MACHINE = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const noStore = { 'cache-control': 'no-store' };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...noStore, 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

async function readBody(request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return null; } finally { try { reader.releaseLock(); } catch { /* already released */ } }
}

function optionalText(value, max) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || [...value].length > max || CONTROL.test(value)) return { ok: false };
  return { ok: true, value };
}

export function validatePresence(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some(key => !FIELDS.has(key))) return null;
  if (typeof body.owner !== 'string' || !NAME.test(body.owner)) return null;
  if (typeof body.agent !== 'string' || !NAME.test(body.agent)) return null;
  if (typeof body.machine !== 'string' || !MACHINE.test(body.machine)) return null;
  if (typeof body.state !== 'string' || !STATES.has(body.state)) return null;
  const card = optionalText(body.card, 80); const note = optionalText(body.note, 200);
  if (!card.ok || !note.ok) return null;
  return { owner: body.owner, agent: body.agent, machine: body.machine, state: body.state, card: card.value, note: note.value };
}

// `owner` is true when the session belongs to the board owner. POST uses the bearer secret only.
export async function handlePresence(request, env, session, owner, now) {
  if (request.method === 'POST') {
    if (!bearerConfigured(env.PRESENCE_TOKEN)) return json({ error: 'not_configured' }, 503);
    if (!await bearerAuthorized(request, env.PRESENCE_TOKEN)) return json({ error: 'unauthorized' }, 401);
    const row = validatePresence(await readBody(request));
    if (!row) return json({ error: 'bad_request' }, 400);
    const db = env.HUB_DB;
    await db.prepare('DELETE FROM agent_presence WHERE updated_at < ?').bind(now - 7 * DAY).run();
    // One statement keeps the 200-key cap atomic: a new key is inserted only while there is room.
    const saved = await db.prepare(`INSERT INTO agent_presence (owner, agent, machine, state, card, note, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
      WHERE (SELECT COUNT(*) FROM agent_presence) < ?8
        OR EXISTS (SELECT 1 FROM agent_presence WHERE owner = ?1 AND agent = ?2 AND machine = ?3)
      ON CONFLICT (owner, agent, machine) DO UPDATE SET
        state = excluded.state, card = excluded.card, note = excluded.note, updated_at = excluded.updated_at`)
      .bind(row.owner, row.agent, row.machine, row.state, row.card, row.note, now, MAX_KEYS).run();
    if (Number(saved?.meta?.changes || 0) < 1) return json({ error: 'too_many_agents' }, 409);
    return json({ ok: true });
  }
  if (request.method === 'GET') {
    if (!(session && owner) && !await bearerAuthorized(request, env.PRESENCE_TOKEN)) {
      return json({ error: session ? 'forbidden' : 'unauthorized' }, session ? 403 : 401);
    }
    const rows = await env.HUB_DB.prepare(`SELECT owner, agent, machine, state, card, note, updated_at
      FROM agent_presence WHERE updated_at >= ? ORDER BY owner, agent, machine`).bind(now - DAY).all();
    return json((rows.results || []).map(r => ({ ...r, stale: now - r.updated_at > STALE_MS })));
  }
  return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
}
