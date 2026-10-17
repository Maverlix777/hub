// Статическая проверка: каждая страница хаба и apps/ несёт строгий CSP и не тянет чужие скрипты.
// Запуск: node tests/check-csp.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CSP = "default-src 'self'; connect-src https://api.anthropic.com; style-src 'self' 'unsafe-inline'";
const pages = ['index.html', ...fs.readdirSync(path.join(ROOT, 'apps')).filter((f) => f.endsWith('.html')).map((f) => 'apps/' + f)];

let fails = 0;
const fail = (p, msg) => { fails++; console.log(`FAIL ${p}: ${msg}`); };
for (const p of pages) {
  const before = fails;
  const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi)];
  if (metas.length !== 1) fail(p, `CSP meta: ${metas.length} шт.`);
  else if (metas[0][1] !== CSP) fail(p, `CSP отличается: ${metas[0][1]}`);
  const head = html.slice(0, html.search(/<\/head>/i));
  if (metas.length && head.indexOf(metas[0][0]) > head.search(/<script|<link/i)) fail(p, 'CSP meta должен стоять до script/link');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (/type="application\/json"/i.test(attrs)) continue;
    if (!/\bsrc="/i.test(attrs)) fail(p, 'inline <script>');
    const src = (attrs.match(/\bsrc="([^"]*)"/i) || [])[1] || '';
    if (/^(https?:)?\/\//i.test(src)) fail(p, `внешний скрипт ${src}`);
  }
  for (const m of html.matchAll(/<link\b[^>]*href="([^"]*)"/gi)) {
    if (/^(https?:)?\/\//i.test(m[1])) fail(p, `внешний link ${m[1]}`);
  }
  if (/\son[a-z]+\s*=/i.test(html)) fail(p, 'inline-обработчик on*=');
  if (fails === before) console.log(`ok   ${p}`);
}
console.log(fails ? `${fails} ошибок` : `${pages.length} из ${pages.length} страниц ок`);
process.exit(fails ? 1 : 0);
