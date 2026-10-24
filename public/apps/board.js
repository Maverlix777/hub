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
    } catch {
      status.textContent = 'Нет связи с сервером.';
    }
  }

  search.addEventListener('input', render);
  load();
})();
