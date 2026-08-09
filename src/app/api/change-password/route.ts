/* eslint-disable no-console*/

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { db } from '@/lib/db';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

  if (storageType === 'localstorage') {
    return NextResponse.json(
      { error: '不支持本地存储模式修改密码' },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();
    const { newPassword } = body;

    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!newPassword || typeof newPassword !== 'string') {
      return NextResponse.json({ error: '新密码不得为空' }, { status: 400 });
    }

    if (newPassword.length > 256) {
      return NextResponse.json({ error: '新密码过长' }, { status: 400 });
    }

    const username = authInfo.username;

    if (username === process.env.USERNAME) {
      return NextResponse.json(
        { error: '超管不能通过此接口修改密码' },
        { status: 403 }
      );
    }

    await db.changePassword(username, newPassword);

    return NextResponse.json(
      { ok: true },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('修改密码失败:', error);
    return NextResponse.json(
      {
        error: '修改密码失败',
        details: (error as Error).message,
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
