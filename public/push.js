'use strict';
(function () {
  const button = document.getElementById('push-toggle');
  const status = document.getElementById('push-status');
  if (!button || !status) return;
  // Both the mounted Worker and a local root preview use the same files.
  const base = new URL(window.location.pathname.startsWith('/hub/') ? '/hub/' : '/', window.location.origin);
  const api = new URL('api/push/subscriptions', base);
  let publicKey = null;
  let subscription = null;
  let busy = false;
  let ended = false;
  const say = (text) => { status.textContent = text; };
  const update = () => {
    button.disabled = busy || ended || !publicKey;
    button.textContent = subscription ? 'Отключить уведомления' : 'Включить уведомления';
  };
  const supported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  window.addEventListener('hub:session-ended', () => { ended = true; publicKey = null; update(); say('Войди снова, чтобы управлять уведомлениями.'); });
  if (!supported) {
    say('Уведомления недоступны. На iPhone добавь Хаб на экран «Домой» и открой его оттуда (iOS 16.4 или новее).');
    update();
    return;
  }
  function applicationKey(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
  }
  function sameKey(value) {
    const current = value.options && value.options.applicationServerKey;
    if (!current) return false;
    const left = new Uint8Array(current);
    const right = applicationKey(publicKey);
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  }
  async function save(method, payload) {
    const response = await fetch(api.href, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'X-Hub-Request': '1' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error('subscription_unavailable');
  }
  button.addEventListener('click', async () => {
    if (busy || ended || !publicKey) return;
    busy = true; update();
    try {
      if (subscription) {
        await save('DELETE', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
        subscription = null;
        if (!ended) say('Уведомления отключены на этом устройстве.');
      } else {
        // Ask while handling the user's gesture, before registering or awaiting I/O.
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          say('Разрешение не получено. Разреши уведомления для Хаба в настройках браузера.');
          return;
        }
        if (ended) return;
        const registration = await navigator.serviceWorker.register(new URL('push-sw.js', base).href, { scope: base.pathname });
        // Wait for this registration, not serviceWorker.ready (which may belong to another app).
        if (!registration.active) {
          await new Promise((resolve, reject) => {
            const worker = registration.installing || registration.waiting;
            if (!worker) { reject(new Error('worker_unavailable')); return; }
            const changed = () => {
              if (worker.state === 'activated') resolve();
              if (worker.state === 'redundant') reject(new Error('worker_unavailable'));
            };
            worker.addEventListener('statechange', changed);
            changed();
          });
        }
        if (ended) return;
        let current = await registration.pushManager.getSubscription();
        if (current && !sameKey(current)) { await current.unsubscribe(); current = null; }
        const pending = current || await registration.pushManager.subscribe({
          userVisibleOnly: true, applicationServerKey: applicationKey(publicKey),
        });
        if (ended) { await pending.unsubscribe(); return; }
        // Keep the button in retry mode until the server acknowledges storage.
        await save('POST', pending.toJSON());
        subscription = pending;
        if (!ended) say('Подписка сохранена. Доставка появится после настройки отправки.');
      }
    } catch {
      if (!ended) say('Не удалось сохранить изменение. Проверь связь и повтори.');
    } finally { busy = false; update(); }
  });
  (async () => {
    try {
      const response = await fetch(new URL('api/push/config', base).href, { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401 || response.status === 403) { say('Уведомления доступны владельцу Хаба после входа.'); return; }
      if (!response.ok) {
        if (response.status === 503 && (await response.json()).error === 'push_not_configured') { say('Отправка уведомлений ещё не настроена.'); return; }
        throw new Error('config_unavailable');
      }
      const config = await response.json();
      if (!config.publicKey) { say('Отправка уведомлений ещё не настроена.'); return; }
      const key = applicationKey(config.publicKey);
      if (key.length !== 65 || key[0] !== 4) throw new Error('invalid_key');
      if (ended) return;
      publicKey = config.publicKey;
      const registration = await navigator.serviceWorker.getRegistration(base.href);
      const current = registration ? await registration.pushManager.getSubscription() : null;
      if (ended) return;
      if (current && sameKey(current)) {
        // Reconcile browser state after a failed save or server-side expiry cleanup.
        await save('POST', current.toJSON());
        if (ended) return;
        subscription = current;
      }
      say(subscription ? 'Это устройство подписано на уведомления.' : 'Получай уведомления, когда агенты отправляют изменения.');
    } catch { if (!ended) say('Не удалось проверить уведомления. Обнови страницу, когда появится связь.'); }
    finally { update(); }
  })();
})();
