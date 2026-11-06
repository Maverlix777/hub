'use strict';
// Browser contract: default/persisted collapse, status age, errors and the fixed message panel. Synthetic API only.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const session = { username: 'synthetic-owner', apps: ['board'], locked: [] };
const columnKeys = ['planned', 'progress', 'review', 'done'];
const collapseKey = 'hub.board.collapsed';
const artifactDir = path.resolve(__dirname, '../artifacts/hub');
const mk = (id, column, extra = {}) => ({ key: `f::${id}`, id, title: `Task ${id}`, source: 'S', column, state: 'x', owner: 'o', sourcePath: 'a.md', sourceRevision: 'a'.repeat(40), ...extra });
const expandedStates = (page) => page.locator('.col-toggle').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-expanded')));
const ready = (page) => page.locator('#columns[aria-busy="false"] .col-toggle').first().waitFor();
async function fixedPanelInViewport(page) {
  const geometry = await page.locator('#snezhana-panel').evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    return { position: getComputedStyle(panel).position, x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, viewportWidth: innerWidth, viewportHeight: innerHeight, scrollY };
  });
  assert.equal(geometry.position, 'fixed');
  assert.ok(geometry.scrollY >= 900, `long page was scrolled: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= geometry.viewportWidth && geometry.bottom <= geometry.viewportHeight, `panel remains within viewport: ${JSON.stringify(geometry)}`);
  return geometry;
}
(async () => {
  const { loadBoardSources } = await import('../src/board-sources.js');
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
  const { board: fixtureBoard } = await loadBoardSources({ BOARD_GITHUB_TOKEN: 'synthetic', BOARD_PATHS: 'fixtures/BOARD.md', BOARD_IDEA_PATHS: '' }, async (url) => {
    if (url.includes('/contents/')) return new Response('| ID | Task | State | Evidence |\n|---|---|---|---|\n| T-5 | Task T-5 | Review 2020-01-01 | [Issue](https://github.com/Maverlix777/agent-handoffs/issues/42) |');
    assert.equal(url, 'https://api.github.com/repos/Maverlix777/agent-handoffs/issues/42/events?per_page=100&page=1');
    return Response.json([{ event: 'labeled', label: { name: 'cloud:review' }, created_at: fiveDaysAgo }, { event: 'commented', created_at: new Date().toISOString() }]);
  });
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
    const failures = [];
    let boardMode = 'ok'; const posts = [];
    async function newPage(viewport = { width: 1440, height: 1000 }) {
      const page = await browser.newPage({ viewport });
      page.on('pageerror', (e) => failures.push(e.message));
      await page.route('**/hub/api/**', async (route) => {
        const req = route.request(); const url = new URL(req.url());
        if (url.pathname.endsWith('/session')) return route.fulfill({ json: session });
        if (url.pathname.endsWith('/board')) {
          if (boardMode === 'fail') return route.fulfill({ status: 503, json: { error: 'board_unavailable' } });
          const longRows = boardMode === 'long' ? Array.from({ length: 60 }, (_, index) => mk(`LONG-${index}`, 'planned')) : [];
          return route.fulfill({ json: { cards: [mk('T-1', 'planned'), mk('T-2', 'progress', { statusAgeLabel: 'в статусе 5 ч' }), mk('T-3', 'progress'), mk('T-4', 'review', { statusAgeLabel: 'нет данных' }), ...fixtureBoard.cards, ...longRows],
            sources: boardMode === 'srcerr' ? [{ name: 'src', path: 'a.md', status: 'error', error: 'http_403', cardCount: 0 }] : [{ name: 'src', path: 'a.md', status: 'available', cardCount: 5 }] } });
        }
        if (req.method() === 'GET') return route.fulfill({ json: { items: [], delivery: { status: 'not_configured' } } });
        assert.equal(req.method(), 'POST'); assert.equal(url.pathname, '/hub/api/outbox');
        assert.equal(req.headers()['x-hub-request'], '1');
        const payload = req.postDataJSON(); posts.push(payload);
        return route.fulfill({ status: 201, json: { item: { ...payload, id: `i${posts.length}`, status: 'pending', receipt: null } } });
      });
      return page;
    }
    const page = await newPage();
    await page.goto(base + '/hub/apps/board.html'); await ready(page);
    // T1: all four columns start collapsed; their counts still equal the real cards.
    const counts = await page.locator('.col').evaluateAll((cols) => cols.map((c) => [c.querySelector('.col-toggle').getAttribute('aria-expanded'), c.querySelector('.count').textContent, c.querySelectorAll('button.card').length]));
    assert.deepEqual(counts, [['false', '1', 1], ['false', '2', 2], ['false', '2', 2], ['false', '0', 0]]);
    for (const key of columnKeys) assert.equal(await page.locator(`#col-${key}`).isHidden(), true);
    await page.locator('.col-toggle[data-col="progress"]').click();
    assert.equal(await page.locator('.col-toggle[data-col="progress"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#col-progress').isVisible(), true);
    assert.equal(await page.locator('.col-toggle[data-col="progress"] .count').textContent(), '2');
    await page.reload(); await ready(page);
    assert.deepEqual(await expandedStates(page), ['false', 'true', 'false', 'false'], 'saved choice survives reload');
    assert.equal(await page.locator('#col-progress').isVisible(), true);
    // T2: age line in detail
    await page.locator('button.card', { hasText: 'Task T-2' }).click();
    assert.match(await page.locator('#detail-content').textContent(), /в статусе 5 ч/);
    await page.locator('#close-detail').click();
    await page.locator('.col-toggle[data-col="review"]').click();
    await page.locator('button.card', { hasText: 'Task T-4' }).click();
    assert.match(await page.locator('#detail-content').textContent(), /нет данных/);
    await page.locator('#close-detail').click();
    await page.locator('#col-review button.card', { hasText: 'Task T-5' }).click();
    assert.equal(await page.locator('#task-dialog').evaluate((dialog) => dialog.open), true);
    assert.match(await page.locator('#detail-content').textContent(), /Время в статусе\s*в статусе 5 дн/);
    await page.locator('#close-detail').click();
    await page.locator('.col-toggle[data-col="planned"]').click();
    await page.locator('button.card', { hasText: 'Task T-1' }).click();
    assert.doesNotMatch(await page.locator('#detail-content').textContent(), /в статусе/);
    await page.locator('#close-detail').click();
    // errors shown
    boardMode = 'srcerr'; await page.locator('#refresh').click();
    await page.locator('#board-errors:not([hidden])').waitFor();
    assert.match(await page.locator('#board-errors').textContent(), /http_403/);
    boardMode = 'fail'; await page.locator('#refresh').click();
    await page.waitForFunction(() => /board_unavailable/.test(document.getElementById('board-errors').textContent));
    boardMode = 'ok';
    await page.close();
    // T3: an explicit saved [] means expanded; absent/invalid storage uses safe defaults.
    const storageCases = [
      ['missing', null, ['false', 'false', 'false', 'false']],
      ['saved empty', '[]', ['true', 'true', 'true', 'true']],
      ['saved preference', '["progress"]', ['true', 'false', 'true', 'true']],
      ['invalid JSON', '{', ['false', 'false', 'false', 'false']],
      ['invalid object', '{}', ['false', 'false', 'false', 'false']],
      ['invalid entries', '[null,"unknown"]', ['false', 'false', 'false', 'false']],
    ];
    for (const [name, stored, expected] of storageCases) {
      const storagePage = await newPage();
      await storagePage.addInitScript(({ key, value }) => { if (value !== null) localStorage.setItem(key, value); }, { key: collapseKey, value: stored });
      await storagePage.goto(base + '/hub/apps/board.html'); await ready(storagePage);
      assert.deepEqual(await expandedStates(storagePage), expected, name);
      await storagePage.close();
    }
    const deniedPage = await newPage();
    await deniedPage.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage denied', 'SecurityError'); } }));
    await deniedPage.goto(base + '/hub/apps/board.html'); await ready(deniedPage);
    assert.deepEqual(await expandedStates(deniedPage), ['false', 'false', 'false', 'false'], 'denied storage defaults');
    await deniedPage.locator('.col-toggle[data-col="progress"]').click();
    await deniedPage.locator('#q').fill('Task T-2');
    await deniedPage.locator('#refresh').click(); await ready(deniedPage);
    assert.equal(await deniedPage.locator('#col-progress').isVisible(), true, 'toggle survives rerenders when storage is denied');
    await deniedPage.locator('.col-toggle[data-col="progress"]').click();
    assert.equal(await deniedPage.locator('#col-progress').isHidden(), true, 'can toggle back without storage');
    await deniedPage.close();
    // T4: the existing fixed panel remains usable after long-page scrolling at both requested widths.
    boardMode = 'long'; fs.mkdirSync(artifactDir, { recursive: true });
    for (const width of [390, 1280]) {
      const panelPage = await newPage({ width, height: 900 });
      await panelPage.goto(base + '/hub/apps/board.html'); await ready(panelPage);
      assert.equal(await panelPage.locator('#snezhana-body').isHidden(), true, 'panel compact by default');
      assert.equal(await panelPage.locator('#snezhana-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await panelPage.locator('#snezhana-toggle svg.avatar').count(), 1, 'existing character icon retained');
      await panelPage.locator('.col-toggle[data-col="planned"]').click();
      await panelPage.evaluate(() => window.scrollTo(0, 1000));
      await panelPage.waitForFunction(() => scrollY >= 900);
      assert.ok((await fixedPanelInViewport(panelPage)).width < 260, 'compact panel width');
      if (width === 390) await panelPage.screenshot({ path: path.join(artifactDir, '933-panel-390.png') });
      await panelPage.locator('#snezhana-toggle').click();
      assert.equal(await panelPage.locator('#snezhana-body').isVisible(), true);
      assert.equal(await panelPage.locator('#snezhana-toggle').getAttribute('aria-expanded'), 'true');
      await fixedPanelInViewport(panelPage);
      const opts = await panelPage.locator('#snezhana-to option').evaluateAll((options) => options.map((option) => option.value));
      assert.deepEqual(opts, ['idea', 'claude', 'codex', 'snezhana', 'pedro', 'mazila']);
      const text = `Synthetic panel message at ${width}px`;
      const before = posts.length;
      await panelPage.locator('#snezhana-to').selectOption('codex');
      await panelPage.locator('#snezhana-text').fill(text);
      await panelPage.locator('#snezhana-form button[type=submit]').click();
      await panelPage.locator('#snezhana-form .form-status.success').waitFor();
      assert.match(await panelPage.locator('#snezhana-form .form-status.success').textContent(), /Сохранено в очереди/);
      assert.equal(posts.length, before + 1); assert.equal(posts[before].addressee, 'codex');
      assert.equal(posts[before].kind, 'message'); assert.equal(posts[before].text, text);
      assert.match(posts[before].idempotencyKey, /^[a-f0-9-]{36}$/);
      assert.equal(await panelPage.locator('#snezhana-text').inputValue(), '');
      await fixedPanelInViewport(panelPage);
      if (width === 1280) await panelPage.screenshot({ path: path.join(artifactDir, '933-panel-1280.png') });
      await panelPage.close();
    }
    assert.deepEqual(failures, []);
    console.log('PASS board-collapse: four default collapsed columns; saved empty/preference, malformed/missing/denied storage; usable toggles/reload; issue 931 label-event age drawer; error text; 390/1280px scrolled fixed panel, real success state and exactly one synthetic POST per send.');
  } finally { if (browser) await browser.close(); server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
