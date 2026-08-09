import { NextResponse } from 'next/server';

export const runtime = 'edge';

const BANGUMI_CALENDAR_URL = 'https://api.bgm.tv/calendar';
const FRESH_SECONDS = 1800;
const STALE_SECONDS = 3600;

export async function GET() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(BANGUMI_CALENDAR_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'JoyFlix/1.0 (+https://github.com/You-only-live-once-0/joyflix)',
      },
    });

    if (!response.ok) {
      throw new Error(`Bangumi calendar request failed: ${response.status}`);
    }

    const data = await response.json();
    const edgeValue = `public, s-maxage=${FRESH_SECONDS}, stale-while-revalidate=${STALE_SECONDS}, stale-if-error=86400`;

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': `public, max-age=300, ${edgeValue.replace('public, ', '')}`,
        'CDN-Cache-Control': edgeValue,
        'Vercel-CDN-Cache-Control': edgeValue,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: '获取 Bangumi 日历失败',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
