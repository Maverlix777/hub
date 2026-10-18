'use strict';
(function () {
  const apps = JSON.parse(document.getElementById('apps').textContent);
  const grid = document.getElementById('grid');
  const accountName = document.getElementById('account-name');
  const logout = document.getElementById('logout');

  function clearChatData() {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('hub.chat.')) localStorage.removeItem(key);
      }
    } catch { /* storage may be unavailable */ }
    try { localStorage.setItem('hub.session.logout', String(Date.now())); } catch { /* storage may be unavailable */ }
  }

  fetch('/hub/api/session', { credentials: 'same-origin', cache: 'no-store' }).then(async (response) => {
    if (!response.ok) {
      clearChatData();
      window.location.replace('/hub/login/');
      return;
    }
    const session = await response.json();
    accountName.textContent = `${session.username} · ${session.entitlement}`;
    logout.hidden = false;
  }).catch(() => {
    clearChatData();
    window.location.replace('/hub/login/');
  });

  logout.addEventListener('click', async () => {
    logout.disabled = true;
    clearChatData();
    try {
      await fetch('/hub/api/logout', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: '{}',
      });
    } finally {
      window.location.replace('/hub/login/');
    }
  });

  // Remove keys left by the older public Hub version; keys are now kept in tab memory only.
  try { localStorage.removeItem('hub.chat.key'); } catch { /* storage may be unavailable */ }
  for (const app of apps) {
    const li = document.createElement('li');
    const ready = app.status === 'ready' && app.href;
    const tile = document.createElement(ready ? 'a' : 'div');
    tile.className = 'tile' + (ready ? '' : ' soon');
    tile.dataset.id = app.id;
    if (ready) {
      tile.href = app.href;
      if (/^https?:/i.test(app.href)) tile.rel = 'noopener noreferrer';
    } else tile.setAttribute('aria-disabled', 'true');
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
