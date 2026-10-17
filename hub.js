'use strict';
(function () {
  const apps = JSON.parse(document.getElementById('apps').textContent);
  const grid = document.getElementById('grid');
  for (const app of apps) {
    const li = document.createElement('li');
    const ready = app.status === 'ready' && app.href;
    const tile = document.createElement(ready ? 'a' : 'div');
    tile.className = 'tile' + (ready ? '' : ' soon');
    tile.dataset.id = app.id;
    if (ready) tile.href = app.href;
    else tile.setAttribute('aria-disabled', 'true');
    const title = document.createElement('span');
    title.className = 'tile-title';
    title.textContent = app.title;
    tile.append(title);
    if (app.desc) {
      const desc = document.createElement('span');
      desc.className = 'tile-desc';
      desc.textContent = app.desc;
      tile.append(desc);
    }
    if (!ready) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'скоро';
      tile.append(badge);
    }
    li.append(tile);
    grid.append(li);
  }
})();
