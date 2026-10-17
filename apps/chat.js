'use strict';
(function () {
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MAX_TOKENS = 8192;
  const K = { key: 'hub.chat.key', model: 'hub.chat.model', system: 'hub.chat.system', history: 'hub.chat.history' };
  const $ = (id) => document.getElementById(id);
  const els = {
    key: $('key'), saveKey: $('saveKey'), forgetKey: $('forgetKey'), keyState: $('keyState'),
    model: $('model'), system: $('system'), log: $('log'), input: $('input'),
    send: $('send'), stop: $('stop'), clear: $('clear'), settings: $('settings'),
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* приватный режим */ } },
  };

  let history = [];
  try { history = JSON.parse(store.get(K.history) || '[]'); } catch { history = []; }
  if (!Array.isArray(history)) history = [];
  let controller = null;

  // --- ключ: только localStorage, поле после сохранения очищается ---
  function renderKeyState() {
    const has = !!store.get(K.key);
    els.keyState.textContent = has ? 'Ключ сохранён в этом браузере.' : 'Ключ не задан.';
    els.forgetKey.disabled = !has;
    if (!has) els.settings.open = true;
  }
  els.saveKey.addEventListener('click', () => {
    const v = els.key.value.trim();
    if (!v) return;
    store.set(K.key, v);
    els.key.value = '';
    renderKeyState();
  });
  els.forgetKey.addEventListener('click', () => {
    store.del(K.key);
    els.key.value = '';
    renderKeyState();
  });

  // --- модель и системный промпт ---
  const savedModel = store.get(K.model);
  if (savedModel && [...els.model.options].some((o) => o.value === savedModel)) els.model.value = savedModel;
  els.model.addEventListener('change', () => store.set(K.model, els.model.value));
  els.system.value = store.get(K.system) || '';
  els.system.addEventListener('input', () => store.set(K.system, els.system.value));

  // --- отрисовка: только textContent, разметку ответа не интерпретируем ---
  function addMsg(role, text) {
    const li = document.createElement('li');
    li.className = 'msg ' + role;
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = text;
    li.append(body);
    els.log.append(li);
    li.scrollIntoView({ block: 'end' });
    return li;
  }
  function addNote(li, text) {
    const n = document.createElement('span');
    n.className = 'note';
    n.textContent = text;
    li.append(n);
  }
  function redact(text, key) {
    return key ? String(text).split(key).join('[ключ скрыт]') : String(text);
  }
  function saveHistory() { store.set(K.history, JSON.stringify(history)); }
  for (const m of history) addMsg(m.role, m.content);

  els.clear.addEventListener('click', () => {
    if (controller) controller.abort();
    history = [];
    store.del(K.history);
    els.log.textContent = '';
  });

  function setBusy(busy) {
    els.send.hidden = busy;
    els.stop.hidden = !busy;
    els.input.disabled = busy;
  }
  els.stop.addEventListener('click', () => { if (controller) controller.abort(); });

  // --- SSE: события разделены пустой строкой, поля event:/data: ---
  async function* readSSE(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m;
      while ((m = buf.match(/\r?\n\r?\n/))) {
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        let event = 'message';
        const data = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  }

  async function send() {
    const text = els.input.value.trim();
    if (!text || controller) return;
    const key = store.get(K.key);
    if (!key) { renderKeyState(); els.key.focus(); return; }

    history.push({ role: 'user', content: text });
    saveHistory();
    const userLi = addMsg('user', text);
    els.input.value = '';

    const li = addMsg('assistant', '');
    const body = li.querySelector('.body');
    let answer = '';
    let failed = false;
    controller = new AbortController();
    setBusy(true);

    const payload = {
      model: els.model.value,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    };
    const sys = els.system.value.trim();
    if (sys) payload.system = sys;

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) {
        const errText = await res.text();
        failed = true;
        li.className = 'msg error';
        body.textContent = redact(`HTTP ${res.status}\n${errText}`, key);
      } else {
        for await (const ev of readSSE(res.body)) {
          if (ev.event === 'error') {
            failed = true;
            li.className = 'msg error';
            body.textContent = redact(answer ? `${answer}\n\nerror\n${ev.data}` : `error\n${ev.data}`, key);
            break;
          }
          if (ev.event !== 'content_block_delta') continue;
          let d;
          try { d = JSON.parse(ev.data); } catch { continue; }
          if (d.delta && d.delta.type === 'text_delta') {
            answer += d.delta.text;
            body.textContent = answer;
          }
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        addNote(li, 'остановлено');
      } else {
        failed = true;
        li.className = 'msg error';
        body.textContent = redact(`${e && e.name}: ${e && e.message}`, key);
      }
    } finally {
      controller = null;
      setBusy(false);
    }

    if (answer) {
      history.push({ role: 'assistant', content: answer });
    } else {
      // ответа нет: вопрос возвращаем в поле, чтобы история не ломала чередование ролей
      history.pop();
      if (!failed) { li.remove(); userLi.remove(); }
      els.input.value = text;
    }
    saveHistory();
    els.input.focus();
  }

  els.send.addEventListener('click', send);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });

  renderKeyState();
})();
