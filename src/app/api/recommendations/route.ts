import { NextResponse } from 'next/server';

import { fetchDoubanData } from '@/lib/douban';

interface DoubanCategoryApiResponse {
  items: Array<{
    title?: string;
  }>;
}

export const runtime = 'edge';

const TARGET =
  'https://m.douban.com/rexxar/api/v2/subject/recent_hot/movie?start=0&limit=50&category=%E7%83%AD%E9%97%A8&type=%E5%85%A8%E9%83%A8';

export async function GET() {
  try {
    const data = await fetchDoubanData<DoubanCategoryApiResponse>(TARGET);
    const uniqueTitles = Array.from(
      new Set(
        (data.items || [])
          .map((item) => item.title?.trim() || '')
          .filter(Boolean)
      )
    );

    // Fisher-Yates shuffle avoids the biased Array.sort(() => Math.random()).
    for (let index = uniqueTitles.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [uniqueTitles[index], uniqueTitles[swapIndex]] = [
        uniqueTitles[swapIndex],
        uniqueTitles[index],
      ];
    }

    return NextResponse.json(
      { list: uniqueTitles.slice(0, 6) },
      {
        headers: {
          'Cache-Control':
            'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=86400',
          'CDN-Cache-Control':
            'public, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=86400',
          'Vercel-CDN-Cache-Control':
            'public, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=86400',
        },
      }
    );
  } catch (error) {
    console.error('获取随机推荐失败:', error);
    return NextResponse.json(
      { list: [] },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
