import { API_CONFIG, ApiSite } from '@/lib/config';
import { SearchResult } from '@/lib/types';
import {
  isPublicMediaAdapter,
  searchPublicMediaExact,
} from '@/lib/public-media';
import { cleanHtmlTags } from '@/lib/utils';

interface ApiSearchItem {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_play_url?: string;
  vod_class?: string;
  vod_year?: string;
  vod_content?: string;
  vod_douban_id?: number;
  type_name?: string;
}

// 辅助函数，用于解析 vod_play_url
function parseVodPlayUrl(vod_play_url: string): { episodes: string[]; titles: string[] } {
  let episodes: string[] = [];
  let titles: string[] = [];

  if (vod_play_url) {
    const vod_play_url_array = vod_play_url.split('$$$');
    vod_play_url_array.forEach((url: string) => {
      const matchEpisodes: string[] = [];
      const matchTitles: string[] = [];
      const title_url_array = url.split('#');
      title_url_array.forEach((title_url: string) => {
        const episode_title_url = title_url.split('$');
        if (
          episode_title_url.length === 2 &&
          episode_title_url[1].endsWith('.m3u8')
        ) {
          matchTitles.push(episode_title_url[0]);
          matchEpisodes.push(episode_title_url[1]);
        }
      });
      if (matchEpisodes.length > episodes.length) {
        episodes = matchEpisodes;
        titles = matchTitles;
      }
    });
  }

  return { episodes, titles };
}

// New function for stream search to get only requested fields
function getStreamSearchResultFromApiItem(
  item: ApiSearchItem,
  apiSite: ApiSite
): SearchResult {
  return {
    id: item.vod_id.toString(),
    title: '', // Not requested
    poster: '', // Not requested
    episodes: [], // Not requested
    episodes_titles: [], // Not requested
    source: apiSite.key,
    source_name: apiSite.name,
    class: item.vod_class || '',
    year: item.vod_year ? item.vod_year.match(/\d{4}/)?.[0] || '' : '',
    desc: cleanHtmlTags(item.vod_content || ''),
    type_name: '', // Not requested
    douban_id: 0, // Not requested
  };
}

// 为流式搜索（竞速模式）优化的新函数
export async function searchAndFindFromApi(
  apiSite: ApiSite,
  query: string,
  year: string | null,
  maxPages: number
): Promise<SearchResult | null> {
  if (isPublicMediaAdapter(apiSite.api)) {
    return searchPublicMediaExact(apiSite, query, year);
  }

  try {
    const apiBaseUrl = apiSite.api;
    const firstPageUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
    const apiName = apiSite.name;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(firstPageUrl, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json();
    if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
      return null;
    }

    // 在第一页查找匹配项
    for (const item of data.list) {
      if (
        item.vod_name.replaceAll(' ', '').toLowerCase() === query.replaceAll(' ', '').toLowerCase() &&
        (year ? item.vod_year === year : true)
      ) {
        const { episodes, titles } = parseVodPlayUrl(item.vod_play_url || '');
        return getStreamSearchResultFromApiItem(item, apiSite);
      }
    }

    // 如果第一页没有匹配项，则检查后续页面
    const pageCount = data.pagecount || 1;
    const pagesToFetch = Math.min(pageCount - 1, maxPages - 1);

    if (pagesToFetch > 0) {
      const pagePromises = Array.from({ length: pagesToFetch }, (_, i) => i + 2).map(async (page) => {
        const pageUrl =
          apiBaseUrl +
          API_CONFIG.search.pagePath
            .replace('{query}', encodeURIComponent(query))
            .replace('{page}', page.toString());
        
        try {
          const pageController = new AbortController();
          const pageTimeoutId = setTimeout(() => pageController.abort(), 8000);

          const pageResponse = await fetch(pageUrl, {
            headers: API_CONFIG.search.headers,
            signal: pageController.signal,
          });

          clearTimeout(pageTimeoutId);

          if (!pageResponse.ok) return null;
          const pageData = await pageResponse.json();
          if (!pageData || !pageData.list || !Array.isArray(pageData.list)) return null;

          for (const item of pageData.list) {
            if (
              item.vod_name.replaceAll(' ', '').toLowerCase() === query.replaceAll(' ', '').toLowerCase() &&
              (year ? item.vod_year === year : true)
            ) {
              const { episodes, titles } = parseVodPlayUrl(item.vod_play_url || '');
              return getStreamSearchResultFromApiItem(item, apiSite);
            }
          }
        } catch {
          return null;
        }
        return null;
      });

      // 竞速分页的 promise 以找到第一个匹配项
      const firstMatch = await Promise.race(pagePromises.map(p => p.then(res => res)));
      if (firstMatch) return firstMatch;
    }

    return null; // 在任何页面上都未找到匹配项
  } catch (error) {
    return null;
  }
}
