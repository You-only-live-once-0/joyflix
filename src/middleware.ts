import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie, verifyAuthInfo } from '@/lib/auth';
import { getAuthSigningSecret, hasSitePassword } from '@/lib/site-password';

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

  const validSession = await verifyAuthInfo(authInfo, getAuthSigningSecret());
  if (!validSession) {
    return handleAuthFailure(request, pathname);
  }

  if (storageType === 'localstorage') {
    if (authInfo.username !== '__local__' || authInfo.role !== 'user') {
      return handleAuthFailure(request, pathname);
    }
    return NextResponse.next();
  }

  if (!authInfo.username || authInfo.username === '__local__') {
    return handleAuthFailure(request, pathname);
  }

  return NextResponse.next();
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
