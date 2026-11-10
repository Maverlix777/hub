// Native app (iOS/Android WebView shells). Identifiers: proposals/hub-app/PLAN.md in agent-handoffs.
export const APPLE_TEAM_ID = 'S9VUV87V4M';
export const APP_ID = 'org.kolobovdjp.hub';
// TODO: replace after the upload keystore exists (sha256 of the signing certificate, colon-separated hex).
// Until then Android App Links / passkeys do not verify. This is a placeholder, not a real fingerprint.
export const ANDROID_CERT_SHA256 = 'TODO:REPLACE_WITH_SIGNING_CERT_SHA256';

export const APPLE_APP_SITE_ASSOCIATION = {
  applinks: { details: [{ appIDs: [`${APPLE_TEAM_ID}.${APP_ID}`], components: [{ '/': '/hub/*' }] }] },
  webcredentials: { apps: [`${APPLE_TEAM_ID}.${APP_ID}`] },
};

export const ASSET_LINKS = [{
  relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
  target: { namespace: 'android_app', package_name: APP_ID, sha256_cert_fingerprints: [ANDROID_CERT_SHA256] },
}];

const WELL_KNOWN = {
  '/.well-known/apple-app-site-association': APPLE_APP_SITE_ASSOCIATION,
  '/.well-known/assetlinks.json': ASSET_LINKS,
};

export function wellKnownResponse(pathname, method) {
  const body = WELL_KNOWN[pathname];
  if (!body) return null;
  if (!['GET', 'HEAD'].includes(method)) return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  return new Response(method === 'HEAD' ? null : JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
  });
}

// Origins a native passkey client may report in clientDataJSON.
// iOS ASAuthorization reports https://<rpID> (verify on device; RP_ID is the parent domain, so this is the legacy origin).
// Android reports android:apk-key-hash:<base64url sha256 of signing cert>; set NATIVE_ANDROID_ORIGINS (comma list) after the keystore exists. TODO.
export function expectedOrigins(env, canonicalOrigin) {
  const extra = [env.LEGACY_ORIGIN || 'https://kolobovdjp.org'];
  for (const value of String(env.NATIVE_ANDROID_ORIGINS || '').split(',')) {
    if (/^android:apk-key-hash:[A-Za-z0-9_-]{43}$/.test(value.trim())) extra.push(value.trim());
  }
  return [...new Set([canonicalOrigin, ...extra])];
}
