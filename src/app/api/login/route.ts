/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { createAuthInfo, encodeAuthInfo, type AuthRole } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  getAuthSigningSecret,
  hasSitePassword,
  verifySitePassword,
} from '@/lib/site-password';

export const runtime = 'edge';

const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'upstash'
    | undefined) || 'localstorage';
const MAX_USERNAME_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 256;

function isSecureRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  return forwardedProto === 'https' || request.nextUrl.protocol === 'https:';
}

function clearAuthCookies(response: NextResponse, secure: boolean) {
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
}

async function setAuthCookies(
  response: NextResponse,
  username: string,
  role: AuthRole,
  secure: boolean,
  exposeUsername = true
) {
  const authInfo = await createAuthInfo(
    username,
    role,
    getAuthSigningSecret()
  );
  const expires = new Date(authInfo.expiresAt || Date.now());

  response.cookies.set('auth', encodeAuthInfo(authInfo), {
    path: '/',
    expires,
    sameSite: 'lax',
    httpOnly: true,
    secure,
  });

  response.cookies.set(
    'auth_meta',
    encodeURIComponent(
      JSON.stringify({
        username: exposeUsername ? username : undefined,
        role,
      })
    ),
    {
      path: '/',
      expires,
      sameSite: 'lax',
      httpOnly: false,
      secure,
    }
  );
}

function validatePassword(password: unknown): password is string {
  return (
    typeof password === 'string' &&
    password.length > 0 &&
    password.length <= MAX_PASSWORD_LENGTH
  );
}

export async function POST(req: NextRequest) {
  try {
    const secure = isSecureRequest(req);

    if (STORAGE_TYPE === 'localstorage') {
      if (!hasSitePassword()) {
        const response = NextResponse.json({ ok: true });
        clearAuthCookies(response, secure);
        return response;
      }

      const { password } = await req.json();
      if (!validatePassword(password)) {
        return NextResponse.json({ error: '密码格式无效' }, { status: 400 });
      }

      if (!(await verifySitePassword(password))) {
        return NextResponse.json(
          { ok: false, error: '密码错误' },
          { status: 401 }
        );
      }

      const response = NextResponse.json({ ok: true });
      await setAuthCookies(response, '__local__', 'user', secure, false);
      return response;
    }

    const { username, password } = await req.json();

    if (
      !username ||
      typeof username !== 'string' ||
      username.length > MAX_USERNAME_LENGTH
    ) {
      return NextResponse.json({ error: '用户名格式无效' }, { status: 400 });
    }
    if (!validatePassword(password)) {
      return NextResponse.json({ error: '密码格式无效' }, { status: 400 });
    }

    const ownerUsername = process.env.USERNAME || 'admin';
    if (username === ownerUsername && (await verifySitePassword(password))) {
      const response = NextResponse.json({ ok: true });
      await setAuthCookies(response, username, 'owner', secure);
      return response;
    } else if (username === ownerUsername) {
      return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
    }

    const config = await getConfig();
    const user = config.UserConfig.Users.find((item) => item.username === username);
    if (user && user.banned) {
      return NextResponse.json({ error: '用户被封禁' }, { status: 401 });
    }

    try {
      const pass = await db.verifyUser(username, password);
      if (!pass) {
        return NextResponse.json(
          { error: '用户名或密码错误' },
          { status: 401 }
        );
      }

      const response = NextResponse.json({ ok: true });
      await setAuthCookies(response, username, user?.role || 'user', secure);
      return response;
    } catch (error) {
      console.error('数据库验证失败', error);
      return NextResponse.json({ error: '数据库错误' }, { status: 500 });
    }
  } catch (error) {
    console.error('登录接口异常', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
