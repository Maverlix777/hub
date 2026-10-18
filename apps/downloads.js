'use strict';
(function () {
  const items = JSON.parse(document.getElementById('manifest').textContent);
  const list = document.getElementById('list');
  const q = document.getElementById('q');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function render() {
    const t = q.value.trim().toLowerCase();
    const shown = items.filter((i) => !t || [i.project, i.platform, i.kind, i.version, i.note].join(' ').toLowerCase().includes(t));
    list.replaceChildren();
    if (!shown.length) {
      const li = el('li', 'empty', 'Ничего не найдено.');
      list.append(li);
      return;
    }
    for (const i of shown) {
      const li = el('li', 'dl');
      li.dataset.project = i.project;
      li.append(el('h2', '', i.project + ' ' + i.version));
      const tags = el('div', 'tags');
      const mb = i.size ? (i.size / 1048576).toFixed(1) + ' МБ' : '';
      for (const x of [i.platform, i.kind, i.date, mb]) if (x) tags.append(el('span', '', x));
      li.append(tags);
      if (i.note) li.append(el('div', 'note', i.note));
      li.append(el('div', 'sum', 'sha256: ' + i.sha256));
      if (i.available !== false && /^https:\/\//i.test(i.url || '')) {
        const a = el('a', 'btn', 'Скачать');
        a.href = i.url;
        a.rel = 'noopener noreferrer';
        li.append(a);
      }
      list.append(li);
    }
  }

  q.addEventListener('input', render);
  render();
})();
