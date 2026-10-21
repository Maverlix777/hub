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
  removeAttribute(name) { delete this.attrs[name]; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  querySelector(name) { return this.children.find(x => x.className === name.replace('.', '')); }
  scrollIntoView() {}
  focus() { this.focused = true; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const session = (status = 200, body = {username: 'synthetic.user', entitlement: 'free'}) => ({status, ok: status >= 200 && status < 300, json: async () => body});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
function page(kind, fetcher, options = {}) {
  const elements = {};
  const get = id => elements[id] ||= new Element(id);
  const document = new Element('document');
  document.getElementById = get;
  document.createElement = () => new Element('created');
  document.hidden = false;
  const window = new Element('window');
  const redirects = [];
  window.location = {replace: url => redirects.push(url)};
  get('apps').textContent = '[]';
  get('model').value = 'test-model';
  get('logout').hidden = true;
  get('session-status').hidden = true;
  get('input').value = 'Unsent draft';
  const stored = {
    'hub.chat.key': 'synthetic-old-key',
    'hub.chat.history': JSON.stringify([{role: 'user', content: 'old question'}, {role: 'assistant', content: 'old answer'}]),
    'hub.chat.system': 'synthetic system',
  };
  if (options.local) { for (const key of Object.keys(stored)) delete stored[key]; Object.assign(stored, options.local); }
  Object.defineProperties(stored, {
    getItem: {value: k => stored[k] ?? null}, setItem: {writable: true, value: (k, v) => { stored[k] = v; }}, removeItem: {value: k => { delete stored[k]; }},
  });
  const tab = options.tab || {};
  if (!tab.getItem) Object.defineProperties(tab, {
    getItem: {value: k => tab[k] ?? null}, setItem: {value: (k,v) => { tab[k] = v; }}, removeItem: {value: k => { delete tab[k]; }},
  });
  if (options.quota) stored.setItem = () => { throw new Error('QuotaExceededError'); };
  const calls = [];
  const context = {window, document, localStorage: stored, sessionStorage: tab, AbortController, TextDecoder, Date, console,
    fetch: async (url, options) => { calls.push({url, options}); return fetcher(url, options); }};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, kind === 'hub' ? 'public/hub.js' : 'public/apps/chat.js'), 'utf8'), context);
  return {get, window, document, redirects, stored, tab, calls};
}

test('tab key survives Chat to Hub to Chat without ever entering localStorage', async () => {
  const tab = {};
  const first = page('chat', async () => session(), {tab, local:{}}); await tick();
  first.get('key').value = 'synthetic-tab-key'; await first.get('saveKey').fire('click');
  assert.equal(tab['hub.chat.key'], 'synthetic-tab-key');
  assert.equal(first.stored['hub.chat.key'], undefined);
  assert.match(first.get('keyState').textContent, /вкладк/i);
  const hub = page('hub', async () => session(), {tab,local:{}}); await tick();
  assert.equal(tab['hub.chat.key'], 'synthetic-tab-key');
  const second = page('chat', async () => session(), {tab,local:{}}); await tick();
  assert.equal(second.get('forgetKey').disabled, false);
  await second.get('forgetKey').fire('click');
  assert.equal(tab['hub.chat.key'], undefined);
  assert.equal(hub.stored['hub.chat.key'], undefined);
});

for (const kind of ['hub','chat']) {
  for (const status of [401,403]) {
    test(`${kind} ${status} clears tab key but outage does not`, async () => {
      const tab = {'hub.chat.key':'synthetic-tab-key'};
      let code = 503;
      const p = page(kind, async () => session(code), {tab}); await tick();
      assert.equal(tab['hub.chat.key'], 'synthetic-tab-key');
      code = status; await p.window.fire('focus'); await tick();
      assert.equal(tab['hub.chat.key'], undefined);
      assert.deepEqual(p.redirects, ['/hub/login/']);
    });
  }
  test(`${kind} cross-tab logout clears tab key`, async () => {
    const tab = {'hub.chat.key':'synthetic-tab-key'};
    const p = page(kind, async () => session(), {tab}); await tick();
    await p.window.fire('storage',{key:'hub.session.logout'});
    assert.equal(tab['hub.chat.key'], undefined);
  });
}

test('Anthropic401 explains key replacement, preserves draft and Hub session, forgets invalid key', async () => {
  const p = page('chat', async url => url === '/hub/api/session' ? session() :
    {ok:false,status:401,text:async()=> 'invalid x-api-key synthetic-tab-key'}, {local:{},tab:{'hub.chat.key':'synthetic-tab-key'}});
  await tick(); await p.get('send').fire('click');
  const message = p.get('log').children.find(el => el.className === 'msg error').querySelector('.body').textContent;
  assert.match(message, /401/); assert.match(message, /Anthropic/); assert.match(message, /ключ/i);
  assert.ok(!message.includes('synthetic-tab-key'));
  assert.equal(p.tab['hub.chat.key'], undefined);
  assert.equal(p.get('forgetKey').disabled,true);
  assert.equal(p.get('input').value,'Unsent draft');
  assert.deepEqual(p.redirects,[]);
});

test('oversized persisted history is bounded with visible feedback', async () => {
  const old = Array.from({length:120},(_,i)=>({role:i%2?'assistant':'user',content:String(i)+':'+ 'x'.repeat(10000)}));
  const p = page('chat',async()=>session(),{local:{'hub.chat.history':JSON.stringify(old)}}); await tick();
  const saved = JSON.parse(p.stored['hub.chat.history']);
  assert.ok(saved.length<=100);
  assert.ok(saved.every(m=>m.content.length<=8000));
  assert.match(p.get('storage-status').textContent,/истор|сокращ/i);
  assert.equal(p.get('storage-status').hidden,false);
});

test('quota error reports feedback without erasing current draft or in-memory reply', async () => {
  const tab = {'hub.chat.key':'synthetic-tab-key'};
  const p = page('chat',async url=>url==='/hub/api/session'?session():{ok:false,status:500,text:async()=> 'synthetic error'}, {tab,quota:true});
  await tick(); await p.get('send').fire('click');
  assert.equal(p.get('input').value,'Unsent draft');
  assert.match(p.get('storage-status').textContent,/сохран|хранилищ/i);
  assert.equal(p.get('storage-status').hidden,false);
  assert.equal(tab['hub.chat.key'],'synthetic-tab-key');
});

test('sessionStorage denial falls back to memory with honest key explanation', async () => {
  const tab = {getItem(){throw new Error('denied');},setItem(){throw new Error('denied');},removeItem(){}};
  const p=page('chat',async()=>session(),{tab});await tick();
  p.get('key').value='synthetic-memory-key';await p.get('saveKey').fire('click');
  assert.equal(p.get('forgetKey').disabled,false);
  assert.match(p.get('keyState').textContent,/памят|недоступ/i);
  assert.equal(p.stored['hub.chat.key'],'synthetic-old-key');
});

test('only newest message announces, composer has explicit accessible label', async () => {
  const p=page('chat',async url=>url==='/hub/api/session'?session():{ok:false,status:500,text:async()=> 'synthetic error'});await tick();
  p.get('key').value='synthetic';await p.get('saveKey').fire('click');await p.get('send').fire('click');
  const announcing=p.get('log').children.filter(el=>el.attrs['aria-live']==='polite');
  assert.equal(announcing.length,1);
  assert.equal(announcing[0],p.get('log').children.at(-1));
  const html=fs.readFileSync(path.join(ROOT,'public/apps/chat.html'),'utf8');
  assert.match(html,/id="input"[^>]*aria-label="[^"]+"/);
  assert.ok(!/<ol[^>]*id="log"[^>]*aria-live="polite"/.test(html));
});


test('oversized pending user draft is bounded before history restoration', async () => {
  const old = [{role:'user',content:'x'.repeat(20000)}];
  const p=page('chat',async()=>session(),{local:{'hub.chat.history':JSON.stringify(old)}});await tick();
  const saved=JSON.parse(p.stored['hub.chat.history']);
  assert.equal(saved[0].content.length,8000);
  assert.equal(p.get('storage-status').hidden,false);
});


test('delayed Anthropic401 for key A does not forget a newly saved key B', async () => {
  const wait=deferred();
  const p=page('chat',async url=>url==='/hub/api/session'?session():wait.promise,{tab:{'hub.chat.key':'synthetic-key-A'},local:{}});await tick();
  const sending=p.get('send').fire('click');await tick();
  p.get('key').value='synthetic-key-B';await p.get('saveKey').fire('click');
  wait.resolve({ok:false,status:401,text:async()=> 'synthetic unauthorized'});await sending;
  assert.equal(p.tab['hub.chat.key'],'synthetic-key-B');
  assert.equal(p.get('forgetKey').disabled,false);
  assert.deepEqual(p.redirects,[]);
});

test('Anthropic401 has helpful guidance even if its response body cannot be read', async () => {
  const p=page('chat',async url=>url==='/hub/api/session'?session():{ok:false,status:401,text:async()=>{throw new Error('body unavailable');}},{tab:{'hub.chat.key':'synthetic-key-A'},local:{}});await tick();
  await p.get('send').fire('click');
  const text=p.get('log').children.find(el=>el.className==='msg error').querySelector('.body').textContent;
  assert.match(text,/HTTP 401/);assert.match(text,/Anthropic/);assert.match(text,/ключ/);
  assert.equal(p.tab['hub.chat.key'],undefined);assert.equal(p.get('input').value,'Unsent draft');
});
