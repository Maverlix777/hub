import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildBoard, parseBoard} from '../src/board.js';
import {DEFAULT_IDEA_SOURCES, loadBoardSources} from '../src/board-sources.js';
const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const table = '| ID | Task | Owner | State | Evidence |\n|---|---|---|---|---|\n| T-1 | Synthetic | Agent A | Review | [Proof](https://example.test/proof) |';
const ideas = '# Prior ideas\n| # | Идея | Риск |\n|---|---|---|\n| 1 | Synthetic idea | uncertain |\n| 2 | Another idea | unknown |';
const env = {BOARD_GITHUB_TOKEN:'synthetic-token',BOARD_PATHS:'tasks/BOARD.md',BOARD_IDEA_PATHS:'ideas.md'};
test('numbered idea tables have stable IDs, provenance and details; do not assume unknown markdown is empty', () => {
  const result = buildBoard([{name:'historic',text:ideas,path:'ideas.md',revision:'a'.repeat(40),kind:'ideas',url:'https://github.com/owner/repo/blob/main/ideas.md'}, {name:'unknown',text:'# An unsupported document'}]);
  assert.equal(result.cards.length,2); assert.equal(result.cards[0].id,'IDEA-1'); assert.equal(result.cards[0].sourceRevision,'a'.repeat(40)); assert.equal(result.cards[0].key,'ideas.md::IDEA-1');
  assert.match(result.cards[0].description,/uncertain/); assert.equal(result.sources[1].status,'unsupported');
});
test('explicit idea-document adapter keeps full source context and never invents execution history', () => {
  const {cards}=parseBoard('# Idea draft\n\nSome recorded context','proposal',{kind:'idea-document',path:'draft.md'});
  assert.equal(cards.length,1); assert.equal(cards[0].column,'ideas'); assert.match(cards[0].description,/Some recorded context/); assert.deepEqual(cards[0].history,[]);
  assert.equal(parseBoard('# Unclassified document','proposal').cards.length,0);
});
test('review is separate, source-safe links only; blockers and unresolved rows are retained', () => {
  const result=parseBoard(table+'\n| T-2 | Needs answer | Agent B | Needs-owner | [bad](javascript:alert) |\n| T-3 | Unknown | A | Waiting | |','tasks',{path:'tasks/BOARD.md',url:'https://github.com/owner/repo/blob/main/tasks/BOARD.md'});
  assert.equal(result.cards[0].column,'review'); assert.equal(result.cards[0].evidence[0].url,'https://example.test/proof'); assert.equal(result.cards[1].evidence.length,0); assert.equal(result.cards[1].blockers.length,1); assert.equal(result.unmapped.length,1);
});
test('empty, unsupported and remote error stay distinct with partial successful data', async () => {
  const result=await loadBoardSources(env, async url => url.endsWith('ideas.md') ? new Response('not found',{status:404}) : new Response(table));
  assert.equal(result.board.cards.length,1); assert.equal(result.board.sources[1].status,'error'); assert.equal(result.board.sources[1].error,'http_404'); assert.equal(result.board.cards[0].sourceRevision,blob(table));
  const empty=await loadBoardSources(env, async()=>new Response(''));
  assert.ok(empty.board.sources.every(s=>s.status==='empty'));
  const unsupported=await loadBoardSources(env, async()=>new Response('# Unknown format'));
  assert.ok(unsupported.board.sources.every(s=>s.status==='unsupported'));
});
test('GitHub JSON blobs are validated and secrets are never returned', async()=>{
  let calls=0;
  const result=await loadBoardSources(env, async(url,init)=>{
    calls++; assert.match(url,/^https:\/\/api.github.com\/repos\//); assert.equal(init.redirect,'error');
    const text=url.endsWith('ideas.md')?ideas:table;
    return Response.json({type:'file',encoding:'base64',content:Buffer.from(text).toString('base64'),sha:blob(text)});
  });
  assert.equal(calls,2); assert.equal(result.board.cards.length,3); assert.ok(!JSON.stringify(result).includes('synthetic-token'));
  const invalid=await loadBoardSources(env,async()=>Response.json({type:'file',encoding:'base64',content:Buffer.from(table).toString('base64'),sha:'a'.repeat(40)}));
  assert.ok(invalid.board.sources.every(s=>s.status==='error'));
});
test('invalid config fails before reads and oversized/error reads cannot erase good sources',async()=>{
  let reads=0; const fetcher=async()=>{reads++;throw new Error('secret stack');};
  assert.equal((await loadBoardSources({...env,BOARD_PATHS:'../private.md'},fetcher)).error,'board_unavailable'); assert.equal(reads,0);
  const failed=await loadBoardSources(env,fetcher); assert.equal(failed.board.sources.length,2); assert.ok(!JSON.stringify(failed).includes('secret stack'));
  const huge=await loadBoardSources(env,async()=>new Response('x'.repeat(2*1024*1024+1))); assert.ok(huge.board.sources.every(s=>s.status==='error'));
});
test('default historical selection includes existing records, not duplicated archived proposal',()=>{
  assert.equal(DEFAULT_IDEA_SOURCES.length,3); assert.equal(new Set(DEFAULT_IDEA_SOURCES.map(s=>s.path)).size,3);
  assert.ok(DEFAULT_IDEA_SOURCES.every(s=>s.provenance && s.name));
});
