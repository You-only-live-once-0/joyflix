const FALLBACK_PASSWORD_SALT = 'c7e80172f693d8718c961261daaa9503';
const FALLBACK_PASSWORD_HASH =
  '5598af9ed6e129a35f2cf28a2d2991087897452a13c560108fd5a48579dec75c';
const FALLBACK_PASSWORD_ITERATIONS = 210_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(value: string): Uint8Array {
  const pairs = value.match(/.{1,2}/g) || [];
  return new Uint8Array(pairs.map((pair) => parseInt(pair, 16)));
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  if (leftBytes.length !== rightBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function hashFallbackPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: hexToBytes(FALLBACK_PASSWORD_SALT),
      iterations: FALLBACK_PASSWORD_ITERATIONS,
    },
    keyMaterial,
    256
  );

  return toHex(derived);
}

export function hasSitePassword(): boolean {
  return Boolean(process.env.PASSWORD || FALLBACK_PASSWORD_HASH);
}

export async function verifySitePassword(password: string): Promise<boolean> {
  if (process.env.PASSWORD) {
    return password === process.env.PASSWORD;
  }

  const candidateHash = await hashFallbackPassword(password);
  return timingSafeEqual(candidateHash, FALLBACK_PASSWORD_HASH);
}

export function getAuthSigningSecret(): string {
  return process.env.PASSWORD || FALLBACK_PASSWORD_HASH;
}
