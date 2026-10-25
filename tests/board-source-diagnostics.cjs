'use strict';
// Synthetic local API only; this does not verify production auth or GitHub access.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
(async()=>{
  const root=path.resolve(__dirname,'../public');
  const server=http.createServer((req,res)=>{
    const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname.replace(/^\/hub/,''));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.HUB_BROWSER?{executablePath:process.env.HUB_BROWSER}:{})});
    const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/hub/api/**',route=>route.fulfill({json:route.request().url().endsWith('/board')?{cards:[],sources:[
      {name:'Synthetic denied source',status:'error',error:'http_403',cardCount:0},
      {name:'Synthetic malformed source',status:'error',error:'invalid_json',cardCount:0},
      {name:'Synthetic hostile field',status:'error',error:'<img src=x onerror=alert(1)> PRIVATE_DETAIL'},
      {name:'Synthetic available source',status:'available',error:'http_401',cardCount:0},
    ],telemetry:{status:'unknown',reason:'http_403'}}:{items:[],delivery:{status:'not_configured'}}}));
    await page.goto(`http://127.0.0.1:${server.address().port}/hub/apps/board.html`);
    await page.waitForFunction(()=>document.getElementById('sources').textContent.includes('http_403'));
    const text=await page.locator('#sources').textContent();assert.match(text,/http_403/);assert.match(text,/invalid_json/);assert.doesNotMatch(text,/PRIVATE_DETAIL|<img|http_401/);
    assert.equal(await page.locator('#sources img').count(),0);assert.equal(await page.locator('#sources details').evaluate(el=>el.open),true);
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.HUB_DIAGNOSTIC_SCREENSHOT)await page.screenshot({path:process.env.HUB_DIAGNOSTIC_SCREENSHOT,fullPage:true});
    assert.deepEqual(errors,[]);console.log('PASS: source HTTP/JSON diagnostic codes visible only for errors; unknown/raw fields omitted; no HTML injection; mobile layout; synthetic local API only.');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
