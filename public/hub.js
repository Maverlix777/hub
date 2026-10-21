'use strict';
(function () {
  const apps = JSON.parse(document.getElementById('apps').textContent);
  const grid = document.getElementById('grid');
  const accountName = document.getElementById('account-name');
  const logout = document.getElementById('logout');
  const account = document.getElementById('account');
  const sessionStatus = document.getElementById('session-status');
  let ended = false;
  let checking = null;

  function clearChatData() {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('hub.chat.')) localStorage.removeItem(key);
      }
    } catch { /* storage may be unavailable */ }
    try { localStorage.setItem('hub.session.logout', String(Date.now())); } catch { /* storage may be unavailable */ }
  }

  function endSession() {
    if (ended) return;
    ended = true;
    account.hidden = true;
    logout.hidden = true;
    accountName.textContent = '';
    clearChatData();
    window.location.replace('/hub/login/');
  }

  function showOffline() {
    sessionStatus.textContent = 'Нет связи с сервером. Данные сохранены. Повторная проверка — при возврате на страницу.';
    sessionStatus.hidden = false;
  }

  function checkSession() {
    if (ended) return Promise.resolve(false);
    if (checking) return checking;
    checking = (async () => {
      try {
        const response = await fetch('/hub/api/session', { credentials: 'same-origin', cache: 'no-store' });
        if (ended) return false;
        if (response.status === 401 || response.status === 403) { endSession(); return false; }
        if (!response.ok) throw new Error('session_unavailable');
        const session = await response.json();
        if (ended) return false;
        if (!session || typeof session.username !== 'string' || !session.username.trim()) throw new Error('invalid_session');
        accountName.textContent = session.username;
        account.hidden = false;
        logout.hidden = false;
        sessionStatus.hidden = true;
        sessionStatus.textContent = '';
        return true;
      } catch {
        if (!ended) showOffline();
        return false;
      } finally { checking = null; }
    })();
    return checking;
  }
  window.addEventListener('focus', checkSession);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) return checkSession(); });
  window.addEventListener('storage', event => { if (event.key === 'hub.session.logout') endSession(); });

  logout.addEventListener('click', async () => {
    if (ended) return;
    // End local access before awaiting the logout request or another session response.
    ended = true;
    account.hidden = true;
    logout.hidden = true;
    logout.disabled = true;
    accountName.textContent = '';
    clearChatData();
    try {
      await fetch('/hub/api/logout', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: '{}',
      });
    } catch { /* local logout remains final during an outage */ }
    finally { window.location.replace('/hub/login/'); }
  });
  checkSession();

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
