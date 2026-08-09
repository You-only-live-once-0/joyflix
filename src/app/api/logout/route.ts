import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';

function isSecureRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  return forwardedProto === 'https' || request.nextUrl.protocol === 'https:';
}

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  const secure = isSecureRequest(request);

  response.cookies.set('auth', '', {
    path: '/',
    expires: new Date(0),
    sameSite: 'lax',
    httpOnly: true,
    secure,
  });

  response.cookies.set('auth_meta', '', {
    path: '/',
    expires: new Date(0),
    sameSite: 'lax',
    httpOnly: false,
    secure,
  });

  return response;
}
