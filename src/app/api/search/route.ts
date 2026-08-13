/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { SearchResult } from '@/lib/types';

export const runtime = 'nodejs';

const SEARCH_CONCURRENCY = 10;

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

async function searchWithConcurrency(
  sites: Awaited<ReturnType<typeof getConfig>>['SourceConfig'],
  query: string,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const buckets: SearchResult[][] = new Array(sites.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      const index = nextIndex++;
      if (index >= sites.length) return;
      const site = sites[index];
      try {
        buckets[index] = await searchFromApi(site, query, signal);
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
    const flattenedResults = await searchWithConcurrency(
      apiSites,
      query,
      request.signal
    );

    // 搜索依赖多个第三方片源。某一时刻全部片源超时/异常时，空结果通常只是
    // 暂时性故障。之前会把这种空结果按站点缓存时间（默认 2 小时）缓存到 CDN，
    // 导致用户反复刷新仍看到“未找到匹配结果”。空结果必须禁止缓存，让下一次
    // 请求真正重新访问下游片源。
    if (flattenedResults.length === 0) {
      return NextResponse.json(
        { results: [] },
        { headers: NO_STORE_HEADERS }
      );
    }

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
    return NextResponse.json(
      { error: '搜索失败' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
