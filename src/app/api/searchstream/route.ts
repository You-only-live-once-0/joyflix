/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { SearchResult } from '@/lib/types';

export const runtime = 'nodejs';

const SEARCH_CONCURRENCY = 10;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim();

  if (!query) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
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
  const cacheTime = await getCacheTime();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let nextIndex = 0;

      const processSite = async (site: (typeof apiSites)[0]) => {
        try {
          const results: SearchResult[] = await searchFromApi(site, query);
          if (results.length > 0) {
            controller.enqueue(encoder.encode(JSON.stringify(results) + '\n'));
          }
        } catch (err: any) {
          console.warn(`搜索失败 ${site.name}:`, err?.message || err);
        }
      };

      // 使用滚动并发池：始终最多 10 个远端请求在途，一个完成就立刻补下一个。
      // 这样仍能持续流式返回首批结果，同时避免片源增加后几十个请求同时爆发。
      const worker = async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= apiSites.length) return;
          await processSite(apiSites[index]);
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(SEARCH_CONCURRENCY, apiSites.length) },
          () => worker()
        )
      );
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
      'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
      'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
    },
  });
}
