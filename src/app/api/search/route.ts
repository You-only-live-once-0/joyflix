/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { SearchResult } from '@/lib/types';

export const runtime = 'nodejs';

const SEARCH_CONCURRENCY = 10;

async function searchWithConcurrency(
  sites: Awaited<ReturnType<typeof getConfig>>['SourceConfig'],
  query: string
): Promise<SearchResult[]> {
  const buckets: SearchResult[][] = new Array(sites.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= sites.length) return;
      const site = sites[index];
      try {
        buckets[index] = await searchFromApi(site, query);
      } catch (error) {
        console.warn(
          `搜索失败 ${site.name}:`,
          error instanceof Error ? error.message : error
        );
        buckets[index] = [];
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(SEARCH_CONCURRENCY, sites.length) },
      () => worker()
    )
  );

  return buckets.flatMap((bucket) => bucket || []);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim();

  if (!query) {
    const cacheTime = await getCacheTime();
    return NextResponse.json(
      { results: [] },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Netlify-Vary': 'query',
        },
      }
    );
  }

  const config = await getConfig();
  const seenApis = new Set<string>();
  const apiSites = config.SourceConfig.filter((site) => !site.disabled).filter(
    (site) => {
      if (seenApis.has(site.api)) return false;
      seenApis.add(site.api);
      return true;
    }
  );

  try {
    // 下游请求自身已有 AbortController 超时；这里用滚动并发池限制瞬时连接数，
    // 避免片源增加后一次搜索同时打几十个远端接口。
    const flattenedResults = await searchWithConcurrency(apiSites, query);
    const cacheTime = await getCacheTime();

    return NextResponse.json(
      { results: flattenedResults },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Netlify-Vary': 'query',
        },
      }
    );
  } catch {
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
