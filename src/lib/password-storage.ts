const PASSWORD_PREFIX = 'joyflix-pbkdf2-sha256-v1';
const PASSWORD_ITERATIONS = 600_000;
const PASSWORD_SALT_NAMESPACE =
  '3d34bbad8997199b0e65268f4c39f5c7788a709b372583673bfa34607ab64266';

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function isEncodedUserPassword(value: string): boolean {
  return value.startsWith(`${PASSWORD_PREFIX}$`);
}

async function deriveUserSalt(username: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${PASSWORD_SALT_NAMESPACE}:${username}`)
  );
}

/**
 * Encode a user password before storing it in Redis/Upstash.
 *
 * Each username receives a distinct pseudorandom salt derived from an
 * application namespace. The format remains deterministic because the legacy
 * storage interface validates credentials by equality instead of returning
 * the stored password record to callers.
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
  const salt = await deriveUserSalt(username);

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: PASSWORD_ITERATIONS,
    },
    keyMaterial,
    256
  );

  return `${PASSWORD_PREFIX}$${PASSWORD_ITERATIONS}$${toHex(derived)}`;
}
