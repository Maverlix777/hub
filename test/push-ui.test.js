import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const ui = await readFile(new URL('../public/push.js', import.meta.url), 'utf8');
const sw = await readFile(new URL('../public/push-sw.js', import.meta.url), 'utf8');
const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup({ path = '/hub/', permission = 'granted', supported = true, config = {publicKey:key}, saveFails = false, existing = false, rotated = false } = {}) {
  const events = {}, calls = [], registrationCalls = [];
  const nodes = {
    'push-toggle': { disabled: true, addEventListener: (name, fn) => { events[name] = fn; } },
    'push-status': { textContent: '' },
  };
  let requested = 0, subscribed = 0, removed = 0;
  const subscription = { options: {applicationServerKey: Uint8Array.from(Buffer.from(rotated ? Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]).toString('base64url') : key, 'base64url')).buffer}, endpoint: 'https://example.invalid/push', toJSON: () => ({ endpoint: 'https://example.invalid/push', keys: { auth:'fake', p256dh:'fake' } }), unsubscribe: async () => { removed++; return true; } };
  const registration = {active: {}, pushManager: { getSubscription: async () => existing ? subscription : null, subscribe: async () => { subscribed++; return subscription; } } };
  const window = { isSecureContext: supported, location: { pathname:path, origin:'https://hub.example' }, addEventListener: (name, fn) => { events[name] = fn; }, PushManager: {}, Notification: {} };
  const navigator = {serviceWorker: {register: async (...args) => { registrationCalls.push(args); return registration; }, getRegistration: async () => existing ? registration : null }};
  vm.runInNewContext(ui, {
    window, navigator, URL, Uint8Array, atob: value => Buffer.from(value, 'base64').toString('binary'),
    document: {getElementById: id => nodes[id]}, Notification: {requestPermission: async () => { requested++; return permission; }},
    fetch: async (url, options) => {
      calls.push([url, options]);
      const isConfig = url.endsWith('/config');
      return {ok:isConfig || !saveFails, status: isConfig || !saveFails ? 200 : 503, json: async () => config};
    },
  });
  await tick();
  return {nodes, events, calls, registrationCalls, counts: () => ({requested,subscribed,removed})};
}

test('permission and registration happen only after a click; mounted and root URLs work', async () => {
  for (const path of ['/hub/', '/']) {
    const page = await setup({path});
    assert.deepEqual(page.counts(), {requested:0,subscribed:0,removed:0});
    assert.equal(page.nodes['push-toggle'].disabled, false);
    await page.events.click();
    assert.deepEqual(page.counts(), {requested:1,subscribed:1,removed:0});
    assert.equal(page.registrationCalls[0][0], `https://hub.example${path}push-sw.js`);
    assert.equal(page.registrationCalls[0][1].scope, path);
    assert.equal(page.calls[1][0], `https://hub.example${path}api/push/subscriptions`);
    assert.equal(page.calls[1][1].headers['X-Hub-Request'], '1');
    assert.equal(page.calls[1][1].method, 'POST');
    assert.match(page.nodes['push-status'].textContent, /Подписка сохранена/);
    await page.events.click();
    assert.equal(page.calls[2][1].method, 'DELETE');
    assert.deepEqual(page.counts(), {requested:1,subscribed:1,removed:1});
  }
});

test('denied permission does not register or persist a subscription', async () => {
  const page = await setup({permission:'denied'});
  await page.events.click();
  assert.equal(page.registrationCalls.length, 0);
  assert.equal(page.calls.length, 1);
  assert.match(page.nodes['push-status'].textContent, /Разрешение не получено/);
});

test('missing key, unsupported browsers and logout keep the action disabled', async () => {
  const missing = await setup({config:{publicKey:null}});
  assert.equal(missing.nodes['push-toggle'].disabled, true);
  assert.match(missing.nodes['push-status'].textContent, /ещё не настроена/);
  const unsupported = await setup({supported:false});
  assert.equal(unsupported.calls.length, 0);
  assert.match(unsupported.nodes['push-status'].textContent, /экран «Домой»/);
  const page = await setup();
  page.events['hub:session-ended']();
  await page.events.click();
  assert.equal(page.calls.length, 1);
  assert.equal(page.nodes['push-toggle'].disabled, true);
});

test('a failed storage request never claims successful subscription', async () => {
  const page = await setup({saveFails:true});
  await page.events.click();
  assert.match(page.nodes['push-status'].textContent, /Не удалось сохранить/);
  assert.equal(page.nodes['push-toggle'].textContent, 'Включить уведомления');
});

test('existing browser subscription is reconciled without requesting permission', async () => {
  const page = await setup({existing:true});
  assert.equal(page.nodes['push-toggle'].textContent, 'Отключить уведомления');
  assert.equal(page.counts().requested, 0);
  assert.equal(page.calls[1][1].method, 'POST');
});

test('service worker shows generic text and ignores payload URLs; it never handles fetch', async () => {
  const listeners = {}, notifications = [], opened = [];
  const self = {
    addEventListener: (type, handler) => {listeners[type] = handler;},
    registration: {scope:'https://hub.example/hub/', showNotification: async (...args) => {notifications.push(args);}},
    clients: {matchAll: async () => [{url:'https://evil.example/', focus: () => {throw Error('wrong focus');}}], openWindow: async url => {opened.push(url);}},
  };
  vm.runInNewContext(sw, {self, URL});
  assert.equal(listeners.fetch, undefined);
  let pending;
  listeners.push({data:{json:() => {throw Error('payload must be ignored');}}, waitUntil: promise => {pending=promise;}});
  await pending;
  assert.equal(notifications[0][0], 'От агентов');
  assert.equal(notifications[0][1].icon, 'https://hub.example/hub/icons/icon-192.png');
  let closed = false;
  listeners.notificationclick({notification:{data:{url:'https://evil.example'},close:() => {closed=true;}}, waitUntil: promise => {pending=promise;}});
  await pending;
  assert.equal(closed,true);
  assert.deepEqual(opened,['https://hub.example/hub/']);
});

test('rapid repeated clicks create only one subscription', async () => {
  const page = await setup();
  const first = page.events.click();
  const second = page.events.click();
  await Promise.all([first, second]);
  assert.deepEqual(page.counts(), {requested:1,subscribed:1,removed:0});
  assert.equal(page.calls.filter(([, options]) => options.method === 'POST').length, 1);
});

test('failed reconciliation leaves a retry action instead of claiming subscribed', async () => {
  const page = await setup({existing:true, saveFails:true});
  assert.equal(page.nodes['push-toggle'].disabled, false);
  assert.equal(page.nodes['push-toggle'].textContent, 'Включить уведомления');
  assert.doesNotMatch(page.nodes['push-status'].textContent, /Это устройство подписано/);
  await page.events.click();
  assert.equal(page.calls.filter(([, options]) => options.method === 'POST').length, 2);
  assert.equal(page.counts().subscribed, 0);
});

test('rotated application key replaces an old browser subscription on explicit click', async () => {
  const page = await setup({existing:true, rotated:true});
  assert.equal(page.nodes['push-toggle'].textContent, 'Включить уведомления');
  assert.equal(page.calls.length, 1);
  await page.events.click();
  assert.deepEqual(page.counts(), {requested:1,subscribed:1,removed:1});
  assert.match(page.nodes['push-status'].textContent, /Подписка сохранена/);
});