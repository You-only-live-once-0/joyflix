/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { SearchResult } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const config = await getConfig();
  // 同一个 API 地址只请求一次，避免配置别名造成重复出站请求。
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

      const processSite = async (site: (typeof apiSites)[0]) => {
        try {
          const results: SearchResult[] = await Promise.race([
            searchFromApi(site, query),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`${site.name} timeout`)), 10000)
            ),
          ]);

          if (results && results.length > 0) {
            const chunk = encoder.encode(JSON.stringify(results) + '\n');
            controller.enqueue(chunk);
          }
        } catch (err: any) {
          console.warn(`搜索失败 ${site.name}:`, err.message);
        }
      };

      const allPromises = apiSites.map(processSite);
      await Promise.all(allPromises);
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
