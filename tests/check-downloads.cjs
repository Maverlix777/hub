// Проверка реестра сборок: JSON-блок #manifest в apps/downloads.html.
// Запуск: node tests/check-downloads.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', 'apps', 'downloads.html');
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/<script type="application\/json" id="manifest">([\s\S]*?)<\/script>/);
const errors = [];
let items = [];
if (!m) errors.push('нет JSON-блока #manifest');
else {
  try { items = JSON.parse(m[1]); } catch (e) { errors.push('JSON: ' + e.message); }
}
if (!Array.isArray(items)) { errors.push('manifest должен быть массивом'); items = []; }
const required = ['project', 'platform', 'kind', 'version', 'file', 'sha256', 'date', 'url'];
items.forEach((it, i) => {
  for (const k of required) if (!it[k]) errors.push(`#${i}: нет поля ${k}`);
  if (it.sha256 && !/^[0-9a-f]{64}$/.test(it.sha256)) errors.push(`#${i}: sha256 не 64 hex`);
  if (it.date && !/^\d{4}-\d{2}-\d{2}$/.test(it.date)) errors.push(`#${i}: дата не YYYY-MM-DD`);
  if (it.url && !/^https:\/\//.test(it.url)) errors.push(`#${i}: url не https`);
});
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`ok   manifest: ${items.length} запис.`);
