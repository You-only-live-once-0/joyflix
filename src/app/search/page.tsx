/* eslint-disable react-hooks/exhaustive-deps, @typescript/eslint-no-explicit-any */
'use client';

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, Search, X, Trash2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';

import {
  addSearchHistory,
  clearSearchHistory,
  deleteSearchHistory,
  getSearchHistory,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { DoubanResult, SearchResult } from '@/lib/types';


import PageLayout from '@/components/PageLayout';
import SearchSuggestions from '@/components/SearchSuggestions';
import VideoCard from '@/components/VideoCard';
import VideoCardSkeleton from '@/components/VideoCardSkeleton';

const SearchPageClient: React.FC = () => {
  // 搜索历史
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  // 返回顶部按钮显示状态
  const [showBackToTop, setShowBackToTop] = useState(false);

  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false); // 新增：追踪流状态
  const [showResults, setShowResults] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [recommendedSearches, setRecommendedSearches] = useState<
    DoubanResult['list']
  >([]);
  const [isRecommendationsLoading, setIsRecommendationsLoading] = useState(true);
  const activeSearchControllerRef = useRef<AbortController | null>(null);
  const searchRequestIdRef = useRef(0);
  
  // 聚合后的结果（按标题和年份分组）
  const aggregatedResults = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    searchResults.forEach((item) => {
      // 使用 title + year 作为键进行聚合，year 必然存在，但依然兜底 'unknown'
      const key = `${item.title.replaceAll(' ', '')}-${
        item.year || 'unknown'
      }`;
      const arr = map.get(key) || [];
      arr.push(item);
      map.set(key, arr);
    });
    return Array.from(map.entries()).sort((a, b) => {
      const normalizedSearchQuery = searchQuery.trim().replaceAll(' ', '');
      const aTitleNormalized = a[1][0].title.replaceAll(' ', '');
      const bTitleNormalized = b[1][0].title.replaceAll(' ', '');

      // 新增首要排序：标题与搜索词完全一致的排在最前面
      const aPerfectMatch = aTitleNormalized === normalizedSearchQuery;
      const bPerfectMatch = bTitleNormalized === normalizedSearchQuery;

      if (aPerfectMatch && !bPerfectMatch) return -1;
      if (!aPerfectMatch && bPerfectMatch) return 1;

      // 次要排序：标题包含搜索词
      const aContainsMatch = aTitleNormalized.includes(normalizedSearchQuery);
      const bContainsMatch = bTitleNormalized.includes(normalizedSearchQuery);

      if (aContainsMatch && !bContainsMatch) return -1;
      if (!aContainsMatch && bContainsMatch) return 1;

      // 年份排序
      if (a[1][0].year === b[1][0].year) {
        return a[0].localeCompare(b[0]);
      } else {
        // 处理 unknown 的情况
        const aYear = a[1][0].year;
        const bYear = b[1][0].year;

        if (aYear === 'unknown' && bYear === 'unknown') {
          return 0;
        } else if (aYear === 'unknown') {
          return 1; // a 排在后面
        } else if (bYear === 'unknown') {
          return -1; // b 排在后面
        } else {
          // 都是数字年份，按数字大小排序（大的在前面）
          return aYear > bYear ? -1 : 1;
        }
      }
    });
  }, [searchResults, searchQuery]);

  useEffect(() => {
    // 初始加载搜索历史
    getSearchHistory().then(setSearchHistory);

    // 监听搜索历史更新事件
    const unsubscribe = subscribeToDataUpdates(
      'searchHistoryUpdated',
      (newHistory: string[]) => {
        setSearchHistory(newHistory);
      }
    );

    // 获取滚动位置的函数 - 专门针对 body 滚动
    const getScrollTop = () => {
      return document.body.scrollTop || 0;
    };

    // 监听 body 元素的滚动事件
    const handleScroll = () => {
      const scrollTop = getScrollTop();
      setShowBackToTop(scrollTop > 300);
    };

    document.body.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      unsubscribe();
      // 移除 body 滚动事件监听器
      document.body.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => {
    // 获取推荐
    const fetchRecommended = async () => {
      try {
        console.log('[SearchPageClient] Attempting to fetch recommendations from /api/recommendations');
        const response = await fetch('/api/recommendations');

        const data = response.ok ? await response.json() : { list: [] };

        // The new API already returns a shuffled and sliced list of titles
        setRecommendedSearches(data.list.map((title: string) => ({ id: title, title: title })));
      } catch (error) {
        console.error('Failed to fetch recommended searches:', error);
      } finally {
        setIsRecommendationsLoading(false);
      }
    };

    fetchRecommended();
  }, []);

  useEffect(() => {
    // 当搜索参数变化时更新搜索状态
    const query = searchParams.get('q');
    if (query) {
      setSearchQuery(query);
      fetchSearchResults(query);
      setShowSuggestions(false);

      // 保存到搜索历史 (事件监听会自动更新界面)
      addSearchHistory(query);
    } else {
      searchRequestIdRef.current += 1;
      activeSearchControllerRef.current?.abort();
      activeSearchControllerRef.current = null;
      setShowResults(false);
      setShowSuggestions(false);
    }
  }, [searchParams]);

  const fetchSearchResults = async (query: string) => {
    const requestId = ++searchRequestIdRef.current;
    activeSearchControllerRef.current?.abort();
    const controller = new AbortController();
    activeSearchControllerRef.current = controller;

    try {
      // 立即设置加载和显示状态，清空旧结果
      setIsLoading(true);
      setIsStreaming(true); // 开始流
      setShowResults(true);
      setSearchResults([]);

      const response = await fetch(
        `/api/searchstream?q=${encodeURIComponent(query.trim())}`,
        { signal: controller.signal }
      );

      if (!response.body) {
        throw new Error('Streaming not supported');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let hasSetLoadingFalse = false; // 标记是否已关闭骨架屏

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        buffer = lines.pop() || '';

        if (requestId !== searchRequestIdRef.current) {
          await reader.cancel();
          return;
        }

        for (const line of lines) {
          if (line.trim() === '') continue;
          try {
            const newResultsChunk: SearchResult[] = JSON.parse(line);

            let filteredResults = newResultsChunk.filter((result) => {
              const lowerCaseQuery = query.trim().toLowerCase();
              const lowerCaseTitle = result.title.toLowerCase();
              return lowerCaseTitle.includes(lowerCaseQuery);
            });

            const filterKeywords = ['电影解说', '剧情解说', '预告片', '解说'];
            filteredResults = filteredResults.filter(
              (result) =>
                !filterKeywords.some((keyword) => result.title.includes(keyword))
            );

            if (filteredResults.length > 0) {
              // 收到第一个有效数据块后，立即关闭骨架屏
              if (!hasSetLoadingFalse) {
                setIsLoading(false);
                hasSetLoadingFalse = true;
              }

              // 聚合结果会在 useMemo 中统一排序；这里仅追加，避免每个流式分块都对全量结果重新排序。
              setSearchResults((prevResults) => {
                const existing = new Set(
                  prevResults.map((item) => `${item.source}:${item.id}`)
                );
                const uniqueNew = filteredResults.filter((item) => {
                  const key = `${item.source}:${item.id}`;
                  if (existing.has(key)) return false;
                  existing.add(key);
                  return true;
                });
                return [...prevResults, ...uniqueNew];
              });
            }
          } catch (e) {
            console.error('Error parsing streaming JSON', e);
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestId === searchRequestIdRef.current) {
        console.error('Search failed:', error);
        setSearchResults([]);
      }
    } finally {
      // 旧请求结束时不能关闭新请求的加载状态。
      if (requestId === searchRequestIdRef.current) {
        setIsLoading(false);
        setIsStreaming(false);
        activeSearchControllerRef.current = null;
      }
    }
  };

  // 输入框内容变化时触发，显示搜索建议
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);

    if (value.trim()) {
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
    }
  };

  // 搜索框聚焦时触发，显示搜索建议
  const handleInputFocus = () => {
    if (searchQuery.trim()) {
      setShowSuggestions(true);
    }
  };

  // 搜索表单提交时触发，处理搜索逻辑
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim().replace(/\s+/g, ' ');
    if (!trimmed) return;

    // 回显搜索框
    setSearchQuery(trimmed);
    setIsLoading(true);
    setShowResults(true);
    setShowSuggestions(false);

    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
    // 保存到搜索历史 (事件监听会自动更新界面)
    addSearchHistory(trimmed);
  };

  const handleSuggestionSelect = (suggestion: string) => {
    setSearchQuery(suggestion);
    setShowSuggestions(false);

    // 自动执行搜索
    setIsLoading(true);
    setShowResults(true);

    router.push(`/search?q=${encodeURIComponent(suggestion)}`);
    addSearchHistory(suggestion);
  };

  // 返回顶部功能
  const scrollToTop = () => {
    try {
      // 根据调试结果，真正的滚动容器是 document.body
      document.body.scrollTo({
        top: 0,
        behavior: 'smooth',
      });
    } catch (error) {
      // 如果平滑滚动完全失败，使用立即滚动
      document.body.scrollTop = 0;
    }
  };

  return (
    <PageLayout activePath="/search">
      <div className="px-4 sm:px-10 py-4 sm:py-8 pt-5 overflow-visible mb-10">
        {/* 搜索框 */}
        <div className="mb-8">
          <form onSubmit={handleSearch} className="max-w-2xl mx-auto">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 dark:text-gray-500 z-10" />
              <input
                id="searchInput"
                type="text"
                value={searchQuery}
                onChange={handleInputChange}
                onFocus={handleInputFocus}
                placeholder="剧荒别犯难，好剧搜出来～"
                className="w-full h-12 rounded-full bg-white/50 backdrop-blur-md py-3 pl-10 pr-4 text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:bg-white/80 border border-gray-200/50 shadow-sm dark:bg-gray-800/50 dark:text-gray-300 dark:placeholder-gray-500 dark:focus:bg-gray-700/80 dark:border-gray-700"
              />

              {/* 搜索建议 */}
              <SearchSuggestions
                query={searchQuery}
                isVisible={showSuggestions}
                onSelect={handleSuggestionSelect}
                onClose={() => setShowSuggestions(false)}
              />
            </div>
          </form>
        </div>

        {/* 搜索结果或搜索历史 */}
        <div className="max-w-[96%] mx-auto mt-12 overflow-visible">
          {searchParams.get('q') ? (
            <section className="mb-12">
              {/* 标题 + 统计 + 加载圈 */}
              <div className="mb-8 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="text-xl font-bold text-gray-800 dark:text-gray-200">
                    搜索结果
                  </h2>
                  {isStreaming && !isLoading && (
                    <div
                      className="w-5 h-5 border-2 border-gray-200 dark:border-gray-600 border-t-blue-400 rounded-full animate-spin"
                      role="status"
                    >
                      <span className="sr-only">加载中...</span>
                    </div>
                  )}
                </div>

              </div>
              {isLoading ? (
                <div className="justify-start grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8">
                  {Array.from({ length: 12 }).map((_, index) => (
                    <VideoCardSkeleton 
                      key={index} 
                      className="w-full"
                      showYear={true}
                    />
                  ))}
                </div>
              ) : (
                <div
                  key="search-results-aggregated"
                  className="justify-start grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8"
                >
                  {aggregatedResults.map(([mapKey, group]) => {
                        return (
                          <div key={`agg-${mapKey}`} className="w-full">
                            <VideoCard
                              from="search"
                              items={group}
                              query={
                                searchQuery.trim() !== group[0].title
                                  ? searchQuery.trim()
                                  : ''
                              }
                            />
                          </div>
                        );
                      })}
                  {searchResults.length === 0 && !isStreaming && (
                    <div className="col-span-full text-center text-gray-500 py-8 dark:text-gray-400">
                      未找到相关结果
                    </div>
                  )}
                </div>
              )}
            </section>
          ) : (
            <>
              {searchHistory.length > 0 && (
                <section className="mb-12">
                  <h2 className="mb-4 text-xl font-bold text-gray-800 text-left dark:text-gray-200 flex items-center"> {/* Added flex items-center */}
                    搜索历史
                    {searchHistory.length > 0 && (
                      <button
                        onClick={() => {
                          clearSearchHistory(); // 事件监听会自动更新界面
                        }}
                        className="ml-3" // Keep margin
                      >
                        <Trash2
                          size={20}
                          className='text-gray-500 dark:text-gray-400 transition-all duration-300 ease-out hover:stroke-red-500 hover:scale-[1.1]'
                        />
                      </button>
                    )}
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {searchHistory.map((item) => (
                      <div key={item} className="relative group">
                        <button
                          onClick={() => {
                            setSearchQuery(item);
                            router.push(
                              `/search?q=${encodeURIComponent(item.trim())}`
                            );
                          }}
                          className="px-4 py-2 bg-gray-500/10 hover:bg-gray-300 rounded-full text-sm text-gray-700 transition-colors duration-200 dark:bg-gray-700/50 dark:hover:bg-gray-600 dark:text-gray-300"
                        >
                          {item}
                        </button>
                        {/* 删除按钮 */}
                        <button
                          aria-label="删除搜索历史"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            deleteSearchHistory(item); // 事件监听会自动更新界面
                          }}
                          className="absolute -top-1 -right-1 w-4 h-4 opacity-0 group-hover:opacity-100 bg-gray-400 hover:bg-red-500 text-white rounded-full flex items-center justify-center text-[10px] transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <section className="mb-12">
                <h2 className="mb-4 text-xl font-bold text-gray-800 text-left dark:text-gray-200">
                  热门推荐
                </h2>
                {isRecommendationsLoading ? (
                  <div className="flex flex-wrap gap-2">
                    {[...Array(6)].map((_, index) => (
                      <div
                        key={index}
                        className="px-4 py-2 bg-gray-500 rounded-full text-sm text-transparent animate-pulse dark:bg-gray-400 w-24 h-9"
                      ></div>
                    ))}
                  </div>
                ) : recommendedSearches.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {recommendedSearches.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => {
                          setSearchQuery(item.title);
                          router.push(
                            `/search?q=${encodeURIComponent(item.title.trim())}`
                          );
                        }}
                        className="px-4 py-2 bg-gray-500/10 hover:bg-gray-300 rounded-full text-sm text-gray-700 transition-colors duration-200 dark:bg-gray-700/50 dark:hover:bg-gray-600 dark:text-gray-300"
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="text-gray-500 dark:text-gray-400">
                    暂无推荐
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        {/* 返回顶部悬浮按钮 */}
        <button
          onClick={scrollToTop}
          className={`fixed bottom-20 md:bottom-6 right-6 z-[500] w-12 h-12 bg-blue-400/90 hover:bg-blue-400 text-white rounded-full shadow-lg backdrop-blur-sm transition-all duration-300 ease-in-out flex items-center justify-center group ${
            showBackToTop
              ? 'opacity-100 translate-y-0 pointer-events-auto'
              : 'opacity-0 translate-y-4 pointer-events-none'
          }`}
          aria-label="返回顶部"
        >
          <ChevronUp className="w-6 h-6 transition-transform group-hover:scale-110" />
        </button>
      </div>
    </PageLayout>
  );
};

const SearchPage: React.FC = () => {
  return (
    <Suspense>
      <SearchPageClient />
    </Suspense>
  );
};

export default SearchPage;
