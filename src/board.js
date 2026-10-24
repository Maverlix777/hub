// Markdown task boards -> dashboard columns. Pure functions, no I/O, no private data in this repo.
// Columns: ideas, planned, progress, done, questions.

export const COLUMNS = Object.freeze(['ideas', 'planned', 'progress', 'done', 'questions']);

const OWNER_WORDS = /needs-owner|нужно слово владельца|ждёт владельца|ждет владельца|вопрос владельцу|слово владельца|ответ владельца|решение владельца/i;

function splitRow(line) {
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  if (cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

const isSeparator = (line) => /^\|?\s*:?-{3,}/.test(line.trim());

function plain(text, max) {
  const t = String(text || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// First word of the state cell decides the column. Returns null for an unknown state.
export function columnForState(state, text = '') {
  const word = String(state || '').trim().toLowerCase().split(/[\s(,:;—]/)[0];
  if (['idea', 'идея', 'proposed'].includes(word)) return 'ideas';
  if (['needs-owner', 'needs_owner'].includes(word)) return 'questions';
  if (word === 'ready') return 'planned';
  if (['claimed', 'review', 'changes'].includes(word)) return 'progress';
  if (['done', 'закрыта', 'закрыто', 'closed'].includes(word)) return 'done';
  if (word === 'blocked') return OWNER_WORDS.test(`${state} ${text}`) ? 'questions' : 'progress';
  return null;
}

// source: { name, text }. Returns { cards, unmapped }.
export function parseBoard(text, source = 'board') {
  const cards = [];
  const unmapped = [];
  let header = null;
  let inDoneSection = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { inDoneSection = /закрыт|closed|done/i.test(heading[1]); header = null; continue; }
    if (!line.startsWith('|') || isSeparator(line)) continue;
    const cells = splitRow(line);
    if (cells[0] && cells[0].toLowerCase() === 'id') { header = cells.map((c) => c.toLowerCase()); continue; }
    if (!header || !/^[A-Za-z]+-\d+/.test(cells[0] || '')) continue;
    const at = (names) => {
      const idx = header.findIndex((h) => names.some((n) => h.startsWith(n)));
      return idx >= 0 ? cells[idx] || '' : '';
    };
    const hasState = header.some((h) => h.startsWith('состояние') || h.startsWith('state'));
    const state = hasState ? at(['состояние', 'state']) : (inDoneSection ? 'Done' : '');
    const title = at(['задача', 'task']);
    const card = {
      id: cells[0],
      title: plain(title, 240),
      who: plain(at(['кому', 'кто', 'owner']), 60),
      state: plain(state, 80),
      ref: plain(at(['ветка', 'sha']), 80),
      source,
    };
    const column = columnForState(state, `${title} ${at(['приёмка'])}`);
    if (column) cards.push({ ...card, column });
    else unmapped.push({ ...card, column: null });
  }
  return { cards, unmapped };
}

export function countColumns(cards) {
  const counts = Object.fromEntries(COLUMNS.map((c) => [c, 0]));
  for (const card of cards) counts[card.column] += 1;
  return counts;
}

export function buildBoard(sources) {
  const cards = [];
  const unmapped = [];
  for (const s of sources) {
    const parsed = parseBoard(s.text, s.name);
    cards.push(...parsed.cards);
    unmapped.push(...parsed.unmapped);
  }
  return { counts: countColumns(cards), cards, unmappedCount: unmapped.length };
}
