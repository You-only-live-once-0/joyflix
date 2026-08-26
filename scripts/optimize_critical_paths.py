from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"{path}: expected one match, got {count}: {old[:140]!r}"
        )
    p.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Player: direct source starts immediately; DB migration does not block failover;
# remove the artificial one-second ready delay.
# ---------------------------------------------------------------------------
play = "src/app/play/page.tsx"

replace_once(
    play,
    "    const fetchSourcesData = async (query: string): Promise<SearchResult[]> => {",
    """    const fetchSourcesData = async (
      query: string,
      updateState = true
    ): Promise<SearchResult[]> => {""",
)

replace_once(
    play,
    """        setAvailableSources(results);
        return results;
      } catch (err) {
        setSourceSearchError(err instanceof Error ? err.message : '搜索失败');
        setAvailableSources([]);
        return [];""",
    """        if (updateState) setAvailableSources(results);
        return results;
      } catch (err) {
        setSourceSearchError(err instanceof Error ? err.message : '搜索失败');
        if (updateState) setAvailableSources([]);
        return [];""",
)

replace_once(
    play,
    """      let sourcesInfo = await fetchSourcesData(searchTitle || videoTitle);
      if (
        currentSource &&
        currentId &&
        !sourcesInfo.some(
          (source) => source.source === currentSource && source.id === currentId
        )
      ) {
        sourcesInfo = await fetchSourceDetail(currentSource, currentId);
      }""",
    """      const queryTitle = searchTitle || videoTitle;
      let sourcesInfo: SearchResult[];

      if (currentSource && currentId && !needPreferRef.current) {
        // 指定明确片源时先请求该源详情，避免全源搜索阻塞首帧。
        sourcesInfo = await fetchSourceDetail(currentSource, currentId);
        const directSource = sourcesInfo[0];
        if (directSource && queryTitle.trim()) {
          window.setTimeout(() => {
            void fetchSourcesData(queryTitle, false).then((backgroundSources) => {
              const mergedSources = [
                directSource,
                ...backgroundSources.filter(
                  (source) =>
                    source.source !== directSource.source ||
                    source.id !== directSource.id
                ),
              ];
              setAvailableSources(mergedSources);
            });
          }, 1500);
        }
      } else {
        sourcesInfo = await fetchSourcesData(queryTitle);
        if (
          currentSource &&
          currentId &&
          !sourcesInfo.some(
            (source) => source.source === currentSource && source.id === currentId
          )
        ) {
          const directSource = await fetchSourceDetail(currentSource, currentId);
          if (directSource.length > 0) {
            const direct = directSource[0];
            sourcesInfo = [
              direct,
              ...sourcesInfo.filter(
                (source) =>
                  source.source !== direct.source || source.id !== direct.id
              ),
            ];
            setAvailableSources(sourcesInfo);
          }
        }
      }""",
)

replace_once(
    play,
    """      // 短暂延迟让用户看到完成状态
      setTimeout(() => {
        setLoading(false);
      }, 1000);""",
    """      // 已经拿到可播放详情后立即交给播放器，不人为增加 1 秒等待。
      setLoading(false);""",
)

replace_once(
    play,
    """      // 清除前一个历史记录
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deletePlayRecord(
            currentSourceRef.current,
            currentIdRef.current
          );
          console.log('已清除前一个播放记录');
        } catch (err) {
          console.error('清除播放记录失败:', err);
        }
      }

      // 清除并设置下一个跳过片头片尾配置
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deleteSkipConfig(
            currentSourceRef.current,
            currentIdRef.current
          );
          await saveSkipConfig(newSource, newId, skipConfigRef.current);
        } catch (err) {
          console.error('清除跳过片头片尾配置失败:', err);
        }
      }

      const newDetail = availableSources.find(
        (source) => source.source === newSource && source.id === newId
      );
      if (!newDetail) {
        setError('未找到匹配结果');
        return;
      }""",
    """      const newDetail = availableSources.find(
        (source) => source.source === newSource && source.id === newId
      );
      if (!newDetail) {
        setError('未找到匹配结果');
        return;
      }

      // 数据迁移不是播放关键路径。先切线路，再后台清理旧记录和迁移配置。
      if (currentSourceRef.current && currentIdRef.current) {
        const previousSource = currentSourceRef.current;
        const previousId = currentIdRef.current;
        const skipConfigToMigrate = { ...skipConfigRef.current };

        void deletePlayRecord(previousSource, previousId).catch((err) => {
          console.error('清除播放记录失败:', err);
        });

        void deleteSkipConfig(previousSource, previousId)
          .then(() => saveSkipConfig(newSource, newId, skipConfigToMigrate))
          .catch((err) => {
            console.error('迁移跳过片头片尾配置失败:', err);
          });
      }""",
)

# ---------------------------------------------------------------------------
# Search downstream: exact hit on page 1 stops pages 2-5; propagate client abort
# into public-media adapters.
# ---------------------------------------------------------------------------
downstream = "src/lib/downstream.ts"

replace_once(
    downstream,
    "    return searchPublicMedia(apiSite, query);",
    "    return searchPublicMedia(apiSite, query, externalSignal);",
)

replace_once(
    downstream,
    """    // 获取总页数
    const pageCount = data.pagecount || 1;
    // 确定需要获取的额外页数
    const pagesToFetch = Math.min(pageCount - 1, MAX_SEARCH_PAGES - 1);""",
    """    // 第一页已经精确命中标题时无需继续翻 2-5 页，减少第三方请求与等待。
    const pageCount = data.pagecount || 1;
    const normalizedQuery = query
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\\s+/g, '');
    const hasExactFirstPageMatch = results.some(
      (result) =>
        result.title.normalize('NFKC').toLowerCase().replace(/\\s+/g, '') ===
        normalizedQuery
    );
    const pagesToFetch = hasExactFirstPageMatch
      ? 0
      : Math.min(pageCount - 1, MAX_SEARCH_PAGES - 1);""",
)

# ---------------------------------------------------------------------------
# Public media adapters: stale search cancellation now aborts the actual remote
# request instead of merely discarding the eventual response.
# ---------------------------------------------------------------------------
public_media = "src/lib/public-media.ts"

replace_once(
    public_media,
    """async function fetchJson<T>(
  url: string,
  timeout = PUBLIC_MEDIA_TIMEOUT
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'JoyFlix/1.0 (+https://github.com/You-only-live-once-0/joyflix)',
      },
      next: { revalidate: 3600 },
    });

    if (!response.ok) {
      throw new Error(`Public media request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}""",
    """async function fetchJson<T>(
  url: string,
  timeout = PUBLIC_MEDIA_TIMEOUT,
  externalSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort();

  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  }

  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'JoyFlix/1.0 (+https://github.com/You-only-live-once-0/joyflix)',
      },
      next: { revalidate: 3600 },
    });

    if (!response.ok) {
      throw new Error(`Public media request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}""",
)

replace_once(
    public_media,
    """async function searchInternetArchive(
  apiSite: ApiSite,
  query: string
): Promise<SearchResult[]> {""",
    """async function searchInternetArchive(
  apiSite: ApiSite,
  query: string,
  externalSignal?: AbortSignal
): Promise<SearchResult[]> {""",
)

replace_once(
    public_media,
    "  }>(`${ARCHIVE_SEARCH_URL}?${params.toString()}`);",
    """  }>(
    `${ARCHIVE_SEARCH_URL}?${params.toString()}`,
    PUBLIC_MEDIA_TIMEOUT,
    externalSignal
  );""",
)

replace_once(
    public_media,
    """async function queryCommons(
  apiSite: ApiSite,
  params: URLSearchParams
): Promise<SearchResult[]> {""",
    """async function queryCommons(
  apiSite: ApiSite,
  params: URLSearchParams,
  externalSignal?: AbortSignal
): Promise<SearchResult[]> {""",
)

replace_once(
    public_media,
    """  const data = await fetchJson<CommonsResponse>(
    `${COMMONS_API_URL}?${params.toString()}`
  );""",
    """  const data = await fetchJson<CommonsResponse>(
    `${COMMONS_API_URL}?${params.toString()}`,
    PUBLIC_MEDIA_TIMEOUT,
    externalSignal
  );""",
)

replace_once(
    public_media,
    """async function searchWikimediaCommons(
  apiSite: ApiSite,
  query: string
): Promise<SearchResult[]> {""",
    """async function searchWikimediaCommons(
  apiSite: ApiSite,
  query: string,
  externalSignal?: AbortSignal
): Promise<SearchResult[]> {""",
)

replace_once(
    public_media,
    """      gsrlimit: '24',
    })
  );""",
    """      gsrlimit: '24',
    }),
    externalSignal
  );""",
)

replace_once(
    public_media,
    """export async function searchPublicMedia(
  apiSite: ApiSite,
  query: string
): Promise<SearchResult[]> {
  try {
    const { kind } = parseAdapter(apiSite.api);
    if (kind === 'internet-archive') {
      return await searchInternetArchive(apiSite, query);
    }
    if (kind === 'wikimedia-commons') {
      return await searchWikimediaCommons(apiSite, query);
    }
    return [];
  } catch (error) {
    console.warn(`公开资源搜索失败 ${apiSite.name}:`, error);
    return [];
  }
}""",
    """export async function searchPublicMedia(
  apiSite: ApiSite,
  query: string,
  externalSignal?: AbortSignal
): Promise<SearchResult[]> {
  try {
    const { kind } = parseAdapter(apiSite.api);
    if (kind === 'internet-archive') {
      return await searchInternetArchive(apiSite, query, externalSignal);
    }
    if (kind === 'wikimedia-commons') {
      return await searchWikimediaCommons(apiSite, query, externalSignal);
    }
    return [];
  } catch (error) {
    if (!externalSignal?.aborted) {
      console.warn(`公开资源搜索失败 ${apiSite.name}:`, error);
    }
    return [];
  }
}""",
)

# ---------------------------------------------------------------------------
# Streaming search: force NDJSON streaming and explicitly disable buffering/
# caching by intermediate proxies.
# ---------------------------------------------------------------------------
stream = "src/app/api/searchstream/route.ts"

replace_once(
    stream,
    "import { getCacheTime, getConfig } from '@/lib/config';",
    "import { getConfig } from '@/lib/config';",
)

replace_once(
    stream,
    """export const runtime = 'nodejs';

const SEARCH_CONCURRENCY = 10;""",
    """export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEARCH_CONCURRENCY = 10;""",
)

replace_once(
    stream,
    """  const cacheTime = await getCacheTime();

  const stream = new ReadableStream({""",
    """  const stream = new ReadableStream({""",
)

replace_once(
    stream,
    """    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
      'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
      'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
    },""",
    """    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control':
        'no-store, no-cache, max-age=0, must-revalidate, no-transform',
      'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },""",
)

print("critical path patches applied")
