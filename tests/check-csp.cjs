// Статическая проверка: каждая страница хаба и apps/ несёт строгий CSP и не тянет чужие скрипты.
// Запуск: node tests/check-csp.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'public'); // то, что реально раздаёт Worker
const CSP_OK = [
  "default-src 'self'; connect-src 'self' https://api.anthropic.com; style-src 'self' 'unsafe-inline'",
  "default-src 'self'; connect-src 'self' https://api.anthropic.com; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self'",
  "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self'",
];
// apps/ обходим рекурсивно: приложение в подпапке не должно проскочить мимо проверки
function walk(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir + '/' + e.name;
    return e.isDirectory() ? walk(rel) : [rel];
  });
}
const pages = ['index.html', 'login.html', ...walk('apps').filter((f) => f.endsWith('.html'))];
const scripts = [...fs.readdirSync(ROOT).filter((f) => f.endsWith('.js')), ...walk('apps').filter((f) => f.endsWith('.js'))];

let fails = 0;
const fail = (p, msg) => { fails++; console.log(`FAIL ${p}: ${msg}`); };
for (const p of pages) {
  const before = fails;
  const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi)];
  if (metas.length !== 1) fail(p, `CSP meta: ${metas.length} шт.`);
  else if (!CSP_OK.includes(metas[0][1])) fail(p, `CSP отличается: ${metas[0][1]}`);
  for (const meta of metas) {
    if (/(?:^|;)\s*frame-ancestors(?:\s|;|$)/i.test(meta[1])) fail(p, 'frame-ancestors не поддерживается в CSP meta; используйте HTTP header');
  }
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
// опасные приёмники HTML/кода: ответ модели и данные из localStorage идут только через textContent
const SINKS = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new\s+Function)\b/;
for (const f of scripts) {
  const before = fails;
  fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
    if (SINKS.test(line)) fail(f, `строка ${i + 1}: опасный приёмник HTML/кода`);
  });
  if (fails === before) console.log(`ok   ${f}`);
}
console.log(fails ? `${fails} ошибок` : `${pages.length} из ${pages.length} страниц и ${scripts.length} скриптов ок`);
process.exit(fails ? 1 : 0);
