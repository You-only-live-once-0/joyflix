/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  getAuthSigningSecret,
  hasSitePassword,
  verifySitePassword,
} from '@/lib/site-password';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (shouldSkipAuth(pathname)) {
    return NextResponse.next();
  }

  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

  if (!hasSitePassword()) {
    const warningUrl = new URL('/warning', request.url);
    return NextResponse.redirect(warningUrl);
  }

  const authInfo = getAuthInfoFromCookie(request);

  if (!authInfo) {
    return handleAuthFailure(request, pathname);
  }

  if (storageType === 'localstorage') {
    if (
      !authInfo.password ||
      !(await verifySitePassword(authInfo.password))
    ) {
      return handleAuthFailure(request, pathname);
    }
    return NextResponse.next();
  }

  if (!authInfo.username || !authInfo.signature) {
    return handleAuthFailure(request, pathname);
  }

  const isValidSignature = await verifySignature(
    authInfo.username,
    authInfo.signature,
    getAuthSigningSecret()
  );

  if (isValidSignature) {
    return NextResponse.next();
  }

  return handleAuthFailure(request, pathname);
}

let cachedVerificationSecret = '';
let cachedVerificationKey: CryptoKey | null = null;

async function getVerificationKey(secret: string): Promise<CryptoKey> {
  if (cachedVerificationKey && cachedVerificationSecret === secret) {
    return cachedVerificationKey;
  }
  cachedVerificationKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  cachedVerificationSecret = secret;
  return cachedVerificationKey;
}

async function verifySignature(
  data: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const messageData = new TextEncoder().encode(data);

  try {
    const key = await getVerificationKey(secret);

    const signatureBuffer = new Uint8Array(
      signature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
    );

    return await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBuffer,
      messageData
    );
  } catch (error) {
    console.error('签名验证失败:', error);
    return false;
  }
}

function handleAuthFailure(
  request: NextRequest,
  pathname: string
): NextResponse {
  if (pathname.startsWith('/api')) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  const fullUrl = `${pathname}${request.nextUrl.search}`;
  loginUrl.searchParams.set('redirect', fullUrl);
  return NextResponse.redirect(loginUrl);
}

function shouldSkipAuth(pathname: string): boolean {
  const skipPaths = [
    '/_next',
    '/favicon.ico',
    '/robots.txt',
    '/manifest.json',
    '/icons/',
    '/logo.png',
    '/screenshot.png',
  ];

  return skipPaths.some((path) => pathname.startsWith(path));
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|warning|api/login|api/logout|api/cron|api/image-proxy|api/server-config|api/recommendations).*))',
  ],
};
