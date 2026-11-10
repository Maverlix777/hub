// Shared Bearer-token check: SHA-256 of both sides, compared without early exit.
export function bearerConfigured(secret) {
  return typeof secret === 'string' && secret.length >= 32;
}

export async function bearerAuthorized(request, secret) {
  if (!bearerConfigured(secret)) return false;
  const supplied = request.headers.get('authorization');
  if (!supplied?.startsWith('Bearer ') || supplied.length > 512) return false;
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([digest(supplied.slice(7)), digest(secret)]);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}
