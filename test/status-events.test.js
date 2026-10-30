import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBoardSources } from '../src/board-sources.js';
const env = { BOARD_GITHUB_TOKEN: 'synthetic', BOARD_PATHS: 'tasks/BOARD.md', BOARD_IDEA_PATHS: '' };
const since = new Date(Date.now() - 5 * 86400000).toISOString();
const row = (title = 'Task', state = 'Review 2026-10-29') => `| ID | Task | State | Evidence |\n|---|---|---|---|\n| T-1 | ${title} | ${state} | [Issue](https://github.com/Maverlix777/agent-handoffs/issues/42) |`;
const event = (name, created_at = since, type = 'labeled') => ({ event: type, label: { name }, created_at });
test('label event five days ago wins over markdown; unrelated edits do not restart age', async () => {
  for (const title of ['Task', 'Edited task']) {
    const result = await loadBoardSources(env, async url => url.includes('/contents/') ? new Response(row(title)) : Response.json([
      event('cloud:review'), event('priority:high', new Date().toISOString()), { event: 'commented', created_at: new Date().toISOString() },
    ]));
    assert.equal(result.board.cards[0].statusSince, since);
    assert.equal(result.board.cards[0].statusAgeLabel, 'в статусе 5 дн');
  }
});
test('unavailable, invalid, removed or mismatched label history safely yields unknown', async () => {
  for (const events of [null, {}, [event('cloud:running')], [event('cloud:review'), event('cloud:review', new Date().toISOString(), 'unlabeled')], [event('cloud:review', 'invalid')]]) {
    const result = await loadBoardSources(env, async url => url.includes('/contents/') ? new Response(row()) : events === null ? new Response('', {status: 403}) : Response.json(events));
    assert.equal(result.board.cards.length, 1);
    assert.equal(result.board.cards[0].statusSince, '');
    assert.equal(result.board.cards[0].statusAgeLabel, 'нет данных');
    assert.ok(!JSON.stringify(result).includes('synthetic'));
  }
});
test('pagination is followed on the fixed API origin and duplicate issue reads are shared', async () => {
  let reads = 0;
  const result = await loadBoardSources(env, async (url, init) => {
    assert.equal(init.redirect, 'manual');
    if (url.includes('/contents/')) return new Response(row() + '\n| T-2 | Another | Review | [Issue](https://github.com/Maverlix777/agent-handoffs/issues/42) |');
    reads++;
    return url.endsWith('page=1') ? Response.json(Array.from({length:100}, () => ({event:'commented'}))) : Response.json([event('cloud:review')]);
  });
  assert.equal(reads, 2);
  assert.ok(result.board.cards.every(c => c.statusSince === since));
});
test('progress ages survive removal of a previous status; raw issue URLs are supported', async () => {
  const text = row('Task', 'Claimed').replace('[Issue](https://github.com/Maverlix777/agent-handoffs/issues/42)', 'https://github.com/Maverlix777/agent-handoffs/issues/42');
  const result = await loadBoardSources(env, async url => url.includes('/contents/') ? new Response(text) : Response.json([
    event('cloud:review', new Date(Date.parse(since) - 1000).toISOString()), event('cloud:running'),
    event('cloud:review', new Date().toISOString(), 'unlabeled'),
  ]));
  assert.equal(result.board.cards[0].statusSince, since);
  assert.equal(result.board.cards[0].statusAgeLabel, 'в статусе 5 дн');
});
test('ambiguous, missing and cross-repository issue links cannot invent a clock', async () => {
  for (const text of [row().replace('/issues/42', '/pull/42'), row().replace('Maverlix777/agent-handoffs/issues/', 'other/repo/issues/'), row('https://github.com/Maverlix777/agent-handoffs/issues/43')]) {
    let reads = 0;
    const result = await loadBoardSources(env, async url => { reads++; assert.ok(url.includes('/contents/')); return new Response(text); });
    assert.equal(reads, 1);
    assert.equal(result.board.cards[0].statusAgeLabel, 'нет данных');
  }
});
test('truncated histories and redirects preserve cards without trusting incomplete evidence', async () => {
  for (const mode of ['truncated', 'redirect']) {
    let reads = 0;
    const result = await loadBoardSources(env, async url => {
      if (url.includes('/contents/')) return new Response(row());
      reads++;
      return mode === 'redirect' ? new Response('', {status:302, headers:{location:'https://evil.test'}}) : Response.json(Array.from({length:100}, () => event('cloud:review')));
    });
    assert.equal(reads, mode === 'redirect' ? 1 : 5);
    assert.equal(result.board.cards[0].statusSince, '');
    assert.equal(result.board.cards[0].statusAgeLabel, 'нет данных');
  }
});
