'use strict';
// Independent browser QA. Static host mirrors the agreed page paths only;
// synthetic API responses do not prove Worker authorization or GitHub delivery.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const root=path.resolve(__dirname,'../public');
const artifactDir=path.resolve(__dirname,'../artifacts/hub');
const card=(id,column,title)=>({id,key:'fixture::'+id,title,column,state:column==='questions'?'Needs-owner':'Ready',owner:'Synthetic owner',source:'Synthetic',sourcePath:'fixtures/BOARD.md',sourceRevision:'a'.repeat(40),description:'Synthetic context <img src=x onerror=alert(1)>',history:['Synthetic history'],evidence:[],blockers:[]});
const cards=[card('QA-1','planned','Short synthetic task'),card('QA-2','planned','Long synthetic task '+('layout boundary '.repeat(18))),card('QA-3','progress','Synthetic work'),card('QA-4','review','Synthetic review'),card('QA-5','done','Synthetic done'),card('QA-6','questions','Synthetic owner question'),card('QA-7','ideas','Synthetic idea')];
const board={cards,sources:[{path:'fixtures/BOARD.md',status:'available',cardCount:cards.length}],telemetry:{status:'unknown',reason:'stale'}};
const session={username:'synthetic-owner',entitlement:'paid',apps:['board','chat','downloads'],locked:[]};
(async()=>{
 const server=http.createServer((req,res)=>{
  let pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/hub/')pathname='/hub/apps/board.html';
  if(pathname==='/hub/login/')return void res.end('<!doctype html><title>Synthetic login</title><p>Signed out</p>');
  const filename=path.resolve(root,'.'+pathname.replace(/^\/hub/,''));
  if(!filename.startsWith(root+path.sep)||!fs.existsSync(filename)||!fs.statSync(filename).isFile()){res.writeHead(404);return void res.end();}
  res.setHeader('Content-Type',filename.endsWith('.css')?'text/css':filename.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(filename));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  const executablePath=process.env.HUB_BROWSER||(process.platform==='win32'&&fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined);
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  const base=`http://127.0.0.1:${server.address().port}`;
  const context=await browser.newContext();const page=await context.newPage();const failures=[];const items=[];
  page.on('pageerror',e=>failures.push(e.message));
  await page.route('**/hub/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.pathname.endsWith('/session'))return route.fulfill({json:session});
   if(url.pathname.endsWith('/board'))return route.fulfill({json:board});
   if(url.pathname.endsWith('/logout'))return route.fulfill({json:{ok:true}});
   if(url.pathname.endsWith('/outbox')&&req.method()==='POST'){
    const body=req.postDataJSON();assert.equal(req.headers()['x-hub-request'],'1');
    const item={...body,id:body.idempotencyKey,status:'pending',createdAt:Date.now(),receipt:null,author:{hubUsername:session.username,hubUserId:'synthetic-owner',githubLogin:'synthetic-owner'}};items.unshift(item);return route.fulfill({status:201,json:{item}});
   }
   return route.fulfill({json:{items,delivery:{status:'not_configured'}}});
  });
  fs.mkdirSync(artifactDir,{recursive:true});
  for(const width of [320,390,768,1280]){
   await page.setViewportSize({width,height:900});await page.goto(base+'/hub/');await page.locator('button.card[data-card-key="fixture::QA-1"]').waitFor();
   await page.screenshot({path:path.join(artifactDir,`dashboard-first-${width}.png`),fullPage:true});
   const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,nodes:[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(n=>({tag:n.tagName,id:n.id,class:n.className,right:n.getBoundingClientRect().right}))}));
   assert.ok(overflow.scroll<=overflow.width,`overflow at ${width}: ${JSON.stringify(overflow)}`);
   await page.goto(base+'/hub/index.html');await page.locator('#account-name').filter({hasText:session.username}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`catalog overflow at ${width}`);
   const boxes=await page.locator('#grid li:not([hidden]) .tile').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {y:Math.round(b.y),height:b.height};}));
   for(const y of new Set(boxes.map(b=>b.y))){const heights=boxes.filter(b=>b.y===y).map(b=>b.height);assert.ok(Math.max(...heights)-Math.min(...heights)<=1,`unequal catalog card heights at ${width}`);}
   await page.screenshot({path:path.join(artifactDir,`dashboard-first-catalog-${width}.png`),fullPage:true});
  }
  // Wider text metrics reproduce Linux font variation and user text scaling.
  // Every header link must wrap inside the viewport and remain actionable.
  await page.setViewportSize({width:320,height:900});
  for(const route of ['/hub/','/hub/index.html','/hub/apps/chat.html','/hub/apps/downloads.html']){
   await page.goto(base+route);await page.locator('#account-name').filter({hasText:session.username}).waitFor();
   await page.addStyleTag({content:'.hub-nav a { font-size:18px !important; letter-spacing:.3px !important; }'});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`scaled navigation overflow on ${route}`);
   const links=page.locator('.hub-nav a');assert.equal(await links.count(),4);
   const rows=[];
   for(const link of await links.all()){
    assert.equal(await link.isVisible(),true);const box=await link.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=320,`scaled link outside viewport on ${route}`);rows.push(Math.round(box.y));
    await link.focus();assert.equal(await link.evaluate(node=>node===document.activeElement),true);await link.click({trial:true});
   }
   assert.ok(new Set(rows).size>1,`scaled navigation did not wrap on ${route}`);
   if(route==='/hub/')await page.screenshot({path:path.join(artifactDir,'dashboard-first-scaled-nav-320.png'),fullPage:false});
  }
  await page.setViewportSize({width:1280,height:900});
  await page.goto(base+'/hub/');await page.locator('#columns button.card').first().waitFor();
  const opener=page.locator('button.card[data-card-key="fixture::QA-1"]');await opener.focus();await page.keyboard.press('Enter');
  await page.locator('#task-dialog[open]').waitFor();assert.equal(await page.locator('#detail-content img').count(),0);
  await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.querySelector('#task-dialog').contains(document.activeElement)),true);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#task-dialog').open);assert.equal(await opener.evaluate(n=>document.activeElement===n),true);
  await opener.click();await page.goBack();await page.waitForFunction(()=>!document.querySelector('#task-dialog').open);
  await page.locator('#q').fill('Short synthetic');assert.equal(await page.locator('#columns button.card').count(),1);await page.locator('#q').fill('');
  await page.locator('#message-text').fill('Synthetic QA message');await page.locator('#message-form button[type=submit]').click();await page.locator('#outbox-list .outbox-entry').waitFor();
  await page.goto(base+'/hub/apps/board.html');await page.locator('#columns button.card').first().waitFor();
  const catalog=page.locator('a[href="/hub/index.html"]');assert.ok(await catalog.count()>0,'explicit catalog navigation');await catalog.first().click();await page.waitForURL('**/hub/index.html');
  await page.locator('#grid a[data-id="chat"]').waitFor();assert.equal(await page.locator('#grid a[data-id="chat"]').getAttribute('href'),'apps/chat.html');
  assert.equal(await page.locator('#grid a[data-id="downloads"]').getAttribute('href'),'apps/downloads.html');
  assert.ok((await page.locator('#grid a[data-id="board"]').getAttribute('href')).endsWith('/hub/'));
  await page.locator('#grid a[data-id="chat"]').click();await page.waitForURL('**/hub/apps/chat.html');await page.locator('#input').waitFor();
  await page.locator('#nav-downloads').click();await page.waitForURL('**/hub/apps/downloads.html');await page.locator('#list li').first().waitFor();
  assert.ok(await page.locator('#list a[href^="https://"]').count()>0,'download links retained');
  await page.locator('#q').fill('no-match-synthetic-qa-999');assert.equal(await page.locator('#list a[href^="https://"]').count(),0);await page.locator('#q').fill('');
  await page.locator('#nav-board').click();await page.waitForURL(base+'/hub/');await page.locator('#columns button.card').first().waitFor();
  const filtered=await browser.newPage();
  await filtered.route('**/hub/api/**',route=>route.fulfill({json:route.request().url().endsWith('/session')?{...session,apps:['board','downloads'],locked:['location-fusion','doktor']}:route.request().url().endsWith('/board')?board:{items:[],delivery:{status:'not_configured'}}}));
  await filtered.goto(base+'/hub/index.html');await filtered.locator('#account-name').filter({hasText:session.username}).waitFor();
  for(const id of ['chat','location-fusion','doktor'])assert.equal(await filtered.locator(`#grid [data-id="${id}"]`).isVisible(),false,`denied tile ${id}`);
  assert.equal(await filtered.locator('#grid [data-id="downloads"]').isVisible(),true);
  await filtered.goto(base+'/hub/');await filtered.locator('#account-name').filter({hasText:session.username}).waitFor();
  assert.equal(await filtered.locator('[data-nav-app="chat"]').isVisible(),false,'denied dashboard chat navigation');
  assert.equal(await filtered.locator('[data-nav-app="downloads"]').isVisible(),true);await filtered.close();
  // Hold both an old privileged read and logout response. Local privacy must be
  // final before the logout network operation completes or navigation starts.
  for(const heldKind of ['board','outbox']){
  const race=await browser.newPage();let heldBoard,heldLogout,boardSeen,logoutSeen;
  const boardCaptured=new Promise(resolve=>{boardSeen=resolve;}),logoutCaptured=new Promise(resolve=>{logoutSeen=resolve;});
  await race.route('**/hub/api/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname.endsWith('/'+heldKind)){heldBoard=route;boardSeen();return;}
   if(pathname.endsWith('/logout')){heldLogout=route;logoutSeen();return;}
   if(pathname.endsWith('/session'))return route.fulfill({json:session});
   return route.fulfill({json:pathname.endsWith('/board')?board:{items:[],delivery:{status:'not_configured'}}});
  });
  await race.goto(base+'/hub/');await boardCaptured;await race.locator('#logout').waitFor();
  await race.evaluate(()=>{sessionStorage.setItem('hub.chat.key','SYNTHETIC_KEY');localStorage.setItem('hub.chat.history','SYNTHETIC_HISTORY');});
  await race.locator('#logout').click();await logoutCaptured;
  await heldBoard.fulfill({json:heldKind==='board'?{...board,cards:[card('PRIVATE-1','planned','LATE_PRIVATE_CARD')],telemetry:{status:'available',as_of:new Date().toISOString(),events:[{task_id:'LATE_PRIVATE_EVENT',state:'running'}]}}:{items:[{id:'synthetic-late',text:'LATE_PRIVATE_CARD',status:'pending',createdAt:Date.now()}],delivery:{status:'not_configured'}}});
  await race.waitForTimeout(100);
  assert.doesNotMatch(await race.locator('body').textContent(),/LATE_PRIVATE_CARD|LATE_PRIVATE_EVENT/);
  assert.equal(await race.evaluate(()=>sessionStorage.getItem('hub.chat.key')),null);
  assert.equal(await race.evaluate(()=>localStorage.getItem('hub.chat.history')),null);
  assert.equal(await race.locator('#message-text').isDisabled(),true);
  await heldLogout.fulfill({json:{ok:true}});await race.waitForURL('**/hub/login/');await race.close();
  }
  await page.goto(base+'/hub/');await page.locator('#columns button.card').first().waitFor();
  const otherTab=await page.context().newPage();await otherTab.goto(base+'/hub/login/');
  await otherTab.evaluate(()=>localStorage.setItem('hub.session.logout',String(Date.now())));
  await page.waitForURL('**/hub/login/');await otherTab.close();
  assert.deepEqual(failures,[]);console.log('PASS dashboard viewport/card geometry, root/legacy/catalog links, modal keyboard/Back/Escape/focus, literal XSS, search/chat, app filters and logout before delayed private response; synthetic frontend API only.');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
