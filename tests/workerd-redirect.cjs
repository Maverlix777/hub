'use strict';
// Actual workerd Request construction, with synthetic transport; no GitHub/network requests or real credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { build } = require('esbuild');
const { Miniflare } = require('miniflare');
const root = path.resolve(__dirname, '..');
test('all GitHub transports construct requests in workerd and preserve upstream HTTP failures', async () => {
  const source = `
    import {loadBoardSources} from './src/board-sources.js';
    import {readTelemetry} from './src/telemetry.js';
    import {flushIssueDelivery} from './src/issues-delivery.js';
    export default {async fetch() {
      let constructed = 0;
      const transport = async (url, init) => {
        const request = new Request(url, init);
        if (request.redirect !== 'manual') throw new Error('unsafe_redirect_policy');
        constructed++;
        return new Response('{}', {status:401});
      };
      const env = {BOARD_GITHUB_TOKEN:'synthetic-credential-only',BOARD_PATHS:'boards/test.md',BOARD_IDEA_PATHS:'',
        BOARD_TELEMETRY_PATH:'runtime/test.json',HUB_ISSUES_ENABLED:'true',HUB_ISSUES_GITHUB_TOKEN:'synthetic-credential-only'};
      const store = {async claimDelivery(){return {item:{id:'synthetic'},attempt:'synthetic'}},async finishDelivery(){}};
      const board = await loadBoardSources(env, transport);
      const telemetry = await readTelemetry(env, transport);
      const delivery = await flushIssueDelivery(null,env,'synthetic',{store,fetchImpl:transport});
      return Response.json({constructed,source:board.board.sources[0].error,telemetry:telemetry.reason,delivery:delivery.error});
    }};`;
  const bundle = await build({stdin:{contents:source,resolveDir:root,sourcefile:'probe.js'},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*']});
  const mf = new Miniflare({workers:[{config:{name:'redirect-regression',compatibilityDate:'2026-10-17',compatibilityFlags:['nodejs_compat'],
    manifest:{mainModule:'probe.js',modulesRoot:root,modules:{'probe.js':{type:'esm',contents:bundle.outputFiles[0].text}}}}}]});
  try {
    const result = await (await mf.dispatchFetch('http://localhost/')).json();
    assert.deepEqual(result,{constructed:3,source:'http_401',telemetry:'http_401',delivery:'delivery_unavailable_github_401'});
  } finally {await mf.dispose();}
});
