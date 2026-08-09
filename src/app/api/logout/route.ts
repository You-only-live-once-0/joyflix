import { NextResponse } from 'next/server';

export const runtime = 'edge';

const COOKIE_SECURE = process.env.NODE_ENV === 'production';

export async function POST() {
  const response = NextResponse.json({ ok: true });

  response.cookies.set('auth', '', {
    path: '/',
    expires: new Date(0),
    sameSite: 'lax',
    httpOnly: true,
    secure: COOKIE_SECURE,
  });

  response.cookies.set('auth_meta', '', {
    path: '/',
    expires: new Date(0),
    sameSite: 'lax',
    httpOnly: false,
    secure: COOKIE_SECURE,
  });

  return response;
}
