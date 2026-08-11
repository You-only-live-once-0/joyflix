import { NextResponse } from 'next/server';

import { getUpstashRedisClient } from '@/lib/upstash.db';

const RECOMMENDATIONS_KEY = 'recommendations:movie_titles_cache';
const LAST_UPDATED_KEY = 'recommendations:last_updated';
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const RESPONSE_CACHE_SECONDS = 3600;

export const dynamic = 'force-dynamic';

function parseCachedTitles(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function pickRandomTitles(titles: string[], count = 6): string[] {
  const copy = [...titles];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy.slice(0, count);
}

function jsonResponse(list: string[], status = 200) {
  return NextResponse.json(
    { list },
    {
      status,
      headers: {
        'Cache-Control': `public, s-maxage=${RESPONSE_CACHE_SECONDS}, stale-while-revalidate=86400`,
        'Vercel-CDN-Cache-Control': `public, s-maxage=${RESPONSE_CACHE_SECONDS}`,
      },
    }
  );
}

export async function GET(request: Request) {
  const client = getUpstashRedisClient();

  try {
    // 两个 Redis 读取互不依赖，直接并行，减少一次网络往返。
    const [lastUpdatedValue, cachedValue] = await Promise.all([
      client.get(LAST_UPDATED_KEY),
      client.get(RECOMMENDATIONS_KEY),
    ]);

    const lastUpdated =
      typeof lastUpdatedValue === 'number' ? lastUpdatedValue : 0;
    const cachedTitles = parseCachedTitles(cachedValue);
    const now = Date.now();
    const cacheFresh =
      cachedTitles.length > 0 &&
      lastUpdated > 0 &&
      now - lastUpdated <= REFRESH_INTERVAL_MS;

    if (cacheFresh) {
      return jsonResponse(pickRandomTitles(cachedTitles));
    }

    try {
      const origin = new URL(request.url).origin;
      const fetchUrl = `${origin}/api/douban/categories?kind=movie&category=热门&type=全部&limit=50`;
      const response = await fetch(fetchUrl, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error(`Douban recommendations returned ${response.status}`);
      }

      const data = await response.json();
      const movies: Array<{ title?: string }> = Array.isArray(data?.list)
        ? data.list
        : [];
      const uniqueTitles = Array.from(
        new Set(
          movies
            .map((movie) => movie.title?.trim())
            .filter((title): title is string => Boolean(title))
        )
      ).slice(0, 50);

      if (uniqueTitles.length === 0) {
        throw new Error('Douban recommendations returned no titles');
      }

      // 两个写入也互不依赖，并行完成；不再做生产环境中的重复验证读取。
      await Promise.all([
        client.set(RECOMMENDATIONS_KEY, uniqueTitles.join(',')),
        client.set(LAST_UPDATED_KEY, now),
      ]);

      return jsonResponse(pickRandomTitles(uniqueTitles));
    } catch (error) {
      console.warn(
        '推荐缓存刷新失败，使用现有缓存:',
        error instanceof Error ? error.message : error
      );
      return jsonResponse(pickRandomTitles(cachedTitles));
    }
  } catch (error) {
    console.error(
      '推荐 API 读取失败:',
      error instanceof Error ? error.message : error
    );
    return jsonResponse([], 500);
  }
}
