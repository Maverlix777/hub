'use strict';
(() => {
  const form = document.getElementById('auth-form');
  const username = document.getElementById('username');
  const login = document.getElementById('login');
  const register = document.getElementById('register');
  const status = document.getElementById('status');
  const buttons = [login, register];

  function clearOldAccountData() {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('hub.chat.')) localStorage.removeItem(key);
      }
      localStorage.setItem('hub.session.logout', String(Date.now()));
    } catch { /* storage may be unavailable */ }
  }

  function decode(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  }

  function encode(value) {
    return btoa(String.fromCharCode(...new Uint8Array(value)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function request(path, body) {
    const response = await fetch(`/hub/api/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let result = {};
    try { result = await response.json(); } catch { /* handled below */ }
    if (!response.ok) throw new Error(result.error || 'auth_failed');
    return result;
  }

  function prepareCreationOptions(options) {
    options.challenge = decode(options.challenge);
    options.user.id = decode(options.user.id);
    options.excludeCredentials = (options.excludeCredentials || []).map((credential) => ({
      ...credential,
      id: decode(credential.id),
    }));
    return options;
  }

  function prepareRequestOptions(options) {
    options.challenge = decode(options.challenge);
    options.allowCredentials = (options.allowCredentials || []).map((credential) => ({
      ...credential,
      id: decode(credential.id),
    }));
    return options;
  }

  function serializeCredential(credential, creating) {
    const response = credential.response;
    const serializedResponse = {
      clientDataJSON: encode(response.clientDataJSON),
    };
    if (creating) {
      serializedResponse.attestationObject = encode(response.attestationObject);
      if (typeof response.getTransports === 'function') serializedResponse.transports = response.getTransports();
    } else {
      serializedResponse.authenticatorData = encode(response.authenticatorData);
      serializedResponse.signature = encode(response.signature);
      serializedResponse.userHandle = response.userHandle ? encode(response.userHandle) : null;
    }
    return {
      id: credential.id,
      rawId: encode(credential.rawId),
      type: credential.type,
      response: serializedResponse,
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }

  async function run(action) {
    if (!form.reportValidity()) return;
    if (!window.PublicKeyCredential || !navigator.credentials) {
      status.textContent = 'Этот браузер не поддерживает ключи доступа WebAuthn.';
      return;
    }
    buttons.forEach((button) => { button.disabled = true; });
    status.textContent = action === 'register' ? 'Создайте ключ доступа на устройстве…' : 'Подтвердите вход ключом доступа…';
    try {
      const user = username.value.trim().toLowerCase();
      if (action === 'register') {
        const started = await request('register/options', { username: user });
        const credential = await navigator.credentials.create({ publicKey: prepareCreationOptions(started.options) });
        if (!credential) throw new Error('credential_cancelled');
        await request('register/verify', { challengeId: started.challengeId, response: serializeCredential(credential, true) });
      } else {
        const started = await request('login/options', { username: user });
        const credential = await navigator.credentials.get({ publicKey: prepareRequestOptions(started.options) });
        if (!credential) throw new Error('credential_cancelled');
        await request('login/verify', { challengeId: started.challengeId, response: serializeCredential(credential, false) });
      }
      clearOldAccountData();
      window.location.assign('/hub/');
    } catch (error) {
      status.textContent = error.name === 'NotAllowedError' || error.message === 'credential_cancelled'
        ? 'Действие отменено. Попробуйте ещё раз.'
        : 'Не удалось подтвердить ключ доступа. Проверьте имя, устройство и подключение.';
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  login.addEventListener('click', () => run('login'));
  register.addEventListener('click', () => run('register'));
  form.addEventListener('submit', (event) => { event.preventDefault(); run('login'); });

  fetch('/hub/api/session', { credentials: 'same-origin', cache: 'no-store' }).then((response) => {
    if (response.ok) window.location.replace('/hub/');
    else clearOldAccountData();
  }).catch(() => clearOldAccountData());
})();
