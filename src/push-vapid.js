import { Buffer } from 'node:buffer';

function canonicalKey(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('push_not_configured');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) throw new Error('push_not_configured');
  return bytes;
}

// Keys stay in the Worker; only a provider-bound, short-lived authorization leaves.
export async function signPushVapid(endpoint, publicKey, privateKey, now) {
  try {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error();
    const point = canonicalKey(publicKey, 65);
    const scalar = canonicalKey(privateKey, 32);
    if (point[0] !== 4) throw new Error();
    const publicCryptoKey = await crypto.subtle.importKey('raw', point, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const privateCryptoKey = await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33).toString('base64url'), d: scalar.toString('base64url'),
    }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const expiresAt = Math.floor(now / 1000) + 600;
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud: new URL(endpoint).origin, exp: expiresAt, sub: 'https://hub.kolobovdjp.org/' })}`;
    const bytes = new TextEncoder().encode(unsigned);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateCryptoKey, bytes);
    if (signature.byteLength !== 64 || !await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicCryptoKey, signature, bytes)) throw new Error();
    const publicKeySha256 = Buffer.from(await crypto.subtle.digest('SHA-256', point)).toString('hex');
    return { authorization: `vapid t=${unsigned}.${Buffer.from(signature).toString('base64url')}, k=${publicKey}`, publicKeySha256, expiresAt };
  } catch { throw new Error('push_not_configured'); }
}
