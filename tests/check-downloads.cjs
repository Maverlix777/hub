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
const required = ['project', 'platform', 'kind', 'version', 'file', 'size', 'sha256'];
items.forEach((it, i) => {
  for (const k of required) if (!it[k]) errors.push(`#${i}: нет поля ${k}`);
  if (it.sha256 && !/^[0-9a-f]{64}$/.test(it.sha256)) errors.push(`#${i}: sha256 не 64 hex`);
  if (it.date && !/^\d{4}-\d{2}-\d{2}$/.test(it.date)) errors.push(`#${i}: дата не YYYY-MM-DD`);
  if (it.available !== false && !/^https:\/\//.test(it.url || '')) errors.push(`#${i}: url не https`);
  if (it.available === false && it.url) errors.push(`#${i}: недоступная запись не должна иметь ссылку`);
});
const lf = items.find((it) => it.project === 'Location Fusion Test' && it.version === '3.1.14 (9)');
if (!lf || lf.url !== 'https://kolobovdjp.org/locationfusion/install/LocationFusion-Test-build9-UI.ipa' ||
    lf.size !== 22141414 || lf.sha256 !== 'bc799908eb6f9f6e09c6811a7ddde94d51c9eb80b2ecb4c359067881933dd0e5') {
  errors.push('Location Fusion build 9 catalog entry does not match the verified artifact');
}
const kb = items.find((it) => it.project === 'Krenkballs' && it.version === '75 (7340a86)');
if (!kb || kb.available === false ||
    kb.url !== 'https://github.com/Maverlix777/hub/releases/download/krenkballs-android-75-debug/Krenkballs-android-75-debug.apk' ||
    kb.size !== 11599092 || kb.sha256 !== '9e0a26373a7ef04ceb229a61e0aa91edb134ed05a81b7e8e500dc0b56e2189b8') {
  errors.push('Krenkballs build 75 catalog entry does not match the verified artifact');
}
const unavailable = items.find((it) => it.project === 'Nebula Pop');
if (!unavailable || unavailable.available !== false || unavailable.url) {
  errors.push('Nebula Pop must remain clearly unavailable until a public file URL exists');
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`ok   manifest: ${items.length} запис.`);
