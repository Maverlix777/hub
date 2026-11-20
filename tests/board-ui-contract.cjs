'use strict';
// Browser-only contract tests. API is synthetic; this does not prove Worker persistence or GitHub delivery.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const syntheticSession = {username:'synthetic-owner',apps:['board','chat','downloads'],locked:[]};
// Keep a rejecting timer alive until both test-owned resources finish closing;
// otherwise Node can exit with an unresolved cleanup promise and hide a failure.
async function closeTestResources(browser, server) {
  let timer;
  try {
    await Promise.race([
      Promise.all([browser ? browser.close() : Promise.resolve(), new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser test cleanup timed out after 10000ms')), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}
(async () => {
  const root = path.resolve(__dirname,'../public');
  const server = http.createServer((req,res) => {
    const filename = path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname.replace(/^\/hub/,''));
    if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename)) {res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(fs.readFileSync(filename));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser; let testError;
  try {
    browser = await chromium.launch({headless:true, ...(process.env.HUB_BROWSER ? {executablePath:process.env.HUB_BROWSER} : {})});
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const failures = []; page.on('pageerror',error => failures.push(error.message));
    const items=[]; let failOnce=true; let firstKey; let requests=0;
    const card={key:'fixture::DEMO-1',id:'DEMO-1',title:'Безопасный вопрос владельцу',source:'Synthetic',column:'questions',state:'Needs-owner',owner:'Demo',sourcePath:'fixtures/BOARD.md',sourceRevision:'a'.repeat(40),description:'Контекст <img src=x onerror=alert(1)>',history:['Создано для проверки'],evidence:[{label:'Synthetic evidence',url:'https://example.org/evidence'},{label:'Unsafe',url:'javascript:alert(1)'}],blockers:['Нужен ответ']};
    await page.route('**/hub/api/**',async route => {
      const req=route.request(); const url=new URL(req.url());
      if(url.pathname.endsWith('/session')) return route.fulfill({json:syntheticSession});
      if(url.pathname.endsWith('/board')) return route.fulfill({json:{cards:[card,{...card,key:'fixture::DEMO-2',id:'DEMO-2',title:'Проверить результат',column:'review'}],sources:[{path:'fixtures/BOARD.md',status:'available',cardCount:2}],telemetry:{status:'unknown',reason:'stale'}}});
      if(req.method()==='GET') return route.fulfill({json:{items,delivery:{status:'not_configured'}}});
      const data=req.postDataJSON(); requests++;
      assert.equal(req.headers()['x-hub-request'],'1');
      if(failOnce) { firstKey=data.idempotencyKey;failOnce=false;return route.abort(); }
      if(requests===2) assert.equal(data.idempotencyKey,firstKey);
      const item={id:data.idempotencyKey,...data,status:'pending',createdAt:new Date().toISOString(),receipt:null}; items.unshift(item);
      return route.fulfill({status:201,json:{item}});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/hub/apps/board.html`);
    await page.locator('#question-list button').click();
    assert.equal(await page.locator('#task-dialog').evaluate(d=>d.open),true);
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Сохранить ответ');
    await page.locator('#answer-text').fill('Синтетический ответ');
    await page.locator('#answer-form button').click();
    await page.locator('#answer-form button').filter({hasText:'Повторить'}).waitFor();
    assert.equal(await page.locator('#answer-text').inputValue(),'Синтетический ответ');
    await page.locator('#answer-form button').click();
    await page.locator('#answer-form .success').waitFor();
    assert.equal(await page.locator('#detail-content img').count(),0);
    assert.equal(await page.locator('#detail-content a[href^="javascript:"]').count(),0);
    await page.keyboard.press('Escape'); await page.waitForFunction(()=>!document.getElementById('task-dialog').open);
    // An answered question moves into progress. Keep the collapsed preference and
    // return keyboard focus to its visible column header instead of a hidden card.
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.col),'progress');
    assert.equal(await page.locator('.col-toggle[data-col="progress"]').getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('#col-progress').isHidden(),true);
    await page.reload(); await page.locator('#outbox-list .outbox-entry').waitFor();
    assert.match(await page.locator('#outbox-list').textContent(),/Синтетический ответ/);
    await page.locator('#question-list button').click(); await page.goBack(); await page.waitForFunction(()=>!document.getElementById('task-dialog').open);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.locator('#question-list button').click();
    assert.equal(Math.round((await page.locator('#task-dialog').boundingBox()).width),390);
    await page.locator('#task-dialog').evaluate(node=>{node.scrollTop=node.scrollHeight;});
    await page.keyboard.press('Escape'); await page.waitForFunction(()=>!document.getElementById('task-dialog').open);
    await page.locator('#question-list button').click();
    assert.equal(await page.locator('#task-dialog').evaluate(node=>node.scrollTop),0);
    assert.ok((await page.locator('#detail-title').boundingBox()).y < 200);
    assert.deepEqual(failures,[]);
    console.log('PASS: modal/focus/Escape/back, literal XSS, same-key retry, receipt reload, 390px layout; synthetic API only.');
    await page.close();
    // Delayed successful requests must never resurrect private content after any
    // concurrent request discovers auth loss. Exercise each asynchronous reader.
    for (const delayed of ['board','outbox','post']) {
      const race = await browser.newPage();
      let armed = false; let held; let capture;
      const captured = new Promise(resolve => { capture = resolve; });
      const privateCard = {...card,title:'PRIVATE_CARD',description:'PRIVATE_DETAIL'};
      const boardData = {cards:[privateCard],sources:[],telemetry:{status:'available',as_of:new Date().toISOString(),events:[{task_id:'PRIVATE_EVENT',state:'running'}]},operations:{status:'ok',as_of:'2026-11-10T20:00:00.000Z',open_issues:987654,workers:[{label:'worker:PRIVATE_QUEUE',count:987654}],human_blockers:[{number:123,title:'PRIVATE_BLOCKER',url:'https://github.com/Maverlix777/agent-handoffs/issues/123'}],praxis_url:'https://example.org/PRIVATE_PRAXIS'}};
      const outboxData = {items:[{id:'private-receipt',kind:'message',text:'PRIVATE_MESSAGE',status:'pending'}]};
      await race.route('**/hub/api/**',async route => {
        const req=route.request(); const pathname=new URL(req.url()).pathname;
        if(pathname.endsWith('/session')) return route.fulfill({json:syntheticSession});
        const isBoard=pathname.endsWith('/board'); const isOutbox=pathname.endsWith('/outbox'); const isPost=isOutbox && req.method()==='POST';
        const shouldHold=armed && ((delayed==='board' && isBoard) || (delayed==='outbox' && isOutbox && !isPost) || (delayed==='post' && isPost));
        if(shouldHold) {held=route;capture();return;}
        if(armed && ((delayed==='post' && isBoard) || (delayed!=='post' && isPost))) return route.fulfill({status:403,json:{error:'forbidden'}});
        return route.fulfill({json:isBoard ? boardData : outboxData});
      });
      await race.goto(`http://127.0.0.1:${server.address().port}/hub/apps/board.html`);
      await race.locator('#outbox-list .outbox-entry').waitFor();
      assert.match(await race.locator('#telemetry').textContent(),/PRIVATE_EVENT/);
      await race.locator('#question-list button').click();
      await race.keyboard.press('Escape'); await race.waitForFunction(()=>!document.getElementById('task-dialog').open);
      await race.locator('#message-text').fill('PRIVATE_DRAFT'); armed=true;
      if(delayed==='post') await race.locator('#message-form button').click();
      else await race.locator('#refresh').click();
      await captured;
      if(delayed==='post') await race.locator('#refresh').click();
      else await race.locator('#message-form button').click();
      await race.waitForFunction(()=>document.getElementById('message-text').disabled);
      const completed=race.waitForResponse(response=>response.status()===200 && response.url().includes('/hub/api/'));
      await held.fulfill({json:delayed==='board' ? boardData : delayed==='post' ? {item:{id:'late',text:'PRIVATE_LATE',status:'pending'}} : outboxData});
      await completed; await race.waitForTimeout(75);
      assert.doesNotMatch(await race.locator('body').textContent(),/PRIVATE_/);
      assert.equal(await race.locator('#message-text').inputValue(),'');
      assert.equal(await race.locator('#message-form button').isDisabled(),true);
      assert.equal(await race.locator('#refresh').isDisabled(),true);
      assert.equal(await race.locator('#detail-content').textContent(),'');
      assert.equal(await race.locator('#operations a').count(),0,'Auth loss must remove operation and Praxis anchors');
      assert.doesNotMatch(await race.locator('body').textContent(),/987654/,'Auth loss must clear operation totals');
      await race.close();
    }
    console.log('PASS: auth-loss terminal guard rejects delayed board/outbox/POST success; telemetry/details/drafts cleared and controls stay disabled.');
    // Separate synthetic sessions prove rendering attribution only, not ACLs or
    // a real mapping of either authorized person to their Hub/GitHub identity.
    for (const [index,username] of ['synthetic-owner','synthetic-collaborator'].entries()) {
      const authorPage = await browser.newPage();
      const author = {hubUserId:`synthetic-${index}`,hubUsername:username,githubLogin:`fixture-${index}`};
      const receipt = index === 0
        ? {kind:'issue',url:'https://github.com/Maverlix777/agent-handoffs/issues/123',issueNumber:123,commentId:null,deliveredAt:Date.now()}
        : {kind:'comment',url:'https://github.com/Maverlix777/agent-handoffs/issues/123#issuecomment-456',issueNumber:123,commentId:456,deliveredAt:Date.now()};
      await authorPage.route('**/hub/api/**',route => route.fulfill({json:route.request().url().endsWith('/session') ? {...syntheticSession,username} : route.request().url().endsWith('/board') ? {cards:[],sources:[]} : {
        items:[{id:`author-${index}`,kind:'message',text:'Synthetic authored message',author,status:'synced',receipt,agentAck:null,agentResult:null},
          {id:'legacy',kind:'message',text:'Legacy receipt',status:'synced',receipt:{url:'https://github.com/Maverlix777/agent-handoffs/blob/abc/file.md',commit:'abc'}}],
        delivery:{status:'not_configured'}}}));
      await authorPage.goto(`http://127.0.0.1:${server.address().port}/hub/apps/board.html`);
      const entry=authorPage.locator(`[data-receipt-id="author-${index}"]`);
      await entry.waitFor();
      assert.equal(await entry.locator('.author').textContent(),`Автор: ${username} · GitHub @fixture-${index}`);
      assert.deepEqual(await entry.locator('.delivery-stages dd').allTextContents(),['Сохранено на сервере','Доставка подтверждена','Не подтверждён','Не подтверждён']);
      assert.equal(await entry.locator('a').getAttribute('href'),receipt.url);
      assert.equal(await authorPage.locator('[data-receipt-id="legacy"] a').count(),0);
      assert.equal((await authorPage.locator('[data-receipt-id="legacy"] .delivery-stages dd').allTextContents())[1],'Не подтверждено');
      assert.match(await authorPage.locator('#delivery-status').textContent(),/быстрая доставка пока не подтверждена/);
      await authorPage.close();
    }
    console.log('PASS: two synthetic author snapshots, issue/comment receipts, SAVED/DELIVERED/ACK/RESULT separation; legacy Markdown receipt not treated as Issues delivery.');
    const polling = await browser.newPage(); let submitted=null; let postCount=0; let receiptReads=0;
    await polling.route('**/hub/api/**',route => {
      if(route.request().url().endsWith('/session')) return route.fulfill({json:syntheticSession});
      if(route.request().url().endsWith('/board')) return route.fulfill({json:{cards:[],sources:[]}});
      if(route.request().method()==='POST') {
        postCount++; submitted={...route.request().postDataJSON(),id:'poll-receipt',status:'pending',author:{hubUsername:'synthetic-author'}};
        return route.fulfill({status:201,json:{item:submitted}});
      }
      if(submitted) receiptReads++;
      return route.fulfill({json:{items:submitted ? [{...submitted,status:'synced',receipt:{kind:'issue',url:'https://github.com/Maverlix777/agent-handoffs/issues/123',issueNumber:123,commentId:null,deliveredAt:Date.now()}}] : [],delivery:{status:'enabled'}}});
    });
    await polling.goto(`http://127.0.0.1:${server.address().port}/hub/apps/board.html`);
    await polling.locator('#message-text').fill('Synthetic immediate save then receipt');
    await polling.locator('#message-form button').click();
    await polling.locator('[data-receipt-id="poll-receipt"]').waitFor();
    assert.equal((await polling.locator('.delivery-stages dd').allTextContents())[1],'Не подтверждено');
    await polling.locator('[data-receipt-id="poll-receipt"] a').waitFor({timeout:5000});
    assert.equal(postCount,1); assert.equal(receiptReads,1);
    assert.equal((await polling.locator('.delivery-stages dd').allTextContents())[1],'Доставка подтверждена');
    await polling.close();
    console.log('PASS: saved immediately, bounded foreground GET observes verified issue receipt without a second POST or 60-second wait; synthetic API only.');
    const retryPage=await browser.newPage(); let retries=0;
    const failedItem={id:'persisted-error',idempotencyKey:'11111111-1111-4111-8111-111111111111',kind:'answer',text:'Persisted synthetic answer',target:{sourcePath:'fixtures/BOARD.md',taskId:'DEMO-1',revision:'a'.repeat(40)},status:'error',error:'delivery_uncertain'};
    await retryPage.route('**/hub/api/**',route => {
      if(route.request().url().endsWith('/session')) return route.fulfill({json:syntheticSession});
      if(route.request().url().endsWith('/board')) return route.fulfill({json:{cards:[],sources:[]}});
      if(route.request().method()==='POST') {
        retries++; assert.deepEqual(route.request().postDataJSON(),{idempotencyKey:failedItem.idempotencyKey,kind:failedItem.kind,text:failedItem.text,target:failedItem.target});
        return route.fulfill({json:{duplicate:true,item:{...failedItem,status:'synced',error:null,receipt:{kind:'comment',url:'https://github.com/Maverlix777/agent-handoffs/issues/123#issuecomment-456',issueNumber:123,commentId:456,deliveredAt:Date.now()}}}});
      }
      return route.fulfill({json:{items:[failedItem,{...failedItem,id:'conflict-item',status:'conflict'}],delivery:{status:'not_configured'}}});
    });
    await retryPage.goto(`http://127.0.0.1:${server.address().port}/hub/apps/board.html`);
    await retryPage.locator('[data-receipt-id="persisted-error"] .retry-delivery').click();
    await retryPage.locator('[data-receipt-id="persisted-error"] a').waitFor();
    assert.equal(retries,1); assert.equal(await retryPage.locator('[data-receipt-id="persisted-error"]').count(),1);
    assert.equal(await retryPage.locator('.retry-delivery').count(),0);
    assert.equal((await retryPage.locator('[data-receipt-id="persisted-error"] .delivery-stages dd').allTextContents())[1],'Доставка подтверждена');
    await retryPage.close();
    console.log('PASS: persisted-error retry button preserves payload/key/id, creates no new UI item, and never offers retry for conflict/synced; synthetic API only.');
    const resumePage=await browser.newPage(); let enabled=false; let resumePosts=0;
    const pendingItem={id:'persisted-pending',idempotencyKey:'22222222-2222-4222-8222-222222222222',kind:'message',text:'Saved while delivery disabled',status:'pending',target:null};
    const resumeReceipt={kind:'issue',url:'https://github.com/Maverlix777/agent-handoffs/issues/124',issueNumber:124,commentId:null,deliveredAt:Date.now()};
    await resumePage.route('**/hub/api/**',route => {
      if(route.request().url().endsWith('/session')) return route.fulfill({json:syntheticSession});
      if(route.request().url().endsWith('/board')) return route.fulfill({json:{cards:[],sources:[]}});
      if(route.request().method()==='POST') {
        resumePosts++; assert.deepEqual(route.request().postDataJSON(),{idempotencyKey:pendingItem.idempotencyKey,kind:pendingItem.kind,text:pendingItem.text});
        return route.fulfill({json:{duplicate:true,item:enabled ? {...pendingItem,status:'synced',receipt:resumeReceipt} : pendingItem}});
      }
      return route.fulfill({json:{items:[pendingItem],delivery:{status:enabled ? 'enabled' : 'not_configured'}}});
    });
    await resumePage.goto(`http://127.0.0.1:${server.address().port}/hub/apps/board.html`);
    const disabledResumeResponse=resumePage.waitForResponse(response=>response.request().method()==='POST');
    await resumePage.locator('[data-receipt-id="persisted-pending"] .retry-delivery').click();
    await disabledResumeResponse; assert.equal(resumePosts,1);
    await resumePage.waitForFunction(()=>document.querySelector('[data-receipt-id="persisted-pending"] .retry-delivery')?.disabled);
    assert.equal((await resumePage.locator('.delivery-stages dd').allTextContents())[1],'Не подтверждено');
    assert.equal(await resumePage.locator('[data-receipt-id="persisted-pending"]').count(),1);
    // A fresh authenticated page after configuration change (or a crash) must
    // expose recovery of the existing pending row, not demand a new message.
    enabled=true; await resumePage.reload();
    await resumePage.locator('[data-receipt-id="persisted-pending"] .retry-delivery').click();
    await resumePage.locator('[data-receipt-id="persisted-pending"] a').waitFor();
    assert.equal(resumePosts,2); assert.equal(await resumePage.locator('[data-receipt-id="persisted-pending"]').count(),1);
    assert.equal(await resumePage.locator('.retry-delivery').count(),0);
    await resumePage.close();
    console.log('PASS: pending disabled-channel item survives reload and resumes after enable with identical key/payload/id, no fresh message; synthetic API only.');

    // #1508 operations come through the real authenticated board load. All
    // endpoints are synthetic; this proves rendering, not a live GitHub census.
    const opsPage=await browser.newPage({viewport:{width:1440,height:1000}});
    const opsErrors=[]; const externalRequests=[];
    opsPage.on('pageerror',error=>opsErrors.push(error.message));
    await opsPage.route('**/*',route=>{
      if(new URL(route.request().url()).hostname==='127.0.0.1') return route.continue();
      externalRequests.push(route.request().url()); return route.abort();
    });
    const completeOperations={status:'ok',as_of:'2026-11-10T20:00:00.000Z',open_issues:3,
      workers:[{label:'worker:codex',count:2},{label:'worker:oleg',count:2}],
      human_blockers:[{number:1508,title:'Synthetic <img src=x onerror=alert(1)> owner question',url:'https://github.com/Maverlix777/agent-handoffs/issues/1508'}],
      praxis_url:'https://example.org/praxis?view=queue#today'};
    let operations=structuredClone(completeOperations); let boardStatus=200;
    await opsPage.route('**/hub/api/**',route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname.endsWith('/session')) return route.fulfill({json:syntheticSession});
      if(pathname.endsWith('/board')) return route.fulfill({status:boardStatus,json:boardStatus===200
        ? {cards:[card],sources:[{path:'fixtures/BOARD.md',status:'available',cardCount:1}],operations}
        : {error:'synthetic_board_unavailable'}});
      return route.fulfill({json:{items:[],delivery:{status:'not_configured'}}});
    });
    await opsPage.goto(`http://127.0.0.1:${server.address().port}/hub/apps/board.html`);
    await opsPage.waitForFunction(()=>document.getElementById('columns').getAttribute('aria-busy')==='false');
    assert.equal(await opsPage.locator('#operations').count(),1,'#1508: authenticated board.operations must render the operations panel');
    assert.equal(await opsPage.locator('#operations-open').textContent(),'3');
    assert.deepEqual(await opsPage.locator('#operations-workers li').allTextContents(),['worker:codex: 2','worker:oleg: 2']);
    assert.match(await opsPage.locator('#operations-status').textContent(),/10\.11\.2026/);
    assert.equal(await opsPage.locator('#operations-blockers img').count(),0);
    assert.match(await opsPage.locator('#operations-blockers').textContent(),/Synthetic <img src=x onerror=alert\(1\)> owner question/);
    const blocker=opsPage.locator('#operations-blockers a');
    assert.equal(await blocker.getAttribute('href'),completeOperations.human_blockers[0].url);
    assert.equal(await blocker.getAttribute('target'),'_blank');
    assert.match(await blocker.getAttribute('rel'),/noopener/); assert.match(await blocker.getAttribute('rel'),/noreferrer/);
    assert.equal(await opsPage.locator('#operations-praxis a').getAttribute('href'),completeOperations.praxis_url);
    assert.match(await opsPage.locator('#operations-praxis a').getAttribute('rel'),/noopener/);
    assert.match(await opsPage.locator('#operations-praxis a').getAttribute('rel'),/noreferrer/);
    await opsPage.setViewportSize({width:390,height:844});
    assert.equal(await opsPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    async function refreshOperations() {
      const response=opsPage.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/board'));
      await opsPage.locator('#refresh').click(); await response;
      await opsPage.waitForFunction(()=>document.getElementById('columns').getAttribute('aria-busy')==='false');
    }
    const unavailable={status:'unavailable',as_of:null,open_issues:null,workers:[],human_blockers:[],praxis_url:completeOperations.praxis_url};
    operations=structuredClone(unavailable); await refreshOperations();
    assert.match(await opsPage.locator('#operations-status').textContent(),/недоступ/i);
    assert.equal(await opsPage.locator('#operations-open').textContent(),'—');
    assert.equal(await opsPage.locator('#operations-workers li').count(),0);
    assert.equal(await opsPage.locator('#operations-blockers a').count(),0);
    assert.doesNotMatch(await opsPage.locator('#operations-blockers').textContent(),/нет|отсутствуют/i,'Unavailable source is not an empty blocker list');
    assert.equal(await opsPage.locator('#operations-praxis a').getAttribute('href'),completeOperations.praxis_url,'Praxis navigation is independent of census availability');
    assert.equal(await opsPage.locator('#question-list button').count(),1,'Operations failure must preserve Markdown cards');
    operations={...structuredClone(completeOperations),open_issues:0,workers:[],human_blockers:[],praxis_url:null}; await refreshOperations();
    assert.equal(await opsPage.locator('#operations-open').textContent(),'0');
    assert.doesNotMatch(await opsPage.locator('#operations-status').textContent(),/недоступ/i);
    assert.match(await opsPage.locator('#operations-blockers').textContent(),/нет|отсутствуют/i);
    assert.equal(await opsPage.locator('#operations-praxis a').count(),0);
    for(const invalid of [undefined,{...completeOperations,open_issues:-1},{...completeOperations,workers:[{label:'worker:codex',count:'2'}]},{...completeOperations,human_blockers:[{number:0,title:'bad',url:'https://example.org/'}]}]) {
      operations=invalid; await refreshOperations();
      assert.match(await opsPage.locator('#operations-status').textContent(),/недоступ/i);
      assert.equal(await opsPage.locator('#operations-open').textContent(),'—');
      assert.equal(await opsPage.locator('#operations-workers li').count(),0);
      assert.equal(await opsPage.locator('#operations-blockers a').count(),0);
    }
    for(const invalidURL of ['',null,'javascript:alert(1)','http://example.org/praxis','https://synthetic:synthetic@example.org/praxis']) {
      operations=structuredClone(completeOperations); await refreshOperations();
      assert.equal(await opsPage.locator('#operations-praxis a').count(),1);
      operations={...structuredClone(completeOperations),praxis_url:invalidURL}; await refreshOperations();
      assert.equal(await opsPage.locator('#operations-praxis a').count(),0,'Invalid/blank URL must remove a previously valid link');
    }
    operations=structuredClone(completeOperations); await refreshOperations();
    boardStatus=503; await refreshOperations();
    assert.match(await opsPage.locator('#operations-status').textContent(),/недоступ|стар|устар/i,'A failed refresh cannot show a fresh operations snapshot');
    boardStatus=200; await refreshOperations();
    await opsPage.evaluate(()=>window.dispatchEvent(new CustomEvent('hub:session-ended')));
    assert.equal(await opsPage.locator('#operations a').count(),0);
    assert.equal(await opsPage.locator('#operations-workers li').count(),0);
    assert.doesNotMatch(await opsPage.locator('#operations').textContent(),/Synthetic|worker:codex|worker:oleg/);
    assert.notEqual(await opsPage.locator('#operations-open').textContent(),'3');
    assert.deepEqual(externalRequests,[],'Operations/Praxis must not fetch any external endpoint');
    assert.deepEqual(opsErrors,[]);
    await opsPage.close();
    const csp=fs.readFileSync(path.join(root,'apps/board.html'),'utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.equal(csp,"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self'");
    console.log('PASS: operations counts/empty/unavailable, literal blocker links, independent safe Praxis, refresh/schema/auth clearing, no external requests and unchanged CSP; synthetic API only.');
  } catch (error) { testError = error; } finally {
    try { await closeTestResources(browser, server); } catch (error) { testError = testError ? new AggregateError([testError, error], 'Assertions and cleanup failed') : error; }
  }
  if (testError) throw testError;
})().catch(error=>{console.error(error);process.exitCode=1;});
