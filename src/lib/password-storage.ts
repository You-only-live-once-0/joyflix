const PASSWORD_PREFIX = 'joyflix-pbkdf2-sha256-v1';
const PASSWORD_ITERATIONS = 600_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function isEncodedUserPassword(value: string): boolean {
  return value.startsWith(`${PASSWORD_PREFIX}$`);
}

/**
 * Encode a user password before storing it in Redis/Upstash.
 *
 * The username is part of the PBKDF2 salt so different users with the same
 * password do not share the same stored value. The format is deterministic
 * to remain compatible with the existing storage interface, which performs
 * equality checks instead of returning the stored credential to callers.
 */
export async function encodeUserPassword(
  username: string,
  password: string
): Promise<string> {
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
      salt: encoder.encode(`joyflix:v1:user:${username}`),
      iterations: PASSWORD_ITERATIONS,
    },
    keyMaterial,
    256
  );

  return `${PASSWORD_PREFIX}$${PASSWORD_ITERATIONS}$${toHex(derived)}`;
}
