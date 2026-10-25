'use strict';
(function () {
  const COLUMNS = [
    { key: 'ideas', title: 'Идеи' },
    { key: 'planned', title: 'Запланировано' },
    { key: 'progress', title: 'В работе' },
    { key: 'done', title: 'Готово' },
    { key: 'questions', title: 'Вопросы владельцу' },
  ];
  const DONE_LIMIT = 60;
  const status = document.getElementById('status');
  const root = document.getElementById('columns');
  const search = document.getElementById('q');
  const telemetryRoot = document.getElementById('telemetry');
  let cards = [];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const shown = query
      ? cards.filter((c) => `${c.id} ${c.title} ${c.who} ${c.state} ${c.ref}`.toLowerCase().includes(query))
      : cards;
    root.replaceChildren();
    for (const column of COLUMNS) {
      const all = shown.filter((c) => c.column === column.key);
      // Done is the long tail: newest (last rows) first, capped unless searching.
      const list = column.key === 'done' ? all.slice().reverse().slice(0, query ? all.length : DONE_LIMIT) : all;
      const section = el('section', `col ${column.key}`);
      const heading = el('h2', '', column.title);
      heading.append(el('span', 'count', String(all.length)));
      section.append(heading);
      const ul = el('ul');
      for (const card of list) {
        const li = el('li', 'card');
        li.append(el('span', 'id', `${card.id} · ${card.source}`), el('span', '', card.title));
        const meta = [card.who, card.state, card.ref].filter(Boolean).join(' · ');
        if (meta) li.append(el('span', 'meta', meta));
        ul.append(li);
      }
      if (!list.length) ul.append(el('li', 'empty', 'Пусто'));
      section.append(ul);
      root.append(section);
    }
  }

  function renderTelemetry(data) {
    if (!telemetryRoot) return;
    telemetryRoot.replaceChildren(el('h2', '', 'Снежанна · локальная активность'));
    telemetryRoot.append(el('p', 'hint', 'Отчёт локального источника — не подтверждение выполнения задачи. Ручная доска выше не изменяется.'));
    if (data?.status !== 'available') {
      telemetryRoot.append(el('p', 'hint', 'unknown · актуальные измерения недоступны'));
      return;
    }
    telemetryRoot.append(el('p', 'hint', `Снимок: ${data.as_of || 'unknown'}`));
    const list = el('ul', 'activity');
    for (const event of data.events || []) {
      list.append(el('li', 'card', `${event.task_id || 'unknown'} · ${event.state || 'unknown'} · ${event.observed_at || 'unknown'}${event.producer_claimed_verified ? ' · проверка заявлена источником' : ''}`));
    }
    if (!(data.events || []).length) list.append(el('li', 'empty', 'Нет событий в снимке'));
    telemetryRoot.append(list);
    const measured = (value) => typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value * 100) / 100) : 'unknown';
    for (const run of data.runs || []) {
      telemetryRoot.append(el('p', 'hint', `${run.model || 'unknown'} · ${run.created_at || 'unknown'} · tokens ${measured(run.eval_count)} · eval ${measured(run.eval_seconds)} s · load ${measured(run.load_seconds)} s · prompt ${measured(run.prompt_eval_seconds)} s · ${measured(run.tokens_per_second)} tokens/s · ${run.finish_reason || 'unknown'}`));
    }
    if (!(data.runs || []).length) telemetryRoot.append(el('p', 'hint', 'Gemma: unknown'));
    if (data.gpu?.status !== 'measured') telemetryRoot.append(el('p', 'hint', 'GPU: unknown'));
    for (const sample of data.gpu?.samples || []) {
      telemetryRoot.append(el('p', 'hint', `GPU ${sample.device_id || 'unknown'} · ${sample.measured_at || 'unknown'} · ${measured(sample.utilization_percent)}% · VRAM ${measured(sample.memory_used_bytes)} / ${measured(sample.memory_total_bytes)} bytes`));
    }
  }

  async function load() {
    status.textContent = 'Загружаю…';
    try {
      const response = await fetch('/hub/api/board', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) { window.location.replace('/hub/login/'); return; }
      if (response.status === 403) { status.textContent = 'Доступ только владельцу.'; return; }
      if (!response.ok) { status.textContent = 'Доска сейчас недоступна (проверьте токен чтения на сервере).'; return; }
      const board = await response.json();
      cards = Array.isArray(board.cards) ? board.cards : [];
      const unmapped = Number(board.unmappedCount) || 0;
      status.textContent = `Карточек: ${cards.length}${unmapped ? `, не распознано строк: ${unmapped}` : ''}.`;
      render();
      renderTelemetry(board.telemetry);
    } catch {
      status.textContent = 'Нет связи с сервером.';
    }
  }

  search.addEventListener('input', render);
  load();
})();
