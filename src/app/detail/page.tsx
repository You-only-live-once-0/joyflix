
/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console */

'use client';

import { Heart, PlayCircle, Star, Video } from 'lucide-react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePathname } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import PageLayout from '@/components/PageLayout';
import RecommendationSection from '@/components/RecommendationSection';
import CelebritiesSection from '@/components/CelebritiesSection';
import ConfirmationDialog from '@/components/ConfirmationDialog';
import {
  deleteFavorite,
  isFavorited as checkIfFavorited,
  saveFavorite,
  subscribeToDataUpdates,
  deleteFavoriteByTitle,
} from '@/lib/db.client';
import { Favorite, SearchResult } from '@/lib/types';
import { processImageUrl } from '@/lib/utils';
import { useIsTablet } from '@/lib/useIsTablet';


function DetailPageClient() {
  const [instanceId] = useState(() => Date.now().toString());
  const [isMobile, setIsMobile] = useState(false); // 用于移动端检测的新状态

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(typeof window !== 'undefined' && window.innerWidth < 768);
    };

    checkMobile(); // 组件挂载时检查
    window.addEventListener('resize', checkMobile); // 窗口大小改变时更新

    return () => {
      window.removeEventListener('resize', checkMobile); // 清理
    };
  }, []); // 组件挂载时仅运行一次
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const isTablet = useIsTablet();

  const doubanId = searchParams.get('doubanId');
  const rate = searchParams.get('rate');

  const fetchDoubanMovieData = async (id: string) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000); // 6秒超时

      const response = await fetch(`/api/douban/movie/${id}`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`Douban movie API error for doubanId ${id}: ${response.statusText}`);
        return null;
      }

      const data = await response.json();
      return data;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn(`Douban movie API request timed out for doubanId ${id}`);
      } else {
        console.error(`Error fetching from Douban movie API for doubanId ${id}:`, error);
      }
      return null;
    }
  };

  const fetchWMDBData = async (id: string) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000); // 6秒超时

      const response = await fetch(`/api/wmdb?id=${id}`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`WMDB API proxy error for doubanId ${id}: ${response.statusText}`);
        return null;
      }

      const data = await response.json();
      return data;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn(`WMDB API proxy request timed out for doubanId ${id}`);
      } else {
        console.error(`Error fetching from WMDB API proxy for doubanId ${id}:`, error);
      }
      return null;
    }
  };



  const source = searchParams.get('source');
  const id = searchParams.get('id');
  const title = searchParams.get('title');
  const year = searchParams.get('year');
  const initialPoster = searchParams.get('poster');
  const initialClass = searchParams.get('class');
  const initialDesc = searchParams.get('desc');

  // 使用 searchParams 中可用的任何数据初始化详情
  const [detail, setDetail] = useState<SearchResult | null>(() => {
    // 如果 initialPoster 可用，则优先使用，并初始化其他字段
    if (source || id || title) { // 检查是否存在任何基本参数以初始化详情
      return {
        id: id || '',
        source: source || '',
        title: title || '',
        year: year || undefined,
        poster: initialPoster || '', // 如果存在 initialPoster 则始终使用，否则为空
        class: initialClass || undefined,
        desc: initialDesc || undefined,
        episodes: [],
        episodes_titles: [],
        source_name: '',
      } as SearchResult;
    }
    return null;
  });

  const [isLoadingApi, setIsLoadingApi] = useState(false); // 指示API调用是否正在进行中
  const [error, setError] = useState<string | null>(null);

  const [isFavorited, setIsFavorited] = useState(false);
  const [isFavoriting, setIsFavoriting] = useState(false); // 在异步操作期间禁用按钮时保留此状态
  const [allFavorites, setAllFavorites] = useState<Record<string, Favorite>>({});
  const [showTrailerConfirmDialog, setShowTrailerConfirmDialog] = useState(false);
  const [showNoTrailerDialog, setShowNoTrailerDialog] = useState(false);

  const handleConfirmTrailer = () => {
    if (detail?.trailerUrl) {
      window.open(detail.trailerUrl, '_blank');
    }
    setShowTrailerConfirmDialog(false);
  };

  // 在组件挂载和详情更改时检查收藏状态
  useEffect(() => {
    if (!detail?.title) return;

    const fetchFavoriteStatus = async () => {
      try {
        // 获取整个收藏列表
        const response = await fetch('/api/favorites');
        if (!response.ok) {
          throw new Error('Failed to fetch favorites');
        }
        const favorites: Record<string, Favorite> = await response.json();
        setAllFavorites(favorites); // 将所有收藏存储在状态中

        // 检查是否有任何收藏具有相同的标题
        const isAlreadyFavoritedByTitle = Object.values(favorites).some(
          (fav) => fav.title === detail.title
        );

        setIsFavorited(isAlreadyFavoritedByTitle);
      } catch (err) {
        console.error('Failed to check favorite status', err);
      }
    };

    fetchFavoriteStatus();

    // 我们仍然订阅更新以立即反映此页面上所做的更改
    const unsubscribe = subscribeToDataUpdates(
      'favoritesUpdated',
      (newFavorites: Record<string, any>) => {
        setAllFavorites(newFavorites); // 更新时更新状态中的所有收藏
        const isNowFavoritedByTitle = Object.values(newFavorites).some(
          (fav) => fav.title === detail.title
        );
        setIsFavorited(isNowFavoritedByTitle);
      }
    );

    return () => unsubscribe(); // 清理订阅
  }, [detail]);

  useEffect(() => {
    const fetchData = async () => {
      setIsLoadingApi(true);
      setError(null);

      try {
        let videoDetailToSet: SearchResult | null = null;
        let doubanDataFetched = false;
        let wmdbDataFetched = false;

        if (doubanId) {
          const doubanData = await fetchDoubanMovieData(doubanId);
          if (doubanData) {
            videoDetailToSet = {
              id: id || '',
              source: source || '',
              title: title || doubanData.title || '',
              year: doubanData.year || year || undefined,
              poster: initialPoster || (doubanData.recommendations && doubanData.recommendations[0] && doubanData.recommendations[0].likeposter) || '',
              class: doubanData.genre || initialClass || undefined,
              desc: doubanData.description || initialDesc || undefined,
              country: doubanData.country || undefined,
              recommendations: doubanData.recommendations || [],
              trailerUrl: doubanData.trailerUrl || undefined,
              celebrities: doubanData.celebrities || [],
              episodes: [],
              episodes_titles: [],
              source_name: '',
            } as SearchResult;
            doubanDataFetched = true;
          }
        }

        if (!doubanDataFetched && doubanId) {
          const wmdbData = await fetchWMDBData(doubanId);
          
          if (wmdbData && wmdbData.data && wmdbData.data.length > 0) {
            const movieData = wmdbData.data[0]; // 假设第一项是相关的
            
            
            videoDetailToSet = {
              id: id || '', // 保留现有ID或为空
              source: source || '', // 保留现有来源或为空
              title: title || movieData.name || '', // 优先使用现有标题，然后是WMDB名称
              year: wmdbData.year || year || undefined, // 优先使用WMDB年份，然后是现有年份
              poster: initialPoster || movieData.poster || '', // Prioritize existing poster, then WMDB poster
              class: movieData.genre
                ? Array.isArray(movieData.genre)
                  ? movieData.genre.join(', ')
                  : String(movieData.genre)
                : initialClass || undefined, // WMDB类型，然后是现有类别
              desc: movieData.description || initialDesc || undefined, // WMDB描述，然后是现有描述
              country: movieData.country || undefined, // WMDB国家
              episodes: [], // WMDB未提供，保持为空
              episodes_titles: [], // WMDB未提供，保持为空
              source_name: '', // Not provided by WMDB, keep empty
            } as SearchResult;
            wmdbDataFetched = true;
          }
        }

        // 如果未获取到WMDB数据或不存在doubanId，则回退到现有逻辑
        if (!doubanDataFetched && !wmdbDataFetched) {
          // 场景1：我们有source和id。获取完整详情。
          if (source && id) {
            const detailResponse = await fetch(
              `/api/detail?source=${source}&id=${id}`
            );
            if (!detailResponse.ok) {
              throw new Error(`获取视频详情失败: ${detailResponse.statusText}`);
            }
            const fetchedDetail = await detailResponse.json();
            videoDetailToSet = fetchedDetail ? { ...fetchedDetail } : null;

            // 如果提供了初始海报，则保留它
            if (initialPoster && videoDetailToSet) {
              videoDetailToSet.poster = initialPoster;
            }
          }
          // 如果我们没有source/id，但已经有了描述，
          // 那么我们认为数据足够，不需要调用流API。
          else if (detail?.desc) {
            videoDetailToSet = detail;
          }
          // 场景2：我们只有一个标题。搜索它。
          else if (title) {
            const searchResponse = await fetch(
              `/api/search/stream?q=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`
            );
            if (!searchResponse.ok) {
              throw new Error(`搜索视频源失败: ${searchResponse.statusText}`);
            }
            const foundVideoDetail = await searchResponse.json();

            if (!foundVideoDetail) {
              throw new Error('未找到任何相关的视频源');
            }

            videoDetailToSet = foundVideoDetail ? { ...foundVideoDetail } : null;

            // 如果提供了初始海报，则保留它
            if (initialPoster && videoDetailToSet) {
              videoDetailToSet.poster = initialPoster;
            }
          }
          else {
            // 没有source/id，也没有标题。
            // 组件已经处理了detail为null的情况。
            return;
          }
        }

        if (!videoDetailToSet) {
          throw new Error('无法获取视频详情');
        }

        setDetail(prevDetail => {
          if (!videoDetailToSet) {
            return prevDetail; // 由于之前的检查，这不应该发生，但为了安全起见
          }

          // 基于prevDetail或默认SearchResult结构初始化newDetail
          const newDetail: SearchResult = prevDetail
            ? { ...prevDetail }
            : { // 如果prevDetail为null，则为默认SearchResult结构
                id: '',
                source: '',
                title: '',
                year: '',
                poster: '',
                class: '',
                desc: '',
                episodes: [],
                episodes_titles: [],
                source_name: '',
              };

          // 始终从videoDetailToSet更新核心标识符，确保它们是字符串
          // 如果videoDetailToSet.field存在且为真值，则使用它，否则保留newDetail.field
          newDetail.id = videoDetailToSet.id || newDetail.id;
          newDetail.source = videoDetailToSet.source || newDetail.source;
          newDetail.title = videoDetailToSet.title || newDetail.title;
          newDetail.source_name = videoDetailToSet.source_name || newDetail.source_name;

          // 仅当prevDetail中“缺少”可选字段时才会有条件地更新它们
          // 对于字符串，“缺少”表示null、undefined或空字符串
          if (!newDetail.year && videoDetailToSet.year) newDetail.year = videoDetailToSet.year;
          if (!newDetail.poster && videoDetailToSet.poster) newDetail.poster = videoDetailToSet.poster;
          if (!newDetail.class && videoDetailToSet.class) newDetail.class = videoDetailToSet.class;
          if (!newDetail.desc && videoDetailToSet.desc) newDetail.desc = videoDetailToSet.desc;
          if (!newDetail.country && videoDetailToSet.country) newDetail.country = videoDetailToSet.country;
          if ((!newDetail.recommendations || newDetail.recommendations.length === 0) && videoDetailToSet.recommendations && videoDetailToSet.recommendations.length > 0) {
            newDetail.recommendations = videoDetailToSet.recommendations;
          }
          // 添加此块
          if ((!newDetail.celebrities || newDetail.celebrities.length === 0) && videoDetailToSet.celebrities && videoDetailToSet.celebrities.length > 0) {
            newDetail.celebrities = videoDetailToSet.celebrities;
          }
          if (!newDetail.trailerUrl && videoDetailToSet.trailerUrl) {
            newDetail.trailerUrl = videoDetailToSet.trailerUrl;
          }

          // 对于数组，“缺少”表示null、undefined或空数组
          if ((!newDetail.episodes || newDetail.episodes.length === 0) && videoDetailToSet.episodes && videoDetailToSet.episodes.length > 0) {
            newDetail.episodes = videoDetailToSet.episodes;
          }
          if ((!newDetail.episodes_titles || newDetail.episodes_titles.length === 0) && videoDetailToSet.episodes_titles && videoDetailToSet.episodes_titles.length > 0) {
            newDetail.episodes_titles = videoDetailToSet.episodes_titles;
          }

          return newDetail;
        });
      } catch (err: any) {
        setError(err.message);
        console.error(err);
      } finally {
        setIsLoadingApi(false);
      }
    };

    fetchData();
  }, [source, id, title, year, initialPoster, doubanId]);

  

  

  const handlePlay = () => {
    if (!detail) return;

    const playParams = new URLSearchParams();

    // 详情页即使最初只有 title/year，也可能已经通过流式搜索解析出了
    // 可用的 source/id。优先把解析结果带到播放页，避免播放页再次全源搜索，
    // 从而减少第三方片源瞬时超时导致的“未找到匹配结果”。
    if (detail.source && detail.id) {
      playParams.set('source', detail.source);
      playParams.set('id', detail.id);
      playParams.set('title', detail.title);
      if (detail.year) {
        playParams.set('year', detail.year);
      }

      const stitle = searchParams.get('stitle');
      if (stitle) {
        playParams.set('stitle', stitle);
      }
    } else {
      const originalTitle = searchParams.get('title');
      const originalYear = searchParams.get('year');
      if (originalTitle) {
        playParams.set('title', originalTitle);
      }
      if (originalYear) {
        playParams.set('year', originalYear);
      }
    }

    router.push(`/play?${playParams.toString()}`);
  };

  const handleFavorite = useCallback(async () => {
    if (!detail?.title) return;

    setIsFavoriting(true);
    setError(null);

    try {
      if (isFavorited) {
        // 项目已被收藏，因此取消收藏
        // 按标题查找确切的收藏条目，然后使用其键删除
        const favoritedEntryKey = Object.keys(allFavorites).find(key => allFavorites[key].title === detail.title);

        if (favoritedEntryKey) {
          // 键的格式为 "source+id"
          const [sourceToDelete, idToDelete] = favoritedEntryKey.split('+');
          await deleteFavorite(sourceToDelete, idToDelete); // 使用更通用的deleteFavorite
        } else {
          // 后备方案：如果由于某种原因未找到键，请尝试按标题删除
          // 如果收藏是使用未使用source+id的另一种机制添加的，或者如果allFavorites状态未完全同步，则可能会发生这种情况。
          await deleteFavoriteByTitle(detail.title);
        }
      } else {
        // 项目未被收藏，因此收藏它
        const favoriteData = {
          title: detail.title,
          source_name: '收藏',
          year: detail.year || '',
          cover: detail.poster || '',
          total_episodes: 1,
          save_time: Date.now(),
          doubanId: doubanId || undefined, // 在此处添加doubanId
        };
        // 保存时，我们仍使用 'title_based' 和 detail.title 作为 source 和 id
        // 以保持从此页面发起的收藏的一致性。
        await saveFavorite('title_based', detail.title, favoriteData);
      }
    } catch (err: any) {
      console.error('收藏/取消收藏操作失败', err);
      setError(err.message || '收藏/取消收藏操作失败');
    } finally {
      setIsFavoriting(false);
    }
  }, [detail, isFavorited, allFavorites]);

  

  if (error) {
    return (
      <PageLayout activePath={pathname}>
        <div className='container mx-auto px-4 sm:px-6 lg:px-8 py-8'>

          <div className='flex items-center justify-center min-h-[calc(100vh-200px)]'>
            <div className='text-center text-red-500'>
              <h2 className='text-2xl font-bold mb-2'>加载失败</h2>
              <p>{error}</p>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  // 如果detail为null且我们没有加载，则意味着我们甚至无法使用基本参数进行初始化
  if (!detail && !isLoadingApi) {
    return (
      <PageLayout activePath={pathname}>
        <div className='container mx-auto px-4 sm:px-6 lg:px-8 py-8'>

          <div className='flex items-center justify-center min-h-[calc(100vh-200px)]'>
            <div className='text-center text-gray-500 dark:text-gray-400'>
              <h2 className='text-2xl font-bold mb-2'>未找到视频详情</h2>
              <p>请检查您的查询参数。</p>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout activePath={pathname}>
      <div className={`max-w-[96%] mx-auto px-4 sm:px-10 lg:px-8 pb-8 relative ${isTablet ? 'pt-14' : ''} ${isMobile ? 'pt-4' : 'pt-8'}`}>
        
        <div className={`grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-8 ${!isMobile ? 'pt-10' : 'pt-0'}`}>
          <div className='md:col-span-1 lg:col-span-1'>
            <div className='relative aspect-[2/3] w-full rounded-lg overflow-hidden shadow-2xl'>
              {initialPoster || detail?.poster ? (
                <>
                  <Image
                    src={processImageUrl(initialPoster || detail?.poster || '')}
                    alt={detail?.title || 'Video Poster'}
                    fill
                    className='object-cover'
                    referrerPolicy='no-referrer'
                  />
                  
                </>
              ) : (isLoadingApi ? <div className='w-full h-full bg-gray-500 dark:bg-gray-400 animate-pulse'></div> : null)}
            </div>
          </div>

          <div className='md:col-span-2 lg:col-span-3 flex flex-col'>
            <div className='flex items-center gap-2 mb-3'>
              <h1 className='text-3xl sm:text-4xl font-bold text-gray-900 dark:text-gray-100'>
                {detail?.title ? detail.title : (isLoadingApi ? <div className='h-10 bg-gray-500 dark:bg-gray-400 rounded w-3/4 mb-3 animate-pulse'></div> : null)}
              </h1>
              {isMobile && (
                <button
                  onClick={handleFavorite}
                  className={`
                    flex items-center justify-center
                    w-10 h-10 rounded-full bg-transparent p-0
                  `}
                  disabled={isFavoriting}
                >
                  <Heart
                    size={24}
                    className={`transition-all duration-300 ease-out ${
                      isFavorited ? 'fill-red-500 stroke-red-500' : 'fill-transparent stroke-gray-600 dark:stroke-gray-300'
                    }`}
                  />
                </button>
              )}
            </div>

            <div className='flex flex-row flex-wrap items-center gap-x-2 sm:gap-x-4 gap-y-2 text-sm text-gray-500 dark:text-gray-400 mb-6'>
              {/* 豆瓣评分 - 第一 */}
              {rate && (
                <span className='px-2 py-1 border border-gray-400/60 rounded-md text-xs font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1'>
                  <Star size={14} className='fill-current text-yellow-400' />
                  {rate}
                </span>
              )}

              {/* 年份 - 第二 */}
              {detail?.year ? (
                <span className='px-2 py-1 border border-gray-400/60 rounded-md text-xs font-medium text-gray-600 dark:text-gray-300'>
                  {detail.year}
                </span>
              ) : (isLoadingApi ? <div className='h-6 bg-gray-500 dark:bg-gray-400 rounded w-16 animate-pulse'></div> : null)}

              {/* 类别 - 第三 */}
              {detail?.class ? (
                <span className='px-2 py-1 border border-gray-400/60 rounded-md text-xs font-medium text-gray-600 dark:text-gray-300'>
                  {detail.class}
                </span>
              ) : (isLoadingApi ? <div className='h-6 bg-gray-500 dark:bg-gray-400 rounded w-24 animate-pulse'></div> : null)}

              {/* 国家 - 第四 */}
              {detail?.country ? (
                <span className='px-2 py-1 border border-gray-400/60 rounded-md text-xs font-medium text-gray-600 dark:text-gray-300'>
                  {detail.country}
                </span>
              ) : (isLoadingApi ? <div className='h-6 bg-gray-500 dark:bg-gray-400 rounded w-24 animate-pulse'></div> : null)}
              
            </div>

            <div className='mb-6 flex flex-row items-center gap-4'>
              <button
                onClick={handlePlay}
                className='w-1/2 sm:w-auto flex items-center justify-center gap-2 px-8 py-4 bg-blue-350 bg-opacity-80 text-white font-bold rounded-lg shadow-lg hover:bg-blue-400 active:bg-blue-400 transition-all duration-300 transform hover:scale-105'
                disabled={!detail?.title || !detail?.year} // 只要有title和year值即可点击
              >
                <PlayCircle size={24} />
                <span className='whitespace-nowrap'>{isMobile ? '播放' : '立即播放'}</span>
              </button>
              {/* 新的预告片按钮 */}
              <button
                onClick={() => {
                  if (isLoadingApi) return; // 如果仍在加载，则不执行任何操作
                  if (detail?.trailerUrl && detail.trailerUrl.length > 0) {
                    setShowTrailerConfirmDialog(true);
                  } else {
                    setShowNoTrailerDialog(true);
                  }
                }}
                className='w-1/2 sm:w-auto flex items-center justify-center gap-2 px-8 py-4 bg-blue-350 bg-opacity-80 text-white font-bold rounded-lg shadow-lg hover:bg-blue-400 active:bg-blue-400 transition-all duration-300 transform hover:scale-105'
                disabled={isLoadingApi}
              >
                <Video size={24} />
                <span className='whitespace-nowrap'>预告</span>
              </button>
              
            {!isMobile && (
                <button
                  onClick={handleFavorite}
                  className={`w-1/2 flex items-center justify-center gap-2 px-8 py-4 bg-gray-400 sm:${isFavorited ? 'bg-gray-300' : 'bg-gray-400'} bg-opacity-80 text-white font-bold rounded-lg shadow-lg active:bg-gray-300 transition-all duration-300 transform sm:w-14 sm:h-14 sm:rounded-full sm:px-0 sm:py-0 md:hover:bg-gray-400 md:hover:scale-105`}
                  disabled={isFavoriting}
                >
                  <Heart
                    size={24}
                    className={`transition-all duration-300 ease-out ${
                      isFavorited ? 'fill-red-500 stroke-red-500' : 'fill-transparent stroke-white'
                    }`}
                  />
                  <span className='sm:hidden whitespace-nowrap'>{isFavorited ? '已收藏' : '收藏'}</span>
                </button>
              )}
            </div>
            <div className='flex-grow mb-6'>
              {detail?.desc ? (
                <p className='text-gray-700 dark:text-gray-300 leading-relaxed'>
                  {detail.desc}
                </p>
              ) : (isLoadingApi ? <div className='space-y-2'>
                  <div className='h-4 bg-gray-500 dark:bg-gray-400 rounded animate-pulse'></div>
                  <div className='h-4 bg-gray-500 dark:bg-gray-400 rounded w-5/6 animate-pulse'></div>
                  <div className='h-4 bg-gray-500 dark:bg-gray-400 rounded w-4/6 animate-pulse'></div>
                </div> : null)}
            </div>
          </div>
        </div>
        {/* 演职员表部分 */}
        {isLoadingApi && doubanId && (!detail?.celebrities || detail.celebrities.length === 0) ? (
          <div className='mt-8'>
            <div className='h-8 w-48 mb-4 bg-gray-500 dark:bg-gray-400 rounded animate-pulse'></div> {/* 标题占位符 */}
            <div className="flex overflow-x-auto space-x-4 pb-4 hide-scrollbar">
              {Array.from({ length: 9 }).map((_, index) => (
                <div key={index} className="flex-none w-32 sm:w-44 flex flex-col items-center text-center">
                  <div className="relative w-full aspect-[2/3] rounded-lg bg-gray-500 dark:bg-gray-400 animate-pulse mb-2"></div>
                  <div className="h-5 bg-gray-500 dark:bg-gray-400 rounded w-3/4 mb-1 animate-pulse"></div> {/* 将h-4更改为h-5 */}
                  <div className="h-4 bg-gray-500 dark:bg-gray-400 rounded w-1/2 animate-pulse"></div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          detail?.celebrities && detail.celebrities.length > 0 && (
            <CelebritiesSection celebrities={detail.celebrities} />
          )
        )}

        {/* 推荐部分 */}
        {isLoadingApi && doubanId && (!detail?.recommendations || detail.recommendations.length === 0) ? (
          <div className='mt-8'>
            <div className='h-8 w-48 mb-4 bg-gray-500 dark:bg-gray-400 rounded animate-pulse'></div> {/* 标题占位符 */}
            <div className="flex overflow-x-auto space-x-4 pb-4 hide-scrollbar">
              {Array.from({ length: 9 }).map((_, index) => (
                <div key={index} className="flex-none w-32 sm:w-44 flex flex-col items-center text-center">
                  <div className="relative w-full aspect-[2/3] rounded-lg bg-gray-500 dark:bg-gray-400 animate-pulse mb-2"></div>
                  <div className="h-5 bg-gray-500 dark:bg-gray-400 rounded w-3/4 mb-1 animate-pulse"></div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          detail?.recommendations && detail.recommendations.length > 0 && (
            <RecommendationSection recommendations={detail.recommendations} />
          )
        )}
        {/* 预告片确认对话框 */}
        <ConfirmationDialog
          isOpen={showTrailerConfirmDialog}
          onClose={() => setShowTrailerConfirmDialog(false)}
          onConfirm={handleConfirmTrailer}
          title="提示"
          message="是否转跳到豆瓣观看预告片？"
        />

        {/* 无预告片对话框 */}
        <ConfirmationDialog
          isOpen={showNoTrailerDialog}
          onClose={() => setShowNoTrailerDialog(false)}
          onConfirm={() => setShowNoTrailerDialog(false)} // 无需任何操作，只需关闭
          title="提示"
          message="暂无预告～"
          showCancelButton={false}
        />
      </div>
    </PageLayout>
  );
}

export default function DetailPage({ searchParams }: { searchParams: { [key: string]: string | string[] | undefined } }) {
  const key = JSON.stringify(searchParams);
  return (
    <Suspense>
      <DetailPageClient key={key} />
    </Suspense>
  );
}
