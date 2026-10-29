'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const NAMES = { claude: 'Claude', codex: 'Codex', snezhana: 'Снежана', pedro: 'Педро' };
  const root = document.querySelector('.msgr');
  let current = null;
  let timer = null;
  let lastSig = '';

  function status(text) { $('status').textContent = text || ''; }
  async function call(path, options) {
    const response = await fetch(`/hub/api/${path}`, { credentials: 'same-origin', cache: 'no-store', ...options });
    if (response.status === 401) { location.assign('/hub/login/'); throw new Error('unauthorized'); }
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }
  const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Request': '1' }, body: JSON.stringify(body) });

  async function loadThreads() {
    try {
      const { threads } = await call('chat/threads');
      const list = $('threads');
      list.textContent = '';
      for (const t of threads) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${NAMES[t.addressee] || t.addressee} · ${t.mode === 'chat' ? 'чат' : 'задача'} #${t.issue}`;
        const small = document.createElement('small');
        small.textContent = t.preview;
        b.append(small);
        b.addEventListener('click', () => openThread(t.issue));
        li.append(b);
        list.append(li);
      }
      if (!threads.length) { const li = document.createElement('li'); li.textContent = 'Пока пусто'; list.append(li); }
    } catch { status('Не удалось загрузить треды'); }
  }

  async function loadThread() {
    if (!current) return;
    try {
      const t = await call(`chat/thread?issue=${current}`);
      const sig = t.messages.map((m) => m.id).join(',') + t.state;
      if (sig === lastSig) return;
      lastSig = sig;
      $('thread-title').textContent = `${NAMES[t.addressee] || t.addressee} · ${t.mode === 'chat' ? 'чат' : 'задача'} #${t.issue}`;
      const feed = $('feed');
      const stick = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 40;
      feed.textContent = '';
      for (const m of t.messages) {
        const d = document.createElement('div');
        d.className = m.mine ? 'msg mine' : 'msg';
        const who = document.createElement('small');
        who.textContent = `${m.author} · ${new Date(m.at).toLocaleString('ru-RU')}`;
        const body = document.createElement('span');
        body.textContent = m.text;
        d.append(who, body);
        feed.append(d);
      }
      if (stick) feed.scrollTop = feed.scrollHeight;
      $('reply').hidden = false;
      status('');
    } catch { status('Не удалось загрузить тред'); }
  }

  function openThread(issue) {
    current = issue; lastSig = '';
    root.classList.add('open');
    clearInterval(timer);
    loadThread();
    timer = setInterval(() => { if (!document.hidden) loadThread(); }, 5000);
  }

  $('back').addEventListener('click', () => { root.classList.remove('open'); clearInterval(timer); current = null; });

  $('new').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('new-text').value.trim();
    if (!text) return;
    $('new-send').disabled = true;
    try {
      await post('outbox', { idempotencyKey: crypto.randomUUID(), kind: 'message', text, target: null, addressee: $('to').value, mode: $('mode').value });
      $('new-text').value = '';
      status('Отправлено. Тред появится после доставки в GitHub.');
      setTimeout(loadThreads, 4000);
    } catch { status('Не отправилось'); }
    $('new-send').disabled = false;
  });

  $('reply').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('reply-text').value.trim();
    if (!text || !current) return;
    $('reply-send').disabled = true;
    try {
      await post('chat/reply', { issue: current, text });
      $('reply-text').value = '';
      lastSig = '';
      await loadThread();
    } catch { status('Ответ не отправился'); }
    $('reply-send').disabled = false;
  });

  loadThreads();
  setInterval(() => { if (!document.hidden) loadThreads(); }, 30000);
})();
