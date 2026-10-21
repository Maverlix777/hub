// Optional offline browser smoke; no real sessions, accounts, or API requests.
'use strict';
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../public');
const screenshots = process.env.SITE4_SCREENSHOTS;
const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.webmanifest':'application/manifest+json'};
(async () => {
  const server = http.createServer((req, res) => {
    let rel = new URL(req.url, 'http://local').pathname;
    if (!rel.startsWith('/hub/')) { res.writeHead(404).end(); return; }
    rel = rel.slice(5) || 'index.html';
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'content-type': mime[path.extname(file)] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
    if (screenshots) fs.mkdirSync(screenshots, {recursive:true});
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({viewport:{width:390,height:844},colorScheme});
      let mode = 200;
      let apiCalls = 0;
      await context.route('**/*', async route => {
        const url = route.request().url();
        if (url === origin + '/hub/api/session') {
          if (mode === 'network') return route.abort('failed');
          return route.fulfill({status:mode,contentType:'application/json',body:JSON.stringify(mode === 200 ? {username:'synthetic.user',entitlement:'free'} : {error:'synthetic'})});
        }
        if (url.startsWith('https://api.anthropic.com')) { apiCalls++; return route.abort('blockedbyclient'); }
        if (!url.startsWith(origin + '/')) throw new Error('Unexpected external request blocked');
        return route.continue();
      });
      const page = await context.newPage();
      await page.goto(origin + '/hub/');
      await page.locator('#account-name').filter({hasText:'synthetic.user'}).waitFor();
      assert.equal(await page.locator('#account-name').textContent(), 'synthetic.user');
      assert.equal(await page.locator('#logout').isVisible(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('#logout').focus();
      assert.equal(await page.locator('#logout').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
      if (screenshots) await page.screenshot({path:path.join(screenshots,`hub-390-${colorScheme}.png`),fullPage:true});
      await page.goto(origin + '/hub/apps/chat.html');
      await page.locator('#key').fill('synthetic-tab-only-key'); await page.locator('#saveKey').click();
      await page.locator('#input').fill('Unsent synthetic draft');
      mode = 503;
      await page.locator('#send').click();
      await page.locator('#session-status').waitFor({state:'visible'});
      assert.equal(await page.locator('#input').inputValue(), 'Unsent synthetic draft');
      assert.equal(await page.locator('#forgetKey').isDisabled(), false);
      assert.equal(apiCalls, 0);
      if (screenshots) await page.screenshot({path:path.join(screenshots,`chat-offline-390-${colorScheme}.png`),fullPage:true});
      mode = 200; await page.evaluate(() => dispatchEvent(new Event('focus')));
      await page.locator('#session-status').waitFor({state:'hidden'});
      assert.equal(await page.locator('#input').inputValue(), 'Unsent synthetic draft');
      mode = 401; await page.evaluate(() => dispatchEvent(new Event('focus')));
      await page.waitForURL(origin + '/hub/login/');
      assert.equal(apiCalls, 0);
      await context.close();
      console.log(`PASS ${colorScheme}: 390px layout/focus, outage preserves draft/key, recovery,401 redirect, no external API`);
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
