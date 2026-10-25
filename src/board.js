// Private Markdown is fetched only behind the owner's session gate. Never bundle source data.
export const COLUMNS = Object.freeze(['ideas', 'planned', 'progress', 'review', 'done', 'questions']);
const OWNER_WORDS = /needs-owner|нужно слово владельца|жд[её]т владельца|вопрос владельцу|слово владельца|ответ владельца|решение владельца/i;
function splitRow(line) {
  const cells = []; let cur = ''; let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  if (!cells[0]) cells.shift();
  if (!cells.at(-1)) cells.pop();
  return cells;
}
const plain = (text, max = 16000) => String(text || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').trim().slice(0, max);
export function columnForState(state, text = '') {
  const word = plain(state).toLowerCase().split(/[\s(,:;—]/)[0];
  if (['idea', 'идея', 'proposed'].includes(word)) return 'ideas';
  if (['needs-owner', 'needs_owner'].includes(word)) return 'questions';
  if (['ready', 'planned', 'todo'].includes(word)) return 'planned';
  if (word === 'review') return 'review';
  if (['claimed', 'changes', 'in-progress', 'progress'].includes(word)) return 'progress';
  if (['done', 'закрыта', 'закрыто', 'closed'].includes(word)) return 'done';
  if (word === 'blocked') return OWNER_WORDS.test(`${state} ${text}`) ? 'questions' : 'progress';
  return null;
}
// Optional date inside the state cell: "2026-10-25", "2026-10-25 20:30 UTC", "2026-10-25T20:30Z".
export function parseStatusSince(text) {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(text || ''));
  if (!m) return '';
  const [y, mo, d, h = 0, mi = 0] = m.slice(1).map((v) => Number(v ?? 0));
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || mi > 59) return '';
  return t.toISOString();
}
export function statusAgeLabel(since, now = Date.now()) {
  const t = Date.parse(since || '');
  if (!Number.isFinite(t) || t - now > 5 * 60000) return 'нет данных';
  const hours = Math.max(0, Math.floor((now - t) / 3600000));
  return hours < 48 ? `в статусе ${hours} ч` : `в статусе ${Math.floor(hours / 24)} дн`;
}
function links(text, baseUrl) {
  const found = [];
  for (const match of String(text).matchAll(/\[([^\]]+)\]\(([^\s)]+)\)/g)) {
    try {
      const url = new URL(match[2], baseUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) found.push({ label: plain(match[1], 200), url: url.href });
    } catch { /* Invalid or relative links without a known source are not navigable. */ }
  }
  return found;
}
function detail(card, metadata, raw, line) {
  const sourcePath = metadata.path || '';
  return { ...card, key: `${sourcePath || card.source}::${card.id}`, owner: card.who,
    sourcePath, sourceRevision: metadata.revision || '', sourceUrl: metadata.url || '', provenance: metadata.provenance || '', line,
    description: plain(raw), history: [], evidence: links(raw, metadata.url),
    statusSince: parseStatusSince(card.state), blockers: /^blocked|^needs.owner/i.test(card.state) ? [plain(raw)] : [],
  };
}
export function parseBoard(text, source = 'board', metadata = {}) {
  const cards = []; const unmapped = []; let header = null; let inDoneSection = false;
  const lines = String(text || '').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { inDoneSection = /закрыт|closed|done/i.test(heading[1]); header = null; continue; }
    if (!line.startsWith('|') || /^\|?\s*:?-{3,}/.test(line)) continue;
    const cells = splitRow(line);
    if (['id', '#', '№'].includes(cells[0]?.toLowerCase())) { header = cells.map(c => plain(c).toLowerCase()); continue; }
    if (!header) continue;
    const isIdeaTable = metadata.kind === 'ideas' && ['#', '№'].includes(header[0]);
    if (!(isIdeaTable ? /^\d+$/.test(cells[0]) : /^[A-Za-z]+-\d+[A-Za-z0-9._-]*$/.test(cells[0] || ''))) continue;
    const at = names => { const pos = header.findIndex(h => names.some(n => h.startsWith(n))); return pos < 0 ? '' : cells[pos] || ''; };
    const hasState = header.some(h => /^(состояние|state|status|статус)/.test(h));
    const state = hasState ? at(['состояние', 'state', 'status', 'статус']) : isIdeaTable ? 'Idea' : inDoneSection ? 'Done' : '';
    const title = at(['задача', 'task', 'идея', 'название', 'title']);
    const raw = header.slice(1).map((label, i) => `${label}: ${cells[i + 1] || ''}`).join('\n');
    const card = detail({id: isIdeaTable ? `IDEA-${cells[0]}` : cells[0], title: plain(title, 240), who: plain(at(['кому', 'кто', 'owner']), 100), state: plain(state, 160), ref: plain(at(['ветка', 'sha']), 160), source}, metadata, raw, index + 1);
    const column = columnForState(state, raw);
    if (column) cards.push({...card, column}); else unmapped.push({...card, column: null});
  }
  // Explicit document adapter, not a guess based on a missing parser result.
  if (metadata.kind === 'idea-document' && /^#\s+.+/m.test(text)) {
    cards.push({...detail({id: 'IDEA-DOCUMENT', title: plain(/^#\s+(.+)$/m.exec(text)[1], 240), who: '', state: 'Idea', ref: '', source}, metadata, text, 1), column: 'ideas'});
  }
  return {cards, unmapped};
}
export function countColumns(cards) {
  const counts = Object.fromEntries(COLUMNS.map(c => [c, 0]));
  for (const card of cards) if (Object.hasOwn(counts, card.column)) counts[card.column]++;
  return counts;
}
export function buildBoard(sources, now = Date.now()) {
  const cards = []; let unmappedCount = 0; const summaries = [];
  for (const s of sources) {
    const parsed = s.error ? {cards: [], unmapped: []} : parseBoard(s.text, s.name, s);
    cards.push(...parsed.cards.map(c => ['progress', 'review'].includes(c.column) ? {...c, statusAgeLabel: statusAgeLabel(c.statusSince, now)} : c)); unmappedCount += parsed.unmapped.length;
    summaries.push({ name: s.name, path: s.path || '', url: s.url || '', revision: s.revision || '',
      status: s.error ? 'error' : parsed.cards.length ? 'available' : String(s.text || '').trim() ? 'unsupported' : 'empty',
      cardCount: parsed.cards.length, unmappedCount: parsed.unmapped.length, ...(s.error ? {error: s.error} : {}) });
  }
  return { counts: countColumns(cards), cards, unmappedCount, sources: summaries };
}
