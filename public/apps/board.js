'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const columns = [['planned', 'Запланировано'], ['progress', 'В работе'], ['review', 'На проверке'], ['done', 'Готово']];
  const dialog = $('task-dialog');
  const drafts = new Map();
  let cards = []; let sources = []; let items = []; let loading = false; let openKey = null;
  let focusBefore = null; let lastRead = null; let outboxAvailable = false; let nextCursor = null;
  let authGeneration = 0; let authInvalid = false;
  const receiptChecks = new Map();
  const cardKey = (card) => card.key || `${card.sourcePath || card.source}::${card.id}`;
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function safeLink(url, label) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
      const link = el('a', 'source-link', label || parsed.href);
      link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      return link;
    } catch { return null; }
  }
  function date(value) {
    const parsed = new Date(value);
    return value && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('ru-RU') : 'Нет данных';
  }
  function cardButton(card) {
    const button = el('button', 'card'); button.type = 'button'; button.dataset.cardKey = cardKey(card);
    button.append(el('span', 'id', `${card.id} · ${card.source || 'Источник не указан'}`), el('span', 'card-title', card.title || 'Без названия'));
    button.append(el('span', 'meta', [card.owner || card.who || 'Исполнитель не указан', card.state].filter(Boolean).join(' · ')));
    button.addEventListener('click', () => openCard(card, true));
    const li = el('li'); li.append(button); return li;
  }
  function fillList(node, list, empty) {
    node.replaceChildren(...list.map(cardButton));
    if (!list.length) node.append(el('li', 'empty', empty));
  }
  function render() {
    const query = $('q').value.trim().toLowerCase();
    const shown = cards.filter((card) => !query || `${card.id} ${card.title} ${card.owner || card.who} ${card.state} ${card.description || ''}`.toLowerCase().includes(query));
    $('columns').replaceChildren();
    for (const [key, label] of columns) {
      const rows = shown.filter((card) => card.column === key);
      const section = el('section', `col ${key}`); const heading = el('h3', '', label);
      heading.append(el('span', 'count', rows.length)); section.append(heading);
      const ul = el('ul'); fillList(ul, key === 'done' ? rows.slice().reverse() : rows, query ? 'Нет совпадений' : 'Пока нет задач');
      section.append(ul); $('columns').append(section);
    }
    const questions = shown.filter((card) => card.column === 'questions');
    $('question-count').textContent = String(questions.length);
    fillList($('question-list'), questions, query ? 'Нет совпадений' : 'Открытых вопросов в загруженных источниках нет');
    const ideas = shown.filter((card) => card.column === 'ideas');
    $('idea-count').textContent = String(ideas.length);
    const incomplete = sources.some((source) => ['error', 'unsupported'].includes(source.status));
    fillList($('idea-list'), ideas, query ? 'Нет совпадений' : incomplete ? 'Идеи не прочитаны полностью. Проверь состояния источников ниже.' : sources.length ? 'В прочитанных источниках идей нет' : 'Источники идей не подтверждены');
    renderSources();
  }
  function renderSources() {
    const details = el('details'); details.append(el('summary', '', `Источники: ${sources.length}`));
    const labels = { available:'прочитан', empty:'пустой', error:'ошибка загрузки', unsupported:'формат не распознан', loading:'загружается' };
    for (const source of sources) {
      const row = el('p', ['error','unsupported'].includes(source.status) ? 'error' : '');
      const name = source.path || source.name || 'Источник';
      row.append(safeLink(source.url, name) || el('span', '', name));
      row.append(document.createTextNode(` — ${labels[source.status] || 'состояние неизвестно'}${Number.isFinite(source.cardCount) ? `, карточек: ${source.cardCount}` : ''}`));
      if (source.unmappedCount) row.append(document.createTextNode(`; не распознано строк: ${source.unmappedCount}`));
      details.append(row);
    }
    if (sources.some((source) => ['error','unsupported'].includes(source.status))) details.open = true;
    $('sources').replaceChildren(details);
  }
  function detailList(title, rows, empty) {
    const section = el('section', 'detail-section'); section.append(el('h3', '', title));
    const ul = el('ul', 'detail-list');
    for (const entry of rows || []) {
      const li = el('li');
      if (typeof entry === 'string') li.textContent = entry;
      else if (entry && typeof entry === 'object') li.append(safeLink(entry.url, entry.label || entry.url) || el('span', '', entry.text || entry.label || 'Ссылка недоступна'));
      ul.append(li);
    }
    if (!ul.children.length) ul.append(el('li', 'hint', empty));
    section.append(ul); return section;
  }
  function metric(list, label, value) { list.append(el('dt', '', label), el('dd', '', value || 'Не указано')); }
  function openCard(card, push) {
    if (authInvalid) return;
    const key = cardKey(card); focusBefore = document.activeElement; openKey = key;
    if (push) history.pushState({ ...history.state, hubTask:key }, '', '#task');
    $('detail-id').textContent = `${card.id} · ${card.source || 'Задача'}`;
    const content = $('detail-content'); content.replaceChildren();
    const title = el('h2', '', card.title || 'Без названия'); title.id = 'detail-title'; content.append(title);
    const metadata = el('dl', 'metric-list');
    metric(metadata, 'Исполнитель', card.owner || card.who); metric(metadata, 'Статус', card.state);
    metric(metadata, 'Источник', card.sourcePath || card.source); metric(metadata, 'Версия источника', card.sourceRevision);
    content.append(metadata);
    const source = safeLink(card.sourceUrl, 'Открыть исходный документ ↗'); if (source) content.append(source);
    const description = el('section', 'detail-section'); description.append(el('h3', '', 'Контекст'), el('p', 'detail-description', card.description || card.title || 'Описание не указано в источнике.')); content.append(description);
    content.append(detailList('Блокеры', card.blockers, 'Блокеры не указаны в источнике.'), detailList('История', card.history, 'История не опубликована в источнике.'), detailList('Подтверждения и ссылки', card.evidence, 'Подтверждений в источнике пока нет.'));
    if (card.column === 'questions') {
      const answer = el('section', 'detail-section answer-section'); answer.append(el('h3', '', 'Твой ответ'), el('p', 'hint', 'Сохраним ответ к этой задаче и этой версии источника.'));
      const form = el('form'); form.id = 'answer-form';
      const label = el('label', '', 'Решение или уточнение'); label.htmlFor = 'answer-text';
      const textarea = el('textarea'); textarea.id = 'answer-text'; textarea.name = 'text'; textarea.rows = 4; textarea.maxLength = 8000; textarea.required = true;
      const submit = el('button', 'primary', 'Сохранить ответ'); submit.type = 'submit';
      const status = el('p', 'form-status'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
      form.append(label,textarea,submit,status); answer.append(form); content.append(answer);
      const target = {sourcePath:card.sourcePath,taskId:card.id,revision:card.sourceRevision};
      setupForm(form, 'answer', target, key);
      if (!target.sourcePath || !/^[a-f0-9]{40,64}$/i.test(target.revision || '')) { submit.disabled = true; status.textContent = 'Источник или его версия не подтверждены. Обнови доску перед ответом.'; }
      const previous = items.filter((item) => item.target?.taskId === card.id && item.target?.sourcePath === card.sourcePath);
      if (previous.length) answer.append(el('p','hint',`Сохранённых ответов: ${previous.length}. Статус и квитанции — в очереди ниже.`));
    }
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('modal-open'); $('close-detail').focus();
    dialog.scrollTop = 0; content.scrollTop = 0;
  }
  function closeCard(navigate) {
    if (!dialog.open) return;
    if (navigate && history.state?.hubTask) { history.back(); return; }
    dialog.close(); document.body.classList.remove('modal-open');
    const previousKey = openKey; openKey = null;
    const target = focusBefore?.isConnected ? focusBefore : [...document.querySelectorAll('[data-card-key]')].find((node) => node.dataset.cardKey === previousKey);
    if (target) target.focus();
  }
  function restoreHistory() {
    const key = history.state?.hubTask;
    if (!key) { closeCard(false); return; }
    const card = cards.find((entry) => cardKey(entry) === key);
    if (card && openKey !== key) openCard(card, false);
  }
  function requireActiveSession(generation = authGeneration) {
    if (authInvalid || generation !== authGeneration) { const error = new Error('auth_invalidated'); error.code = 'auth_invalidated'; throw error; }
  }
  function invalidateSession() {
    if (authInvalid) return;
    authInvalid = true; authGeneration += 1;
    cards = []; sources = []; items = []; drafts.clear(); receiptChecks.clear(); nextCursor = null; lastRead = null; outboxAvailable = false;
    closeCard(false); render(); renderOutbox();
    $('detail-content').replaceChildren(); $('detail-id').textContent = '';
    $('telemetry').replaceChildren(el('h2','','Снежанна'),el('p','hint','Доступ завершён. Данные скрыты.'));
    $('q').value = ''; $('q').disabled = true;
    $('message-text').value = ''; $('message-text').disabled = true;
    $('message-form').querySelector('button').disabled = true;
    $('message-form').querySelector('.form-status').textContent = '';
    $('refresh').disabled = true;
    $('status').textContent = 'Доступ завершён. Войди снова, чтобы открыть личную доску.';
    $('delivery-status').textContent = 'Очередь скрыта: требуется разрешённая учётная запись.';
  }
  async function api(path, options) {
    const generation = authGeneration; requireActiveSession(generation);
    const response = await fetch(`/hub/api/${path}`, { credentials:'same-origin', cache:'no-store', ...options });
    if (response.status === 401 || response.status === 403) {
      invalidateSession();
      if (response.status === 401) window.location.replace('/hub/login/');
      requireActiveSession(generation);
    }
    requireActiveSession(generation);
    const data = await response.json().catch(() => ({}));
    requireActiveSession(generation);
    if (!response.ok) { const error = new Error(data.error || `http_${response.status}`); error.code = data.error; throw error; }
    return data;
  }
  const errors = {
    target_conflict:'Источник изменился. Ответ не отправлен. Скопируй текст, обнови доску и проверь новый контекст перед повтором.',
    idempotency_conflict:'Этот идентификатор уже связан с другим сообщением. Не отправляй повтор: проверь очередь.',
    invalid_target:'Задача не найдена в текущем источнике. Обнови доску и проверь контекст.',
    invalid_payload:'Проверь текст и данные задачи. Сообщение не принято.',
    outbox_unavailable:'Очередь сейчас недоступна. Текст сохранён в этой вкладке; попробуй ещё раз.',
    board_unavailable:'Источник задачи недоступен. Ответ не отправлен; попробуй позже.',
    rate_limited:'Слишком много запросов. Подожди минуту и повтори.',
  };
  function setupForm(form, kind, target, key) {
    const textarea = form.querySelector('textarea'); const submit = form.querySelector('button[type="submit"]'); const status = form.querySelector('.form-status');
    let draft = drafts.get(key);
    if (!draft) { draft = {text:'',payload:null,busy:false,targetRevision:target?.revision}; drafts.set(key,draft); }
    // Only a newly reviewed source revision clears a definitive target conflict.
    // An uncertain network result must retain its original immutable payload/key.
    if (!draft.payload && target?.revision !== draft.targetRevision) { draft.blocked = false; draft.targetRevision = target?.revision; }
    textarea.value = draft.text;
    textarea.readOnly = Boolean(draft.payload); submit.disabled = draft.busy || Boolean(draft.blocked);
    if (draft.payload) { submit.textContent = 'Повторить сохранение'; status.textContent = 'Предыдущая отправка не подтверждена. Повтор использует тот же идентификатор и текст.'; }
    textarea.addEventListener('input', () => { draft.text = textarea.value; });
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (draft.busy || authInvalid) return;
      if (!textarea.value.trim()) { textarea.setCustomValidity('Введи текст сообщения.'); textarea.reportValidity(); return; }
      textarea.setCustomValidity('');
      if (!draft.payload) draft.payload = {idempotencyKey:crypto.randomUUID(),kind,text:textarea.value.trim(),...(target ? {target} : {})};
      draft.busy = true; submit.disabled = true; textarea.readOnly = true;
      status.className = 'form-status'; status.textContent = 'Сохраняем…';
      try {
        const result = await api('outbox', {method:'POST',headers:{'Content-Type':'application/json','X-Hub-Request':'1'},body:JSON.stringify(draft.payload)});
        requireActiveSession();
        if (!result.item?.id) throw new Error('invalid_receipt');
        items = [result.item,...items.filter((item) => item.id !== result.item.id)]; renderOutbox();
        status.className = 'form-status success'; status.textContent = result.item.status === 'synced' && issueReceipt(result.item.receipt) ? 'Сохранено и доставлено в GitHub Issues. Ответ исполнителя и результат проверяются отдельно.' : 'Сохранено в очереди. Доставка в GitHub Issues ещё не подтверждена.';
        draft.text = ''; draft.payload = null; textarea.value = ''; textarea.readOnly = false; submit.textContent = kind === 'answer' ? 'Сохранить ответ' : 'Сохранить сообщение';
        if (result.item.status === 'pending') checkReceipt(result.item.id);
      } catch (error) {
        if (authInvalid) return;
        status.className = 'form-status error'; status.textContent = errors[error.code] || 'Сохранение не подтверждено. Текст остаётся в этой вкладке. Повтори запрос с тем же идентификатором.';
        submit.textContent = 'Повторить сохранение';
        if (['invalid_payload','invalid_target','target_conflict'].includes(error.code)) {
          draft.payload = null; textarea.readOnly = false;
          if (error.code !== 'invalid_payload') { draft.blocked = true; }
        }
      } finally { draft.busy = false; submit.disabled = authInvalid || Boolean(draft.blocked); }
    });
    textarea.addEventListener('input', () => textarea.setCustomValidity(''));
  }
  function issueReceipt(receipt) {
    if (!receipt || !['issue','comment'].includes(receipt.kind) || !Number.isSafeInteger(receipt.issueNumber) || receipt.issueNumber < 1) return null;
    try {
      const url = new URL(receipt.url);
      if (url.origin !== 'https://github.com' || url.username || url.password || url.search
        || url.pathname !== `/Maverlix777/agent-handoffs/issues/${receipt.issueNumber}`) return null;
      if (receipt.kind === 'issue' ? (url.hash || receipt.commentId !== null)
        : (!Number.isSafeInteger(receipt.commentId) || receipt.commentId < 1 || url.hash !== `#issuecomment-${receipt.commentId}`)) return null;
      return safeLink(url.href,receipt.kind === 'comment' ? `GitHub · комментарий к #${receipt.issueNumber} ↗` : `GitHub · issue #${receipt.issueNumber} ↗`);
    } catch { return null; }
  }
  async function checkReceipt(id) {
    if (receiptChecks.has(id) || authInvalid || document.hidden) return;
    const generation = authGeneration;
    receiptChecks.set(id,'checking'); renderOutbox();
    // Read-only, foreground-only bounded follow-up; not a server scheduler or
    // executor trigger. The longer existing refresh remains a fallback.
    for (const delay of [1000,2000,5000]) {
      await new Promise(resolve => window.setTimeout(resolve,delay));
      if (authInvalid || generation !== authGeneration || document.hidden) {
        if (!authInvalid) { receiptChecks.set(id,'unconfirmed'); renderOutbox(); }
        return;
      }
      try {
        const data = await api('outbox'); requireActiveSession(generation);
        const fresh = Array.isArray(data.items) ? data.items : [];
        const found = fresh.find(item => item.id === id);
        const byId = new Map(items.map(item => [item.id,item]));
        for (const item of fresh) byId.set(item.id,item);
        items = [...byId.values()]; renderOutbox();
        if (found && (['error','conflict'].includes(found.status) || (found.status === 'synced' && issueReceipt(found.receipt)))) {
          receiptChecks.delete(id); renderOutbox(); return;
        }
      } catch { if (authInvalid) return; }
    }
    receiptChecks.set(id,'unconfirmed'); renderOutbox();
  }
  function renderOutbox() {
    const list = $('outbox-list'); list.replaceChildren();
    for (const item of items) {
      const li = el('li','outbox-entry'); li.dataset.receiptId = item.id;
      li.append(el('strong','',item.kind === 'answer' ? `Ответ · ${item.target?.taskId || 'задача'}` : 'Сообщение'));
      const author = item.author;
      li.append(el('p','author',`Автор: ${author?.hubUsername || 'не сохранён в прежней записи'}${author?.githubLogin ? ` · GitHub @${author.githubLogin}` : ''}`),el('p','message-text',item.text));
      const receipt = issueReceipt(item.receipt);
      const delivered = item.status === 'synced' && Boolean(receipt);
      const stages = el('dl','delivery-stages');
      metric(stages,'SAVED · сохранение','Сохранено на сервере');
      metric(stages,'DELIVERED · GitHub Issues',delivered ? 'Доставка подтверждена' : item.status === 'error' ? 'Ошибка доставки' : item.status === 'conflict' ? 'Конфликт — нужен разбор' : 'Не подтверждено');
      // The authenticated API currently returns null for both fields. A delivery
      // receipt, telemetry claim or unrecognized object cannot stand in for ACK.
      metric(stages,'ACK · ответ исполнителя','Не подтверждён');
      metric(stages,'RESULT · результат','Не подтверждён');
      li.append(stages);
      li.append(el('p','receipt',`${date(item.createdAt)} · Квитанция ${item.id}`));
      if (delivered) li.append(receipt);
      if (!delivered && item.status === 'pending' && receiptChecks.has(item.id)) li.append(el('p','hint',receiptChecks.get(item.id) === 'checking'
        ? 'Проверяем квитанцию доставки… Сообщение уже сохранено.'
        : 'Быстрая доставка пока не подтверждена. Сообщение сохранено; статусы проверятся при обновлении доски.'));
      if (item.error) li.append(el('p','error',`Причина: ${item.error}`));
      if (['error','conflict'].includes(item.status)) li.append(el('p','hint','Запись уже сохранена. Повторная доставка и разбор конфликта — при проверке Снежанной; новое сообщение не создаётся.'));
      list.append(li);
    }
    if (!items.length) list.append(el('li','empty',outboxAvailable ? 'Сохранённых сообщений пока нет' : 'Очередь не прочитана'));
    if (nextCursor) {
      const more = el('button','','Показать более ранние'); more.type = 'button'; more.id = 'outbox-more';
      more.addEventListener('click',async () => {
        more.disabled = true;
        try {
          const data = await api(`outbox?before=${encodeURIComponent(nextCursor)}`);
          requireActiveSession();
          const seen = new Set(items.map((item) => item.id));
          items.push(...(data.items || []).filter((item) => !seen.has(item.id)));
          nextCursor = data.nextCursor || null; renderOutbox();
        } catch { more.disabled = authInvalid; more.textContent = authInvalid ? 'Доступ завершён' : 'Не удалось загрузить. Повторить'; }
      });
      const row = el('li'); row.append(more); list.append(row);
    }
  }
  async function loadOutbox() {
    if (authInvalid) return;
    try {
      const data = await api('outbox'); requireActiveSession(); items = Array.isArray(data.items) ? data.items : []; nextCursor = data.nextCursor || null; outboxAvailable = true;
      $('delivery-status').textContent = data.delivery?.status === 'not_configured' ? 'Сохранение доступно. Канал GitHub Issues ещё не подключён; быстрая доставка пока не подтверждена.' : 'Сохранение, доставка в GitHub Issues, ответ исполнителя и результат — разные этапы. Проверяй квитанцию каждого сообщения.';
      renderOutbox();
    } catch (error) { if (authInvalid) return; outboxAvailable = false; $('delivery-status').textContent = 'Не удалось прочитать очередь. Доставку подтвердить нельзя.'; $('delivery-status').className = 'status error'; if (!items.length) renderOutbox(); }
  }
  function renderTelemetry(data) {
    const root = $('telemetry'); root.replaceChildren(el('h2','','Снежанна'));
    root.append(el('p','hint','Наблюдения источника, не подтверждение выполнения задач.'));
    const available = data?.status === 'available';
    const age = data?.as_of ? Date.now() - Date.parse(data.as_of) : NaN;
    root.append(el('p',available && age >= 0 && age <= 15*60*1000 ? 'success' : 'hint', available && age >= 0 && age <= 15*60*1000 ? 'Снимок свежий' : data?.reason === 'stale' || age > 15*60*1000 ? 'Данные устарели' : 'Свежесть неизвестна'));
    const metrics = el('dl','metric-list'); metric(metrics,'Последний снимок',date(data?.as_of)); metric(metrics,'Последняя проверка Hub',date(data?.last_check_at));
    metric(metrics,'Ожидают ответа',String(cards.filter((card) => card.column === 'questions').length)); root.append(metrics);
    const events = Array.isArray(data?.events) ? data.events : [];
    const activity = el('ul','activity');
    const states = {dispatched:'Передано',ack:'Есть ACK',running:'В работе',result_reported:'Результат заявлен источником',error:'Ошибка',unknown:'Состояние неизвестно'};
    for (const event of events) {
      const li = el('li','',`${event.task_id || 'Задача неизвестна'} · ${states[event.state] || 'Состояние неизвестно'}`);
      li.append(el('span','meta',`${date(event.observed_at)} · Исполнитель: ${event.agent || event.agent_id || 'не указан'}`));
      if (event.producer_claimed_verified) li.append(el('span','meta','Проверка заявлена источником; Хаб её не выполнял.'));
      if (event.turn_id) li.append(el('span','meta',`Сессия: ${event.turn_id}`));
      const evidence = safeLink(event.evidence_url,'Подтверждение ↗'); if (evidence) li.append(evidence);
      activity.append(li);
    }
    if (!events.length) activity.append(el('li','empty','Нет доступных событий. Назначения и ACK не подтверждены.'));
    root.append(activity);
    root.append(el('p','hint','Доска обновляется при открытии и раз в минуту, пока вкладка видна. Это чтение данных, не новый запуск Снежанны.'));
  }
  async function load() {
    if (loading || authInvalid) return; loading = true; $('refresh').disabled = true; $('columns').setAttribute('aria-busy','true');
    $('status').textContent = lastRead ? `Обновляем… Последнее чтение: ${date(lastRead)}` : 'Загружаем доску…';
    try {
      const board = await api('board'); requireActiveSession(); cards = Array.isArray(board.cards) ? board.cards : []; sources = Array.isArray(board.sources) ? board.sources : [];
      lastRead = new Date().toISOString();
      $('status').className = 'status'; $('status').textContent = `Карточек: ${cards.length}. Прочитано: ${date(lastRead)}${board.unmappedCount ? `. Не распознано строк: ${board.unmappedCount}` : ''}`;
      render(); renderTelemetry(board.telemetry); restoreHistory();
    } catch (error) {
      if (authInvalid) return;
      $('status').className = 'status error'; $('status').textContent = `Не удалось обновить доску.${lastRead ? ` Показан старый снимок от ${date(lastRead)}.` : ' Данные не прочитаны.'}`;
      if (!lastRead) { $('question-list').replaceChildren(el('li','error','Вопросы не загружены')); $('idea-list').replaceChildren(el('li','error','Ошибка чтения источников; это не означает отсутствие идей.')); $('columns').replaceChildren(el('p','error','Доска недоступна. Нажми «Обновить», чтобы повторить.')); }
    } finally { loading = false; $('refresh').disabled = authInvalid; $('columns').setAttribute('aria-busy','false'); }
    await loadOutbox();
  }
  $('q').addEventListener('input',render);
  $('refresh').addEventListener('click',load);
  $('close-detail').addEventListener('click',() => closeCard(true));
  dialog.addEventListener('cancel',(event) => { event.preventDefault(); closeCard(true); });
  dialog.addEventListener('keydown',(event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not(:disabled),a[href],textarea:not(:disabled),input:not(:disabled)')].filter((node) => !node.hidden);
    const first = focusable[0]; const last = focusable[focusable.length-1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  window.addEventListener('popstate',restoreHistory);
  window.addEventListener('beforeunload',(event) => { if ([...drafts.values()].some((draft) => draft.text || draft.payload)) { event.preventDefault(); event.returnValue = ''; } });
  setupForm($('message-form'),'message',null,'message');
  window.setInterval(() => { if (!document.hidden) load(); },60000);
  document.addEventListener('visibilitychange',() => { if (!document.hidden) load(); });
  load();
})();
