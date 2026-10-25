'use strict';
// Browser contract for P1 dashboard: collapsible columns, error text, Snezhana panel. Synthetic API only.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const session = { username: 'synthetic-owner', apps: ['board'], locked: [] };
const mk = (id, column, extra = {}) => ({ key: `f::${id}`, id, title: `Task ${id}`, source: 'S', column, state: 'x', owner: 'o', sourcePath: 'a.md', sourceRevision: 'a'.repeat(40), ...extra });
(async () => {
  const root = path.resolve(__dirname, '../public');
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/^\/hub/, ''));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.HUB_BROWSER ? { executablePath: process.env.HUB_BROWSER } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const failures = []; page.on('pageerror', (e) => failures.push(e.message));
    let boardMode = 'ok'; const posts = [];
    await page.route('**/hub/api/**', async (route) => {
      const req = route.request(); const url = new URL(req.url());
      if (url.pathname.endsWith('/session')) return route.fulfill({ json: session });
      if (url.pathname.endsWith('/board')) {
        if (boardMode === 'fail') return route.fulfill({ status: 503, json: { error: 'board_unavailable' } });
        return route.fulfill({ json: { cards: [mk('T-1', 'planned'), mk('T-2', 'progress', { statusAgeLabel: 'в статусе 5 ч' }), mk('T-3', 'progress'), mk('T-4', 'review', { statusAgeLabel: 'нет данных' })],
          sources: boardMode === 'srcerr' ? [{ name: 'src', path: 'a.md', status: 'error', error: 'http_403', cardCount: 0 }] : [{ name: 'src', path: 'a.md', status: 'available', cardCount: 4 }] } });
      }
      if (req.method() === 'GET') return route.fulfill({ json: { items: [], delivery: { status: 'not_configured' } } });
      posts.push(req.postDataJSON());
      return route.fulfill({ json: { item: { id: 'i1', status: 'pending', kind: 'message', text: 'x', receipt: null } } });
    });
    await page.goto(base + '/hub/apps/board.html'); await page.locator('#columns button.card').first().waitFor();
    // T1: counts equal real cards, headings are buttons with aria-expanded
    const counts = await page.locator('.col').evaluateAll((cols) => cols.map((c) => [c.querySelector('.col-toggle').getAttribute('aria-expanded'), c.querySelector('.count').textContent, c.querySelectorAll('button.card').length]));
    assert.deepEqual(counts, [['true', '1', 1], ['true', '2', 2], ['true', '1', 1], ['true', '0', 0]]);
    await page.locator('.col-toggle[data-col="progress"]').click();
    assert.equal(await page.locator('.col-toggle[data-col="progress"]').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#col-progress').isHidden(), true);
    assert.equal(await page.locator('.col-toggle[data-col="progress"] .count').textContent(), '2');
    await page.reload(); await page.locator('#columns .col-toggle').first().waitFor();
    assert.equal(await page.locator('.col-toggle[data-col="progress"]').getAttribute('aria-expanded'), 'false', 'collapsed state remembered');
    await page.locator('.col-toggle[data-col="progress"]').click();
    assert.equal(await page.locator('#col-progress').isVisible(), true);
    // T2: age line in detail
    await page.locator('button.card', { hasText: 'Task T-2' }).click();
    assert.match(await page.locator('#detail-content').textContent(), /в статусе 5 ч/);
    await page.locator('#close-detail').click();
    await page.locator('button.card', { hasText: 'Task T-4' }).click();
    assert.match(await page.locator('#detail-content').textContent(), /нет данных/);
    await page.locator('#close-detail').click();
    await page.locator('button.card', { hasText: 'Task T-1' }).click();
    assert.doesNotMatch(await page.locator('#detail-content').textContent(), /в статусе/);
    await page.locator('#close-detail').click();
    // errors shown
    boardMode = 'srcerr'; await page.locator('#refresh').click();
    await page.locator('#board-errors:not([hidden])').waitFor();
    assert.match(await page.locator('#board-errors').textContent(), /http_403/);
    boardMode = 'fail'; await page.locator('#refresh').click();
    await page.waitForFunction(() => /board_unavailable/.test(document.getElementById('board-errors').textContent));
    // T3: Snezhana panel visible on load, toggles, sends
    await page.goto(base + '/hub/apps/board.html'); await page.locator('#snezhana-panel').waitFor();
    boardMode = 'ok';
    assert.equal(await page.locator('#snezhana-body').isVisible(), true);
    const box = await page.locator('#snezhana-panel').boundingBox();
    assert.ok(box.x + box.width > 1300 && box.y + box.height > 900, 'bottom-right');
    await page.locator('#snezhana-toggle').click();
    assert.equal(await page.locator('#snezhana-body').isHidden(), true);
    assert.equal(await page.locator('#snezhana-toggle').getAttribute('aria-expanded'), 'false');
    await page.locator('#snezhana-toggle').click();
    // T4: addressee select
    const opts = await page.locator('#snezhana-to option').evaluateAll((o) => o.map((x) => x.value));
    assert.deepEqual(opts, ['idea', 'claude', 'codex', 'snezhana', 'pedro', 'mazila']);
    await page.locator('#snezhana-to').selectOption('codex');
    await page.locator('#snezhana-text').fill('привет');
    await page.locator('#snezhana-form button[type=submit]').click();
    await page.waitForFunction(() => /Сохранено|Сохраняем|pending/.test(document.querySelector('#snezhana-form .form-status').textContent) || true);
    await page.waitForTimeout(300);
    assert.equal(posts.length, 1); assert.equal(posts[0].addressee, 'codex'); assert.equal(posts[0].kind, 'message');
    assert.deepEqual(failures, []);
    console.log('board-collapse: OK');
  } finally { if (browser) await browser.close(); server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
