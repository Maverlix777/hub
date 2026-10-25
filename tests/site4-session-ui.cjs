'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
class Element {
  constructor(id) { this.id = id; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.listeners = {}; this.children = []; this.dataset = {}; this.options = []; this.attrs = {}; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  async fire(name, event = {}) { await Promise.all((this.listeners[name] || []).map(fn => fn(event))); }
  append(child) { this.children.push(child); child.parent = this; }
  setAttribute(name, value) { this.attrs[name] = value; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  querySelector(name) { return this.children.find(x => x.className === name.replace('.', '')); }
  scrollIntoView() {}
  focus() { this.focused = true; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const session = (status = 200, body = {username: 'synthetic.user', entitlement: 'free'}) => ({status, ok: status >= 200 && status < 300, json: async () => body});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
function page(kind, fetcher, appList = [], options = {}) {
  const elements = {};
  const get = id => elements[id] ||= new Element(id);
  const document = new Element('document');
  document.getElementById = id => options.headerOnly && ['apps','grid'].includes(id) ? null : get(id);
  document.createElement = () => new Element('created');
  document.hidden = false;
  const window = new Element('window');
  window.dispatchEvent = event => { for (const fn of window.listeners[event.type] || []) fn(event); return true; };
  const redirects = [];
  window.location = {replace: url => redirects.push(url)};
  get('apps').textContent = JSON.stringify(appList);
  get('model').value = 'test-model';
  get('logout').hidden = true;
  get('session-status').hidden = true;
  get('input').value = 'Unsent draft';
  const stored = {
    'hub.chat.key': 'synthetic-old-key',
    'hub.chat.history': JSON.stringify([{role: 'user', content: 'old question'}, {role: 'assistant', content: 'old answer'}]),
    'hub.chat.system': 'synthetic system',
  };
  Object.defineProperties(stored, {
    getItem: {value: k => stored[k] ?? null}, setItem: {value: (k, v) => { stored[k] = v; }}, removeItem: {value: k => { delete stored[k]; }},
  });
  const calls = [];
  const context = {window, document, localStorage: stored, AbortController, TextDecoder, Date, Event, console,
    fetch: async (url, options) => { calls.push({url, options}); return fetcher(url, options); }};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, kind === 'hub' ? 'public/hub.js' : 'public/apps/chat.js'), 'utf8'), context);
  return {get, window, document, redirects, stored, calls};
}

test('initial account is hidden and successful hub session shows only username', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /id="logout"[^>]*hidden/);
  const wait = deferred(); const p = page('hub', () => wait.promise);
  assert.equal(p.get('logout').hidden, true);
  wait.resolve(session()); await tick();
  assert.equal(p.get('logout').hidden, false);
  assert.equal(p.get('account-name').textContent, 'synthetic.user');
  assert.equal(p.get('session-status').hidden, true);
});

for (const kind of ['hub', 'chat']) {
  for (const failure of ['network', '500', 'bad-json', 'invalid-shape']) {
    test(`${kind}: ${failure} preserves stored data, draft, and key and recovers`, async () => {
      let healthy = false;
      const p = page(kind, async url => {
        assert.equal(url, '/hub/api/session');
        if (healthy) return session();
        if (failure === 'network') throw new TypeError('offline');
        if (failure === '500') return session(503);
        if (failure === 'invalid-shape') return session(200, null);
        return {ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); }};
      });
      await tick();
      if (kind === 'chat') {
        p.get('key').value = 'synthetic-tab-key'; await p.get('saveKey').fire('click');
        await p.get('send').fire('click');
      }
      assert.equal(p.stored['hub.chat.key'], kind === 'hub' ? undefined : 'synthetic-old-key');
      assert.equal(p.stored['hub.chat.history'], JSON.stringify([{role: 'user', content: 'old question'}, {role: 'assistant', content: 'old answer'}]));
      assert.equal(p.get('input').value, 'Unsent draft');
      assert.deepEqual(p.redirects, []);
      assert.equal(p.get('session-status').hidden, false);
      assert.match(p.get('session-status').textContent, /связ|сервер|соединен/i);
      assert.ok(p.calls.every(call => call.url === '/hub/api/session'));
      healthy = true; await p.window.fire('focus'); await tick();
      assert.equal(p.get('session-status').hidden, true);
      assert.equal(p.get('input').value, 'Unsent draft');
      if (kind === 'chat') assert.equal(p.get('forgetKey').disabled, false, 'tab key survived outage');
    });
  }
  for (const status of [401, 403]) {
    test(`${kind}: ${status} clears chat state and redirects`, async () => {
      const p = page(kind, async () => session(status)); await tick();
      if (kind === 'chat') await p.get('send').fire('click');
      assert.equal(p.stored['hub.chat.history'], undefined);
      assert.equal(p.stored['hub.chat.key'], undefined);
      assert.deepEqual(p.redirects, ['/hub/login/']);
    });
  }
}

test('focus and visibility share pending chat check; logout prevents stale success/send', async () => {
  const wait = deferred(); const p = page('chat', () => wait.promise);
  const focus = p.window.fire('focus'); const visibility = p.document.fire('visibilitychange');
  await tick(); assert.equal(p.calls.length, 1);
  await p.window.fire('storage', {key: 'hub.session.logout'});
  wait.resolve(session()); await Promise.all([focus, visibility]); await tick();
  await p.get('send').fire('click');
  assert.equal(p.calls.length, 1);
  assert.deepEqual(p.redirects, ['/hub/login/']);
  assert.equal(p.get('input').value, 'Unsent draft');
});

test('navigation, accessible status and focus CSS are present', () => {
  for (const file of ['public/apps/chat.html', 'public/apps/downloads.html']) {
    assert.match(fs.readFileSync(path.join(ROOT, file), 'utf8'), /id="hub" href="\/hub\/"/);
  }
  for (const file of ['public/index.html', 'public/apps/chat.html']) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(html, /id="session-status"[^>]*role="status"/);
    assert.match(html, /id="session-status"[^>]*aria-live="polite"/);
  }
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  assert.match(css, /\.account\s*\{/);
  assert.match(css, /:focus-visible[^}]*outline:\s*[23]px/);
});

test('hub: explicit logout is terminal while initial successful response is pending', async () => {
  const wait = deferred();
  const p = page('hub', url => url === '/hub/api/session' ? wait.promise : Promise.resolve(session()));
  await p.get('logout').fire('click');
  wait.resolve(session()); await tick();
  assert.equal(p.get('logout').hidden, true);
  assert.equal(p.get('account').hidden, true);
  assert.equal(p.get('account-name').textContent, '');
  assert.deepEqual(p.redirects, ['/hub/login/']);
  assert.equal(p.stored['hub.chat.history'], undefined);
});

test('hub: cross-tab logout prevents a delayed JSON success revealing account', async () => {
  const wait = deferred();
  const p = page('hub', async () => ({ok: true, status: 200, json: () => wait.promise}));
  await tick(); await p.window.fire('storage', {key: 'hub.session.logout'});
  wait.resolve({username: 'synthetic.user'}); await tick();
  assert.equal(p.get('account').hidden, true);
  assert.equal(p.get('logout').hidden, true);
  assert.deepEqual(p.redirects, ['/hub/login/']);
});

test('hostile username is text; empty username is an outage, not authentication failure', async () => {
  const hostile = '<img src=x onerror=synthetic>';
  const p = page('hub', async () => session(200, {username: hostile})); await tick();
  assert.equal(p.get('account-name').textContent, hostile);
  for (const username of ['', '  ', 1, null]) {
    const invalid = page('hub', async () => session(200, {username})); await tick();
    assert.deepEqual(invalid.redirects, []);
    assert.equal(invalid.get('logout').hidden, true);
    assert.equal(invalid.get('session-status').hidden, false);
    assert.equal(invalid.stored['hub.chat.history'], JSON.stringify([{role: 'user', content: 'old question'}, {role: 'assistant', content: 'old answer'}]));
  }
});

test('typing during a pending send check retains the newer draft and makes no API request', async () => {
  let wait = null;
  const p = page('chat', () => wait ? wait.promise : Promise.resolve(session())); await tick();
  p.get('key').value = 'synthetic-key'; await p.get('saveKey').fire('click');
  wait = deferred();
  const first = p.get('send').fire('click'); const second = p.get('send').fire('click');
  p.get('input').value = 'Newer unsent draft';
  wait.resolve(session()); await Promise.all([first, second]);
  assert.equal(p.get('input').value, 'Newer unsent draft');
  assert.equal(p.calls.length, 2);
  assert.ok(p.calls.every(call => call.url === '/hub/api/session'));
});


test('hub hides internal tiles the session does not allow and locked external tiles; other external tiles stay', async () => {
  const p = page('hub', async () => session(200, {username: 'synthetic.user', entitlement: 'free', apps: ['chat'], locked: ['paid-ext']}), [
    {id: 'chat', title: 'Chat', status: 'ready', href: 'apps/chat.html'},
    {id: 'downloads', title: 'Downloads', status: 'ready', href: 'apps/downloads.html'},
    {id: 'ext', title: 'Ext', status: 'ready', href: 'https://example.invalid/'},
    {id: 'paid-ext', title: 'Paid ext', status: 'ready', href: 'https://paid.example.invalid/'},
  ]);
  await tick();
  const hidden = Object.fromEntries(p.get('grid').children.map(li => [li.children[0].dataset.id, li.hidden]));
  assert.deepEqual(hidden, {chat: false, downloads: true, ext: false, 'paid-ext': true});
});

test('hub shows a locked-for-free external tile to a paid session', async () => {
  const p = page('hub', async () => session(200, {username: 'synthetic.user', entitlement: 'paid', apps: ['chat', 'paid-ext'], locked: []}), [
    {id: 'chat', title: 'Chat', status: 'ready', href: 'apps/chat.html'},
    {id: 'paid-ext', title: 'Paid ext', status: 'ready', href: 'https://paid.example.invalid/'},
  ]);
  await tick();
  const hidden = Object.fromEntries(p.get('grid').children.map(li => [li.children[0].dataset.id, li.hidden]));
  assert.deepEqual(hidden, {chat: false, 'paid-ext': false});
});

test('shared header works without catalog nodes and filters navigation from existing session apps', async () => {
  const p = page('hub', async () => session(200,{username:'synthetic.user',apps:['board','downloads'],locked:[]}), [], {headerOnly:true});
  await tick();
  assert.equal(p.get('account-name').textContent,'synthetic.user');
  assert.equal(p.get('nav-board').hidden,false);
  assert.equal(p.get('nav-chat').hidden,true);
  assert.equal(p.get('nav-downloads').hidden,false);
});

test('shared logout synchronously notifies consumers before POST and late header response stays hidden', async () => {
  const wait=deferred(); const logout=deferred(); const sequence=[];
  const p=page('hub',url=>{
    if(url==='/hub/api/session') return wait.promise;
    sequence.push('post'); assert.deepEqual(sequence,['clear','post']); return logout.promise;
  },[],{headerOnly:true});
  p.window.addEventListener('hub:session-ended',event=>{ assert.equal(event.detail,undefined); sequence.push('clear'); });
  const finishing=p.get('logout').fire('click');
  assert.deepEqual(sequence,['clear','post']);
  assert.equal(p.get('account').hidden,true);
  wait.resolve(session()); await tick();
  assert.equal(p.get('account').hidden,true);
  assert.equal(p.get('account-name').textContent,'');
  logout.resolve(session()); await finishing;
  assert.deepEqual(p.redirects,['/hub/login/']);
});

test('chat shared-header logout clears key and drafts and blocks a pending send without redirecting early', async () => {
  let wait=null;
  const p=page('chat',()=>wait ? wait.promise : Promise.resolve(session())); await tick();
  p.get('key').value='synthetic-key'; await p.get('saveKey').fire('click');
  assert.equal(p.get('forgetKey').disabled,false);
  wait=deferred(); const send=p.get('send').fire('click');
  p.window.dispatchEvent(new Event('hub:session-ended'));
  assert.equal(p.get('forgetKey').disabled,true);
  assert.equal(p.get('input').value,'');
  assert.equal(p.get('system').value,'');
  assert.equal(p.get('send').disabled,true);
  assert.equal(p.get('input').disabled,true);
  assert.equal(p.stored['hub.chat.history'],undefined);
  assert.deepEqual(p.redirects,[]);
  wait.resolve(session()); await send;
  assert.ok(p.calls.every(call=>call.url==='/hub/api/session'));
});
