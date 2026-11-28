'use strict';
(function () {
  const snap = JSON.parse(document.getElementById('money-snapshot').textContent);
  const root = document.getElementById('money-root');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  const intro = root.querySelector('.page-intro');
  intro.append(el('h1', '', 'Деньги — EN Gaming'));
  if (snap.note) intro.append(el('p', '', snap.note));

  const videos = el('section', 'money-videos');
  videos.append(el('h2', '', 'Ролики'));
  const vList = el('ul', 'grid');
  for (const v of snap.videos || []) {
    const li = el('li', '');
    li.append(el('strong', '', v.title || v.id));
    const meta = [v.id, v.duration_sec ? v.duration_sec + ' с', v.file].filter(Boolean).join(' · ');
    if (meta) li.append(el('div', 'note', meta));
    vList.append(li);
  }
  videos.append(vList);
  root.append(videos);

  const approved = el('section', 'money-campaigns');
  approved.append(el('h2', '', 'Одобренные кампании'));
  const aList = el('ul', '');
  for (const id of snap.approved_ids || []) {
    aList.append(el('li', '', id));
  }
  approved.append(aList);
  root.append(approved);

  const rejected = el('section', 'money-campaigns');
  rejected.append(el('h2', '', 'Отклонённые кампании'));
  const rList = el('ul', '');
  for (const id of snap.rejected_ids || []) {
    rList.append(el('li', '', id));
  }
  rejected.append(rList);
  root.append(rejected);

  const facts = el('section', 'money-facts');
  facts.append(el('h2', '', 'Факты, не ролики'));
  const fList = el('ul', 'grid');
  for (const f of snap.facts || []) {
    const li = el('li', '');
    li.append(el('strong', '', f.hook || f.id));
    if (f.body) li.append(el('div', 'note', f.body));
    fList.append(li);
  }
  facts.append(fList);
  root.append(facts);

  const links = el('section', 'money-links');
  links.append(el('h2', '', 'Материалы'));
  const kit = el('a', 'btn', 'Media kit');
  kit.href = '../money/kit/index.html';
  const bio = el('a', 'btn', 'Link in bio');
  bio.href = '../money/link/index.html';
  links.append(kit, bio);
  root.append(links);
})();