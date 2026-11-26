'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');

const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appsMatch = indexHtml.match(/id="apps">([\s\S]*?)<\/script>/);
assert(appsMatch, 'missing #apps JSON in public/index.html');
const apps = JSON.parse(appsMatch[1]);
const money = apps.find((a) => a.id === 'money');
assert(money, 'catalog entry money missing');
assert.equal(money.status, 'ready');
assert.equal(money.href, 'apps/money.html');

const moneyHtml = fs.readFileSync(path.join(root, 'public/apps/money.html'), 'utf8');
const snapMatch = moneyHtml.match(/id="money-snapshot">([\s\S]*?)<\/script>/);
assert(snapMatch, 'missing #money-snapshot in public/apps/money.html');
const snap = JSON.parse(snapMatch[1]);
assert(snap.approved_ids.includes('cmp_wow_forever_uk'));
assert(snap.approved_ids.includes('cmp_metaphor_refantazio'));
assert(!snap.approved_ids.includes('cmp_tokyo_girl_skip'));

const moneyJs = fs.readFileSync(path.join(root, 'public/apps/money.js'), 'utf8');
assert(!moneyJs.includes('innerHTML'), 'money.js must not use innerHTML');

assert(fs.existsSync(path.join(root, 'public/money/kit/index.html')));
assert(fs.existsSync(path.join(root, 'public/money/link/index.html')));
const linkHtml = fs.readFileSync(path.join(root, 'public/money/link/index.html'), 'utf8');
const linkJson = fs.readFileSync(path.join(root, 'public/money/link/links.json'), 'utf8');
assert(linkHtml.includes('../kit/index.html'));
assert(!linkHtml.includes('../media-kit/'));
assert(linkJson.includes('../kit/index.html'));
assert(!linkJson.includes('../media-kit/'));

console.log('money-app: PASS');