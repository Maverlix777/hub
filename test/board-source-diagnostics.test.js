import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBoardSources } from '../src/board-sources.js';
import { readTelemetry } from '../src/telemetry.js';
const env = { BOARD_GITHUB_TOKEN: 'PRIVATE_TOKEN_VALUE', BOARD_PATHS: 'tasks/BOARD.md', BOARD_IDEA_PATHS: '', BOARD_TELEMETRY_PATH: 'runtime/telemetry.json' };
const consumers = [
  ['board', async fetcher => (await loadBoardSources(env, fetcher)).board.sources[0].error],
  ['telemetry', async fetcher => (await readTelemetry(env, fetcher)).reason],
];
for (const [name, consume] of consumers) {
  test(`${name}: finite HTTP taxonomy never reads response bodies`, async () => {
    for (const [status, expected] of [[401,'http_401'],[403,'http_403'],[404,'http_404'],[429,'http_429'],[500,'http_5xx'],[503,'http_5xx'],[418,'http_other']]) {
      let reads = 0;
      const code = await consume(async () => ({ status, ok: false, redirected: false, headers: new Headers(), body: { getReader(){reads++;throw Error('PRIVATE_BODY');}, cancel:async()=>{} } }));
      assert.equal(code,expected);assert.equal(reads,0);
    }
  });
  test(`${name}: timeout and network exceptions have closed codes without upstream text`, async () => {
    assert.equal(await consume(async()=>{throw new DOMException('PRIVATE_TIMEOUT_DETAIL','TimeoutError');}),'timeout');
    assert.equal(await consume(async()=>{throw new DOMException('PRIVATE_ABORT_DETAIL','AbortError');}),'timeout');
    assert.equal(await consume(async()=>{throw new Error('PRIVATE_TOKEN_VALUE network url/path');}),'network_error');
    // An upstream exception message cannot impersonate a local validation outcome.
    assert.equal(await consume(async()=>{throw new Error('invalid_blob');}),'network_error');
  });
  test(`${name}: invalid JSON and announced size are distinguished`, async () => {
    assert.equal(await consume(async()=>new Response('{PRIVATE_BODY',{headers:{'content-type':'application/json'}})),'invalid_json');
    assert.equal(await consume(async()=>new Response('PRIVATE_BODY',{headers:{'content-length':String(3*1024*1024)}})),'oversized');
  });
}
test('board: malformed blob, mismatched hash and streaming size have explicit safe codes',async()=>{
  const boardCode=consumers[0][1];
  assert.equal(await boardCode(async()=>Response.json({type:'file',encoding:'base64',content:'WA==',sha:'a'.repeat(40)})),'invalid_blob');
  assert.equal(await boardCode(async()=>Response.json({type:'dir',encoding:'base64',content:'PRIVATE_BODY',sha:'a'.repeat(40)})),'invalid_blob');
  assert.equal(await boardCode(async()=>new Response('x'.repeat(2*1024*1024+1))),'oversized');
});
test('telemetry: oversized streamed data and missing response body stay unknown',async()=>{
  assert.equal(await consumers[1][1](async()=>new Response('x'.repeat(256*1024+1))),'oversized');
  assert.equal(await consumers[1][1](async()=>new Response(null)),'empty_response');
});
test('complete failed payloads never expose credentials, upstream body or error text',async()=>{
  const board=await loadBoardSources(env,async()=>new Response('PRIVATE_BODY',{status:403}));
  const telemetry=await readTelemetry(env,async()=>{throw Error('PRIVATE_EXCEPTION_DETAIL '+env.BOARD_GITHUB_TOKEN);});
  const serialized=JSON.stringify({board,telemetry});
  for(const secret of ['PRIVATE_BODY','PRIVATE_EXCEPTION_DETAIL','PRIVATE_TOKEN_VALUE'])assert.ok(!serialized.includes(secret));
  assert.equal(board.board.sources[0].status,'error');assert.equal(telemetry.status,'unknown');
});
