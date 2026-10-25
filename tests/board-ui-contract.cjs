'use strict';
// Browser-only contract tests. API is synthetic; this does not prove Worker persistence or GitHub delivery.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
(async () => {
  const root = path.resolve(__dirname,'../public');
  const server = http.createServer((req,res) => {
    const filename = path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname.replace(/^\/hub/,''));
    if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename)) {res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(fs.readFileSync(filename));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true, ...(process.env.HUB_BROWSER ? {executablePath:process.env.HUB_BROWSER} : {})});
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const failures = []; page.on('pageerror',error => failures.push(error.message));
    const items=[]; let failOnce=true; let firstKey; let requests=0;
    const card={key:'fixture::DEMO-1',id:'DEMO-1',title:'Безопасный вопрос владельцу',source:'Synthetic',column:'questions',state:'Needs-owner',owner:'Demo',sourcePath:'fixtures/BOARD.md',sourceRevision:'a'.repeat(40),description:'Контекст <img src=x onerror=alert(1)>',history:['Создано для проверки'],evidence:[{label:'Synthetic evidence',url:'https://example.org/evidence'},{label:'Unsafe',url:'javascript:alert(1)'}],blockers:['Нужен ответ']};
    await page.route('**/hub/api/**',async route => {
      const req=route.request(); const url=new URL(req.url());
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
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.cardKey),card.key);
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
      const boardData = {cards:[privateCard],sources:[],telemetry:{status:'available',as_of:new Date().toISOString(),events:[{task_id:'PRIVATE_EVENT',state:'running'}]}};
      const outboxData = {items:[{id:'private-receipt',kind:'message',text:'PRIVATE_MESSAGE',status:'pending'}]};
      await race.route('**/hub/api/**',async route => {
        const req=route.request(); const isBoard=new URL(req.url()).pathname.endsWith('/board'); const isPost=req.method()==='POST';
        const shouldHold=armed && ((delayed==='board' && isBoard) || (delayed==='outbox' && !isBoard && !isPost) || (delayed==='post' && isPost));
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
      await authorPage.route('**/hub/api/**',route => route.fulfill({json:route.request().url().endsWith('/board') ? {cards:[],sources:[]} : {
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
  } finally { if (browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
