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
    assert.deepEqual(failures,[]);
    console.log('PASS: modal/focus/Escape/back, literal XSS, same-key retry, receipt reload, 390px layout; synthetic API only.');
  } finally { if (browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
