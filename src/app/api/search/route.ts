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

function normalizeTitle(value: string | undefined): string {
  return (value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[·・:：!！?？,，。．、\-—_()（）\[\]【】《》<>~～'"“”‘’]/g, '');
}

function getRequestedYear(request: Request, searchParams: URLSearchParams) {
  const direct = searchParams.get('year')?.trim();
  if (direct) return direct;
  const referer = request.headers.get('referer');
  if (!referer) return '';
  try {
    return new URL(referer).searchParams.get('year')?.trim() || '';
  } catch {
    return '';
  }
}

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
    const flattenedResults = await searchWithConcurrency(
      apiSites,
      query,
      request.signal
    );

    if (flattenedResults.length === 0) {
      return NextResponse.json(
        { results: [] },
        { headers: NO_STORE_HEADERS }
      );
    }

    const requestedYear = getRequestedYear(request, searchParams);
    const normalizedQuery = normalizeTitle(query);
    const strictMatchExists = flattenedResults.some(
      (result) =>
        normalizeTitle(result.title) === normalizedQuery &&
        (!requestedYear || result.year === requestedYear)
    );

    let responseResults = flattenedResults;
    let compatibilityFallback = false;

    if (!strictMatchExists) {
      const sameTitleResults = flattenedResults.filter(
        (result) => normalizeTitle(result.title) === normalizedQuery
      );
      if (sameTitleResults.length > 0) {
        responseResults = [
          ...sameTitleResults.map((result) => ({
            ...result,
            title: query,
            year: requestedYear || result.year,
          })),
          ...flattenedResults,
        ];
        compatibilityFallback = true;
      }
    }

    if (compatibilityFallback) {
      return NextResponse.json(
        { results: responseResults },
        { headers: NO_STORE_HEADERS }
      );
    }

    const cacheTime = await getCacheTime();

    return NextResponse.json(
      { results: responseResults },
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
