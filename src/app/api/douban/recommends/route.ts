/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';
import { fetchDoubanData } from '@/lib/douban';
import { DoubanResult } from '@/lib/types';

interface DoubanRecommendApiResponse {
  total: number;
  items: Array<{
    id: string;
    title: string;
    year: string;
    type: string;
    pic: {
      large: string;
      normal: string;
    };
    rating: {
      value: number;
    };
  }>;
}

export const runtime = 'edge';

function buildCacheHeaders(cacheTime: number) {
  const staleTime = Math.max(cacheTime, 300);
  const edgeValue = `public, s-maxage=${cacheTime}, stale-while-revalidate=${staleTime}, stale-if-error=86400`;

  return {
    'Cache-Control': `public, max-age=${cacheTime}, ${edgeValue.replace('public, ', '')}`,
    'CDN-Cache-Control': edgeValue,
    'Vercel-CDN-Cache-Control': edgeValue,
    'Netlify-Vary': 'query',
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const kind = searchParams.get('kind');
  const pageLimit = parseInt(searchParams.get('limit') || '20');
  const pageStart = parseInt(searchParams.get('start') || '0');
  const category =
    searchParams.get('category') === 'all' ? '' : searchParams.get('category');
  const format =
    searchParams.get('format') === 'all' ? '' : searchParams.get('format');
  const region =
    searchParams.get('region') === 'all' ? '' : searchParams.get('region');
  const year =
    searchParams.get('year') === 'all' ? '' : searchParams.get('year');
  const platform =
    searchParams.get('platform') === 'all' ? '' : searchParams.get('platform');
  const sort = searchParams.get('sort') === 'T' ? '' : searchParams.get('sort');
  const label =
    searchParams.get('label') === 'all' ? '' : searchParams.get('label');

  if (!kind) {
    return NextResponse.json({ error: '缺少必要参数: kind' }, { status: 400 });
  }

  if (!['movie', 'tv'].includes(kind)) {
    return NextResponse.json(
      { error: 'kind 参数必须是 movie 或 tv' },
      { status: 400 }
    );
  }

  if (pageLimit < 1 || pageLimit > 100 || pageStart < 0) {
    return NextResponse.json({ error: '分页参数无效' }, { status: 400 });
  }

  const selectedCategories = { 类型: category } as any;
  if (format) selectedCategories['形式'] = format;
  if (region) selectedCategories['地区'] = region;

  const tags: string[] = [];
  if (category) tags.push(category);
  if (!category && format) tags.push(format);
  if (label) tags.push(label);
  if (region) tags.push(region);
  if (year) tags.push(year);
  if (platform) tags.push(platform);

  const baseUrl = `https://m.douban.com/rexxar/api/v2/${kind}/recommend`;
  const params = new URLSearchParams();
  params.append('refresh', '0');
  params.append('start', pageStart.toString());
  params.append('count', pageLimit.toString());
  params.append('selected_categories', JSON.stringify(selectedCategories));
  params.append('uncollect', 'false');
  params.append('score_range', '0,10');
  params.append('tags', tags.join(','));
  if (sort) params.append('sort', sort);

  const target = `${baseUrl}?${params.toString()}`;

  try {
    const doubanData = await fetchDoubanData<DoubanRecommendApiResponse>(target);
    const list = doubanData.items
      .filter((item) => item.type === 'movie' || item.type === 'tv')
      .map((item) => ({
        id: item.id,
        title: item.title,
        poster: item.pic?.large || item.pic?.normal || '',
        rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
        year: item.year,
      }));

    const response: DoubanResult = {
      code: 200,
      message: '获取成功',
      list,
    };

    const cacheTime = await getCacheTime();
    return NextResponse.json(response, {
      headers: buildCacheHeaders(cacheTime),
    });
  } catch (error) {
    console.error('获取豆瓣推荐数据失败:', error);
    return NextResponse.json(
      { error: '获取豆瓣数据失败', details: (error as Error).message },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
