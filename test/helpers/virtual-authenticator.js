import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

function head(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  if (value < 65536) return Buffer.from([(major << 5) | 25, value >> 8, value & 255]);
  throw new Error('CBOR value exceeds test encoder bound');
}

function cborInt(value) {
  return value >= 0 ? head(0, value) : head(1, -1 - value);
}

function cborBytes(value) { return Buffer.concat([head(2, value.length), value]); }
function cborText(value) { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
function cborMap(entries) {
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, value]) => [cborInt(key), value])]);
}
function cborTextMap(entries) {
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, value]) => [cborText(key), value])]);
}

function b64url(bytes) { return Buffer.from(bytes).toString('base64url'); }
function unb64url(value) { return Buffer.from(value, 'base64url'); }
function authData(rpID, flags, counter, tail = Buffer.alloc(0)) {
  const rpHash = createHash('sha256').update(rpID).digest();
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  return Buffer.concat([rpHash, Buffer.from([flags]), counterBytes, tail]);
}

export function createVirtualAuthenticator(rpID, origin) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const x = unb64url(jwk.x);
  const y = unb64url(jwk.y);
  const cose = cborMap([
    [1, cborInt(2)], [3, cborInt(-7)], [-1, cborInt(1)], [-2, cborBytes(x)], [-3, cborBytes(y)],
  ]);
  const credentialID = randomBytes(16);
  const credentialIDField = Buffer.alloc(2);
  credentialIDField.writeUInt16BE(credentialID.length);
  const attestedCredentialData = Buffer.concat([Buffer.alloc(16), credentialIDField, credentialID, cose]);

  return {
    async registrationResponse(options) {
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false,
      }));
      const data = authData(rpID, 0x45, 0, attestedCredentialData);
      const attestationObject = cborTextMap([
        ['fmt', cborText('none')],
        ['attStmt', cborTextMap([])],
        ['authData', cborBytes(data)],
      ]);
      return {
        id: b64url(credentialID), rawId: b64url(credentialID), type: 'public-key',
        response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['internal'] },
        clientExtensionResults: {},
      };
    },
    async authenticationResponse(options, count = 1) {
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false,
      }));
      const data = authData(rpID, 0x05, count);
      const signed = Buffer.concat([data, createHash('sha256').update(clientDataJSON).digest()]);
      const signature = sign('sha256', signed, pair.privateKey);
      return {
        id: b64url(credentialID), rawId: b64url(credentialID), type: 'public-key',
        response: {
          clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(data), signature: b64url(signature),
          userHandle: null,
        },
        clientExtensionResults: {},
      };
    },
  };
}
