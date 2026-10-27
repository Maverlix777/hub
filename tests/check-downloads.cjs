// Проверка реестра сборок: JSON-блок #manifest в public/apps/downloads.html.
// Запуск: node tests/check-downloads.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', 'public', 'apps', 'downloads.html');
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
  if (it.available !== false && !it.date) errors.push(`#${i}: доступной записи нужна дата`);
  if (it.date && !/^\d{4}-\d{2}-\d{2}$/.test(it.date)) errors.push(`#${i}: дата не YYYY-MM-DD`);
  if (it.available !== false && !/^https:\/\//.test(it.url || '')) errors.push(`#${i}: url не https`);
  if (it.available === false && it.url) errors.push(`#${i}: недоступная запись не должна иметь ссылку`);
});
const lf = items.find((it) => it.project === 'Location Fusion' && it.platform === 'ios');
if (!lf || lf.kind !== 'ipa' || lf.version !== '3.1.14 (build 1, main 9037cb0, без встроенного VPN)' ||
    lf.file !== 'LocationFusion-ios-3.1.14-build1-unsigned.ipa' ||
    lf.url !== 'https://github.com/Maverlix777/hub/releases/download/lf-ios-3.1.14-build1/LocationFusion-ios-3.1.14-build1-unsigned.ipa' ||
    lf.date !== '2026-10-27' || !/SideStore\/AltStore/.test(lf.note || '') ||
    lf.size !== 22063261 || lf.sha256 !== 'e2d69a97ee98c44248b2957460acb81e9b2e577ced3b617ee67e0b68d4f93f6b') {
  errors.push('Location Fusion build 1 catalog entry does not match the verified artifact');
}
const lfAndroid = items.find((it) => it.file === 'LocationFusion-android-release.aab');
if (!lfAndroid || lfAndroid.project !== 'Location Fusion' || lfAndroid.platform !== 'android' ||
    lfAndroid.url !== 'https://github.com/Maverlix777/hub/releases/download/games-2026-10-22/LocationFusion-android-release.aab' ||
    lfAndroid.size !== 2917884 || lfAndroid.sha256 !== 'f70e818d35d9c95be89754a07aa2924127ba586b0e785368c0c009b976ec8013') {
  errors.push('Location Fusion Android AAB must match games-2026-10-22 metadata');
}
const kb = items.find((it) => it.project === 'Krenkballs' && it.version === '75 (7340a86)');
if (!kb || kb.available === false ||
    kb.url !== 'https://github.com/Maverlix777/hub/releases/download/krenkballs-android-75-debug/Krenkballs-android-75-debug.apk' ||
    kb.size !== 11599092 || kb.sha256 !== '9e0a26373a7ef04ceb229a61e0aa91edb134ed05a81b7e8e500dc0b56e2189b8') {
  errors.push('Krenkballs build 75 catalog entry does not match the verified artifact');
}
const doktor = items.find((it) => it.project === 'Доктор' && it.version === '1.0.3');
if (!doktor || doktor.url !== 'https://github.com/Maverlix777/doktor-sidestore/releases/download/v1.0.3/Doktor.ipa' ||
    doktor.size !== 6565410 || doktor.date !== '2026-10-18' ||
    doktor.sha256 !== '13a7480f5904c97261b6bdebf65a61f45e1178e673c629165008f4c9bc60b67c') {
  errors.push('Doktor 1.0.3 must match public apps.json metadata');
}
const unavailable = items.find((it) => it.project === 'Nebula Pop');
if (!unavailable || unavailable.available !== false || unavailable.url) {
  errors.push('Nebula Pop must remain clearly unavailable until a public file URL exists');
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`ok   manifest: ${items.length} запис.`);
