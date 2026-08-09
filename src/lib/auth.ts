import { NextRequest } from 'next/server';

export type AuthRole = 'owner' | 'admin' | 'user';

export type AuthInfo = {
  username?: string;
  role?: AuthRole;
  signature?: string;
  timestamp?: number;
  expiresAt?: number;
};

const AUTH_COOKIE_NAME = 'auth';
const AUTH_META_COOKIE_NAME = 'auth_meta';
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(value: string): Uint8Array {
  const pairs = value.match(/.{1,2}/g) || [];
  return new Uint8Array(pairs.map((pair) => parseInt(pair, 16)));
}

function getSignaturePayload(authInfo: AuthInfo): string {
  return [
    authInfo.username || '',
    authInfo.role || 'user',
    authInfo.timestamp || 0,
    authInfo.expiresAt || 0,
  ].join('|');
}

async function createSignature(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(data)
  );
  return toHex(signature);
}

async function verifySignature(
  data: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    return await crypto.subtle.verify(
      'HMAC',
      key,
      hexToBytes(signature),
      encoder.encode(data)
    );
  } catch {
    return false;
  }
}

export async function createAuthInfo(
  username: string,
  role: AuthRole,
  secret: string,
  ttlMs = DEFAULT_SESSION_TTL_MS
): Promise<AuthInfo> {
  const timestamp = Date.now();
  const authInfo: AuthInfo = {
    username,
    role,
    timestamp,
    expiresAt: timestamp + ttlMs,
  };

  return {
    ...authInfo,
    signature: await createSignature(getSignaturePayload(authInfo), secret),
  };
}

export async function verifyAuthInfo(
  authInfo: AuthInfo,
  secret: string
): Promise<boolean> {
  if (
    !authInfo.username ||
    !authInfo.role ||
    !authInfo.signature ||
    !authInfo.timestamp ||
    !authInfo.expiresAt
  ) {
    return false;
  }

  const now = Date.now();
  if (authInfo.expiresAt <= now || authInfo.timestamp > now + 60_000) {
    return false;
  }

  return verifySignature(
    getSignaturePayload(authInfo),
    authInfo.signature,
    secret
  );
}

export function encodeAuthInfo(authInfo: AuthInfo): string {
  return encodeURIComponent(JSON.stringify(authInfo));
}

function parseCookieValue(value: string | undefined): AuthInfo | null {
  if (!value) return null;

  try {
    let decoded = decodeURIComponent(value);
    if (decoded.includes('%')) {
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        // Keep the first decoded value for backwards compatibility.
      }
    }
    return JSON.parse(decoded) as AuthInfo;
  } catch {
    return null;
  }
}

export function getAuthInfoFromCookie(request: NextRequest): AuthInfo | null {
  return parseCookieValue(request.cookies.get(AUTH_COOKIE_NAME)?.value);
}

// Browser code only receives non-sensitive identity metadata. The real session
// cookie is HttpOnly and cannot be read by JavaScript.
export function getAuthInfoFromBrowserCookie(): AuthInfo | null {
  if (typeof document === 'undefined') return null;

  const cookies = document.cookie.split(';').reduce((acc, cookie) => {
    const trimmed = cookie.trim();
    const firstEqualIndex = trimmed.indexOf('=');
    if (firstEqualIndex > 0) {
      acc[trimmed.slice(0, firstEqualIndex)] = trimmed.slice(firstEqualIndex + 1);
    }
    return acc;
  }, {} as Record<string, string>);

  return (
    parseCookieValue(cookies[AUTH_META_COOKIE_NAME]) ||
    parseCookieValue(cookies[AUTH_COOKIE_NAME])
  );
}
