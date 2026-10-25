import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/worker.js';
import { enqueue } from '../src/outbox.js';

test('actual Worker reads responses only after auth and only for the current author persisted receipt', async (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  for (const file of ['0001_auth.sql','0002_owner_outbox.sql','0003_owner_issues.sql']) db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  const statement = (sql, values = []) => ({ bind(...args) { return statement(sql,args); },
    first() { return db.prepare(sql).get(...values) || null; }, all() { return {results:db.prepare(sql).all(...values)}; },
    run() { return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}}; } });
  const env = { HUB_DB:{prepare:statement},ASSETS:{fetch:async()=>new Response('asset')},RP_ID:'hub.test',CANONICAL_ORIGIN:'https://hub.test',
    BOARD_OWNER_USERNAME:'owner,other',HUB_RESPONSE_GITHUB_ID:'12345',HUB_RESPONSE_GITHUB_LOGIN:'trusted-agent',HUB_ISSUES_GITHUB_TOKEN:'synthetic-secret' };
  async function seed(name,issue) {
    const token=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64url');
    db.prepare('INSERT INTO users(id,username,created_at) VALUES(?,?,1)').run(name,name);
    db.prepare('INSERT INTO entitlements(user_id,tier,created_at) VALUES(?,?,1)').run(name,'paid');
    db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)').run(hash,name,Date.now()+3600000);
    const {item}=await enqueue(env.HUB_DB,name,{idempotencyKey:crypto.randomUUID(),kind:'message',text:`${name} synthetic message`,target:null});
    db.prepare('UPDATE owner_outbox SET status=?,receipt_json=? WHERE id=?').run('synced',JSON.stringify({kind:'issue',issueNumber:issue,commentId:null,url:`https://github.com/Maverlix777/agent-handoffs/issues/${issue}`}),item.id);
    return {cookie:`__Host-hub_session=${token}`,id:item.id,issue};
  }
  const owner=await seed('owner',12),other=await seed('other',13),guest=await seed('guest',14);
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push(url); assert.equal(options.method,'GET');
    const source=url.includes('/issues/12/')?owner:other;
    return new Response(JSON.stringify([{id:91,body:`<!-- hub-response:${source.id}:result -->\nSynthetic secretary response`,user:{id:12345,login:'trusted-agent'},
      html_url:`https://github.com/Maverlix777/agent-handoffs/issues/${source.issue}#issuecomment-91`,issue_url:`https://api.github.com/repos/Maverlix777/agent-handoffs/issues/${source.issue}`,
      created_at:'2026-10-25T12:00:00Z',updated_at:'2026-10-25T12:00:00Z'}]));
  });
  const request=cookie=>worker.fetch(new Request('https://hub.test/hub/api/outbox',{headers:cookie?{cookie}:{}}),env);
  assert.equal((await request()).status,401); assert.equal((await request(guest.cookie)).status,403); assert.equal(calls.length,0);
  const result=await (await request(owner.cookie)).json(); assert.equal(result.items.length,1); assert.equal(result.items[0].id,owner.id);
  assert.equal(result.items[0].agentAck,null); assert.equal(result.items[0].agentResult.text,'Synthetic secretary response');
  assert.equal(calls.length,1); assert.match(calls[0],/\/issues\/12\/comments/);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|other synthetic/);
  assert.equal(db.prepare('SELECT status FROM owner_outbox WHERE id=?').get(owner.id).status,'synced');
});
