/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';

export const runtime = 'nodejs';

function buildCacheHeaders(cacheTime: number) {
  const staleTime = Math.max(cacheTime, 300);
  const edgeValue = `public, s-maxage=${cacheTime}, stale-while-revalidate=${staleTime}, stale-if-error=3600`;

  return {
    'Cache-Control': `public, max-age=${cacheTime}, ${edgeValue.replace('public, ', '')}`,
    'CDN-Cache-Control': edgeValue,
    'Vercel-CDN-Cache-Control': edgeValue,
    'Netlify-Vary': 'query',
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim().slice(0, 120) || '';
  const cacheTime = await getCacheTime();

  if (!query) {
    return NextResponse.json(
      { results: [] },
      { headers: buildCacheHeaders(cacheTime) }
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

  // searchFromApi already aborts normal sources after 8s; public-media
  // adapters also have their own timeout. Avoid an extra Promise.race timer
  // for every source so completed searches do not leave redundant timers alive.
  const searchPromises = apiSites.map((site) =>
    searchFromApi(site, query).catch((error) => {
      console.warn(`搜索失败 ${site.name}:`, error);
      return [];
    })
  );

  try {
    const results = await Promise.allSettled(searchPromises);
    const flattenedResults = results
      .filter(
        (result): result is PromiseFulfilledResult<any[]> =>
          result.status === 'fulfilled'
      )
      .flatMap((result) => result.value);

    return NextResponse.json(
      { results: flattenedResults },
      { headers: buildCacheHeaders(cacheTime) }
    );
  } catch (error) {
    console.error('搜索失败:', error);
    return NextResponse.json(
      { error: '搜索失败' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
