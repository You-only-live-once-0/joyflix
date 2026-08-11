from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected 1 match, got {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


def replace_count(path: str, old: str, new: str, expected: int) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f'{path}: expected {expected} matches, got {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new))


# -----------------------------------------------------------------------------
# PWA: never service-worker-cache private APIs or streaming media.
# -----------------------------------------------------------------------------
replace_once(
    'next.config.js',
    "const webpack = require('webpack');\n",
    "const webpack = require('webpack');\nconst defaultCache = require('next-pwa/cache');\n",
)
replace_once(
    'next.config.js',
    """const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  skipWaiting: true,
  clientsClaim: true,
});""",
    """const privateApiPattern =
  /\\/api\\/(?:favorites|playrecords|searchhistory|skipconfigs|admin)(?:\\/|$|\\?)/i;
const streamingApiPattern = /\\/api\\/searchstream(?:\\?|$)/i;
const streamingMediaPattern =
  /\\.(?:m3u8|ts|m4s|mp4|webm|ogv)(?:\\?.*)?$/i;

const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: [
    // Video/HLS should flow directly from the network. Caching large media in
    // Workbox can consume storage and can replay stale signed playlists.
    {
      urlPattern: streamingMediaPattern,
      handler: 'NetworkOnly',
    },
    // Streaming search must remain truly streaming rather than being buffered
    // by Workbox's generic /api NetworkFirst rule.
    {
      urlPattern: streamingApiPattern,
      handler: 'NetworkOnly',
      method: 'GET',
    },
    // These responses are user-specific. Never let a previous account's data
    // become a service-worker fallback for another account on the same device.
    {
      urlPattern: privateApiPattern,
      handler: 'NetworkOnly',
      method: 'GET',
    },
    ...defaultCache,
  ],
});""",
)

# -----------------------------------------------------------------------------
# Auth signing: prefer a server-only secret that is not committed to the repo.
# -----------------------------------------------------------------------------
replace_once(
    'src/lib/site-password.ts',
    """export function getAuthSigningSecret(): string {
  return process.env.PASSWORD || FALLBACK_PASSWORD_HASH;
}""",
    """export function getAuthSigningSecret(): string {
  return (
    process.env.AUTH_SECRET ||
    process.env.PASSWORD ||
    process.env.UPSTASH_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    FALLBACK_PASSWORD_HASH
  );
}""",
)

# -----------------------------------------------------------------------------
# Config: 30s warm-instance cache to avoid one Redis read per API request.
# -----------------------------------------------------------------------------
replace_once(
    'src/lib/config.ts',
    'let cachedConfig: AdminConfig;\n',
    """let cachedConfig: AdminConfig;
let cachedConfigExpiresAt = 0;
const CONFIG_CACHE_TTL_MS = 30_000;
""",
)
replace_once(
    'src/lib/config.ts',
    """  if (process.env.DOCKER_ENV === 'true' || storageType === 'localstorage') {
    await initConfig();
    return cachedConfig;
  }
  // 非 docker 环境且 DB 存储，直接读 db 配置
""",
    """  if (process.env.DOCKER_ENV === 'true' || storageType === 'localstorage') {
    await initConfig();
    return cachedConfig;
  }

  // Serverless/Edge warm instances used to re-read admin:config for every API
  // request. A short TTL removes that extra Redis round trip while keeping admin
  // changes visible quickly across instances.
  if (cachedConfig && Date.now() < cachedConfigExpiresAt) {
    return cachedConfig;
  }

  // 非 docker 环境且 DB 存储，直接读 db 配置
""",
)
replace_once(
    'src/lib/config.ts',
    """  return cachedConfig;
}

export async function resetConfig() {""",
    """  if (cachedConfig) {
    cachedConfigExpiresAt = Date.now() + CONFIG_CACHE_TTL_MS;
  }
  return cachedConfig;
}

export async function resetConfig() {""",
)
replace_once(
    'src/lib/config.ts',
    """  cachedConfig.CustomCategories = adminConfig.CustomCategories;
}

export async function getCacheTime(): Promise<number> {""",
    """  cachedConfig.CustomCategories = adminConfig.CustomCategories;
  cachedConfigExpiresAt = Date.now() + CONFIG_CACHE_TTL_MS;
}

export async function getCacheTime(): Promise<number> {""",
)

# -----------------------------------------------------------------------------
# Upstash: bulk reads + hashed user passwords with transparent legacy migration.
# -----------------------------------------------------------------------------
replace_once(
    'src/lib/upstash.db.ts',
    "const SEARCH_HISTORY_LIMIT = 20;\n",
    """const SEARCH_HISTORY_LIMIT = 20;
const PASSWORD_HASH_PREFIX = 'pbkdf2-sha256';
const PASSWORD_HASH_ITERATIONS = 210_000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(value: string): Uint8Array {
  const pairs = value.match(/.{1,2}/g) || [];
  return new Uint8Array(pairs.map((pair) => parseInt(pair, 16)));
}

function timingSafeEqualHex(left: string, right: string): boolean {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  if (leftBytes.length !== rightBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function derivePasswordHash(
  password: string,
  saltHex: string,
  iterations: number
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: hexToBytes(saltHex),
      iterations,
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(derived));
}

async function encodePassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltHex = bytesToHex(salt);
  const hash = await derivePasswordHash(
    password,
    saltHex,
    PASSWORD_HASH_ITERATIONS
  );
  return `${PASSWORD_HASH_PREFIX}$${PASSWORD_HASH_ITERATIONS}$${saltHex}$${hash}`;
}

async function verifyEncodedPassword(
  password: string,
  encoded: string
): Promise<boolean> {
  const [prefix, iterationsRaw, saltHex, expectedHash] = encoded.split('$');
  const iterations = Number(iterationsRaw);
  if (
    prefix !== PASSWORD_HASH_PREFIX ||
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 1_000_000 ||
    !/^[a-f0-9]{32}$/i.test(saltHex || '') ||
    !/^[a-f0-9]{64}$/i.test(expectedHash || '')
  ) {
    return false;
  }
  const candidateHash = await derivePasswordHash(password, saltHex, iterations);
  return timingSafeEqualHex(candidateHash, expectedHash);
}
""",
)
replace_once(
    'src/lib/upstash.db.ts',
    """    const result: Record<string, PlayRecord> = {};
    for (const fullKey of keys) {
      const value = await withRetry(() => this.client.get(fullKey));
      if (value) {
        // 截取 source+id 部分
        const keyPart = ensureString(fullKey.replace(`u:${userName}:pr:`, ''));
        result[keyPart] = value as PlayRecord;
      }
    }
    return result;""",
    """    const values = await withRetry(() => this.client.mget(keys));
    const result: Record<string, PlayRecord> = {};
    keys.forEach((fullKey, index) => {
      const value = values[index];
      if (value) {
        const keyPart = ensureString(fullKey.replace(`u:${userName}:pr:`, ''));
        result[keyPart] = value as PlayRecord;
      }
    });
    return result;""",
)
replace_once(
    'src/lib/upstash.db.ts',
    """    const result: Record<string, Favorite> = {};
    for (const fullKey of keys) {
      const value = await withRetry(() => this.client.get(fullKey));
      if (value) {
        const keyPart = ensureString(fullKey.replace(`u:${userName}:fav:`, ''));
        result[keyPart] = value as Favorite;
      }
    }
    return result;""",
    """    const values = await withRetry(() => this.client.mget(keys));
    const result: Record<string, Favorite> = {};
    keys.forEach((fullKey, index) => {
      const value = values[index];
      if (value) {
        const keyPart = ensureString(fullKey.replace(`u:${userName}:fav:`, ''));
        result[keyPart] = value as Favorite;
      }
    });
    return result;""",
)
replace_once(
    'src/lib/upstash.db.ts',
    """  async registerUser(userName: string, password: string): Promise<void> {
    // 简单存储明文密码，生产环境应加密
    await withRetry(() => this.client.set(this.userPwdKey(userName), password));
  }

  async verifyUser(userName: string, password: string): Promise<boolean> {
    const stored = await withRetry(() =>
      this.client.get(this.userPwdKey(userName))
    );
    if (stored === null) return false;
    // 确保比较时都是字符串类型
    return ensureString(stored) === password;
  }""",
    """  async registerUser(userName: string, password: string): Promise<void> {
    const encoded = await encodePassword(password);
    await withRetry(() => this.client.set(this.userPwdKey(userName), encoded));
  }

  async verifyUser(userName: string, password: string): Promise<boolean> {
    const passwordKey = this.userPwdKey(userName);
    const stored = await withRetry(() => this.client.get(passwordKey));
    if (stored === null) return false;

    const storedPassword = ensureString(stored);
    if (storedPassword.startsWith(`${PASSWORD_HASH_PREFIX}$`)) {
      return verifyEncodedPassword(password, storedPassword);
    }

    // Backward compatibility: existing accounts may still contain plaintext.
    // A successful legacy login upgrades the stored value immediately.
    const legacyMatches = storedPassword === password;
    if (legacyMatches) {
      const encoded = await encodePassword(password);
      await withRetry(() => this.client.set(passwordKey, encoded));
    }
    return legacyMatches;
  }""",
)
replace_once(
    'src/lib/upstash.db.ts',
    """  async changePassword(userName: string, newPassword: string): Promise<void> {
    // 简单存储明文密码，生产环境应加密
    await withRetry(() =>
      this.client.set(this.userPwdKey(userName), newPassword)
    );
  }""",
    """  async changePassword(userName: string, newPassword: string): Promise<void> {
    const encoded = await encodePassword(newPassword);
    await withRetry(() =>
      this.client.set(this.userPwdKey(userName), encoded)
    );
  }""",
)

# -----------------------------------------------------------------------------
# Client storage: dedupe/throttle read-through sync for records/history/favorites.
# -----------------------------------------------------------------------------
replace_once(
    'src/lib/db.client.ts',
    """let favoritesFetchPromise: Promise<Record<string, Favorite>> | null = null;
let lastFavoritesFetchAt = 0;
const FAVORITES_SYNC_INTERVAL = 60_000;
""",
    """let playRecordsFetchPromise: Promise<Record<string, PlayRecord>> | null = null;
let lastPlayRecordsFetchAt = 0;
const PLAY_RECORDS_SYNC_INTERVAL = 60_000;

let favoritesFetchPromise: Promise<Record<string, Favorite>> | null = null;
let lastFavoritesFetchAt = 0;
const FAVORITES_SYNC_INTERVAL = 60_000;

let searchHistoryFetchPromise: Promise<string[]> | null = null;
let lastSearchHistoryFetchAt = 0;
const SEARCH_HISTORY_SYNC_INTERVAL = 120_000;

function fetchPlayRecordsShared(): Promise<Record<string, PlayRecord>> {
  if (!playRecordsFetchPromise) {
    lastPlayRecordsFetchAt = Date.now();
    playRecordsFetchPromise = fetchFromApi<Record<string, PlayRecord>>(
      '/api/playrecords'
    )
      .then((freshData) => {
        cacheManager.cachePlayRecords(freshData);
        return freshData;
      })
      .finally(() => {
        playRecordsFetchPromise = null;
      });
  }
  return playRecordsFetchPromise;
}

function fetchSearchHistoryShared(): Promise<string[]> {
  if (!searchHistoryFetchPromise) {
    lastSearchHistoryFetchAt = Date.now();
    searchHistoryFetchPromise = fetchFromApi<string[]>('/api/searchhistory')
      .then((freshData) => {
        cacheManager.cacheSearchHistory(freshData);
        return freshData;
      })
      .finally(() => {
        searchHistoryFetchPromise = null;
      });
  }
  return searchHistoryFetchPromise;
}
""",
)
replace_once(
    'src/lib/db.client.ts',
    """// ---- 错误处理辅助函数 ----""",
    """function syncPlayRecordsInBackground(
  cachedRecords: Record<string, PlayRecord>
): void {
  if (Date.now() - lastPlayRecordsFetchAt < PLAY_RECORDS_SYNC_INTERVAL) return;
  void fetchPlayRecordsShared()
    .then((freshData) => {
      if (JSON.stringify(cachedRecords) !== JSON.stringify(freshData)) {
        window.dispatchEvent(
          new CustomEvent('playRecordsUpdated', { detail: freshData })
        );
      }
    })
    .catch((err) => console.warn('后台同步播放记录失败:', err));
}

function syncSearchHistoryInBackground(cachedHistory: string[]): void {
  if (Date.now() - lastSearchHistoryFetchAt < SEARCH_HISTORY_SYNC_INTERVAL) {
    return;
  }
  void fetchSearchHistoryShared()
    .then((freshData) => {
      if (JSON.stringify(cachedHistory) !== JSON.stringify(freshData)) {
        window.dispatchEvent(
          new CustomEvent('searchHistoryUpdated', { detail: freshData })
        );
      }
    })
    .catch((err) => console.warn('后台同步搜索历史失败:', err));
}

// ---- 错误处理辅助函数 ----""",
)
replace_once(
    'src/lib/db.client.ts',
    """    if (cachedData) {
      // 返回缓存数据，同时后台异步更新
      fetchFromApi<Record<string, PlayRecord>>(`/api/playrecords`)
        .then((freshData) => {
          // 只有数据真正不同时才更新缓存
          if (JSON.stringify(cachedData) !== JSON.stringify(freshData)) {
            cacheManager.cachePlayRecords(freshData);
            // 触发数据更新事件，供组件监听
            window.dispatchEvent(
              new CustomEvent('playRecordsUpdated', {
                detail: freshData,
              })
            );
          }
        })
        .catch((err) => {
          console.warn('后台同步播放记录失败:', err);
          triggerGlobalError('后台同步播放记录失败');
        });

      return cachedData;
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchFromApi<Record<string, PlayRecord>>(
          `/api/playrecords`
        );
        cacheManager.cachePlayRecords(freshData);
        return freshData;
      } catch (err) {""",
    """    if (cachedData) {
      syncPlayRecordsInBackground(cachedData);
      return cachedData;
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchPlayRecordsShared();
        return freshData;
      } catch (err) {""",
)
replace_once(
    'src/lib/db.client.ts',
    """    if (cachedData) {
      // 返回缓存数据，同时后台异步更新
      fetchFromApi<string[]>(`/api/searchhistory`)
        .then((freshData) => {
          // 只有数据真正不同时才更新缓存
          if (JSON.stringify(cachedData) !== JSON.stringify(freshData)) {
            cacheManager.cacheSearchHistory(freshData);
            // 触发数据更新事件
            window.dispatchEvent(
              new CustomEvent('searchHistoryUpdated', {
                detail: freshData,
              })
            );
          }
        })
        .catch((err) => {
          console.warn('后台同步搜索历史失败:', err);
          triggerGlobalError('后台同步搜索历史失败');
        });

      return cachedData;
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchFromApi<string[]>(`/api/searchhistory`);
        cacheManager.cacheSearchHistory(freshData);
        return freshData;
      } catch (err) {""",
    """    if (cachedData) {
      syncSearchHistoryInBackground(cachedData);
      return cachedData;
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchSearchHistoryShared();
        return freshData;
      } catch (err) {""",
)
replace_once(
    'src/lib/db.client.ts',
    """    if (cachedData) {
      // 返回缓存数据，同时后台异步更新
      fetchFromApi<Record<string, Favorite>>(`/api/favorites`)
        .then((freshData) => {
          // 只有数据真正不同时才更新缓存
          if (JSON.stringify(cachedData) !== JSON.stringify(freshData)) {
            cacheManager.cacheFavorites(freshData);
            // 触发数据更新事件
            window.dispatchEvent(
              new CustomEvent('favoritesUpdated', {
                detail: freshData,
              })
            );
          }
        })
        .catch((err) => {
          console.warn('后台同步收藏失败:', err);
          triggerGlobalError('后台同步收藏失败');
        });

      return cachedData;
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchFromApi<Record<string, Favorite>>(
          `/api/favorites`
        );
        cacheManager.cacheFavorites(freshData);
        return freshData;
      } catch (err) {""",
    """    if (cachedData) {
      syncFavoritesInBackground(cachedData);
      return cachedData;
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchFavoritesShared();
        return freshData;
      } catch (err) {""",
)
replace_once(
    'src/lib/db.client.ts',
    """        body: JSON.stringify({ key, record }),
      });""",
    """        body: JSON.stringify({ key, record }),
        keepalive: true,
      });""",
)

# -----------------------------------------------------------------------------
# Search: propagate browser aborts all the way to downstream fetches.
# -----------------------------------------------------------------------------
replace_once(
    'src/lib/downstream.ts',
    """interface ApiSearchItem {""",
    """async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort();

  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  }

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

interface ApiSearchItem {""",
)
replace_once(
    'src/lib/downstream.ts',
    """export async function searchFromApi(
  apiSite: ApiSite,
  query: string
): Promise<SearchResult[]> {
  if (isPublicMediaAdapter(apiSite.api)) {
    return searchPublicMedia(apiSite, query);
  }""",
    """export async function searchFromApi(
  apiSite: ApiSite,
  query: string,
  externalSignal?: AbortSignal
): Promise<SearchResult[]> {
  if (externalSignal?.aborted) return [];
  if (isPublicMediaAdapter(apiSite.api)) {
    return searchPublicMedia(apiSite, query);
  }""",
)
replace_once(
    'src/lib/downstream.ts',
    """    // 添加超时处理
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(apiUrl, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);""",
    """    const response = await fetchWithTimeout(
      apiUrl,
      { headers: API_CONFIG.search.headers },
      8000,
      externalSignal
    );""",
)
replace_once(
    'src/lib/downstream.ts',
    """            const pageController = new AbortController();
            const pageTimeoutId = setTimeout(
              () => pageController.abort(),
              8000
            );

            const pageResponse = await fetch(pageUrl, {
              headers: API_CONFIG.search.headers,
              signal: pageController.signal,
            });

            clearTimeout(pageTimeoutId);""",
    """            if (externalSignal?.aborted) return [];
            const pageResponse = await fetchWithTimeout(
              pageUrl,
              { headers: API_CONFIG.search.headers },
              8000,
              externalSignal
            );""",
)

# Search aggregate route.
replace_once(
    'src/app/api/search/route.ts',
    """  sites: Awaited<ReturnType<typeof getConfig>>['SourceConfig'],
  query: string
): Promise<SearchResult[]> {""",
    """  sites: Awaited<ReturnType<typeof getConfig>>['SourceConfig'],
  query: string,
  signal?: AbortSignal
): Promise<SearchResult[]> {""",
)
replace_once(
    'src/app/api/search/route.ts',
    """    while (true) {
      const index = nextIndex++;
      if (index >= sites.length) return;""",
    """    while (true) {
      if (signal?.aborted) return;
      const index = nextIndex++;
      if (index >= sites.length) return;""",
)
replace_once(
    'src/app/api/search/route.ts',
    '        buckets[index] = await searchFromApi(site, query);',
    '        buckets[index] = await searchFromApi(site, query, signal);',
)
replace_once(
    'src/app/api/search/route.ts',
    '    const flattenedResults = await searchWithConcurrency(apiSites, query);',
    '    const flattenedResults = await searchWithConcurrency(\n      apiSites,\n      query,\n      request.signal\n    );',
)

# Streaming route.
replace_once(
    'src/app/api/searchstream/route.ts',
    """      const processSite = async (site: (typeof apiSites)[0]) => {
        try {
          const results: SearchResult[] = await searchFromApi(site, query);
          if (results.length > 0) {
            controller.enqueue(encoder.encode(JSON.stringify(results) + '\\n'));
          }
        } catch (err: any) {""",
    """      const processSite = async (site: (typeof apiSites)[0]) => {
        if (request.signal.aborted) return;
        try {
          const results: SearchResult[] = await searchFromApi(
            site,
            query,
            request.signal
          );
          if (results.length > 0 && !request.signal.aborted) {
            try {
              controller.enqueue(encoder.encode(JSON.stringify(results) + '\\n'));
            } catch {
              // Client disconnected between the fetch completing and enqueue.
            }
          }
        } catch (err: any) {""",
)
replace_once(
    'src/app/api/searchstream/route.ts',
    """        while (true) {
          const index = nextIndex++;
          if (index >= apiSites.length) return;""",
    """        while (true) {
          if (request.signal.aborted) return;
          const index = nextIndex++;
          if (index >= apiSites.length) return;""",
)
replace_once(
    'src/app/api/searchstream/route.ts',
    """      controller.close();""",
    """      if (!request.signal.aborted) {
        controller.close();
      }""",
)

# -----------------------------------------------------------------------------
# Source probing: master HLS playlists now probe real media segments.
# -----------------------------------------------------------------------------
replace_once(
    'src/lib/utils.ts',
    """      // 2. 从清单中解析分片URL和最高画质
      const lines = manifestContent.split('\\n');
      const segmentUrls = lines
        .filter(line => line.trim() && !line.startsWith('#'))
        .map(url => new URL(url, m3u8Url).href);

      if (segmentUrls.length === 0) {
        throw new Error('No segments found in manifest');
      }

      const resolutionRegex = /RESOLUTION=(\\d+)x(\\d+)/g;
      let match;
      let maxResolution = 0;
      while ((match = resolutionRegex.exec(manifestContent)) !== null) {
        const width = parseInt(match[1], 10);
        if (width > maxResolution) maxResolution = width;
      }
      
      let quality = '未知';
      if (maxResolution > 0) {
        quality =
          maxResolution >= 3840 ? '4K' :
          maxResolution >= 2560 ? '2K' :
          maxResolution >= 1920 ? '1080P' :
          maxResolution >= 1280 ? '720P' :
          maxResolution >= 854 ? '480P' : 'SD';
      }

      // 3. 选择测试分片（第一个和中间一个）
      const segmentsToTest: string[] = [];
      if (segmentUrls[0]) {
        segmentsToTest.push(segmentUrls[0]);
      }
      if (segmentUrls.length > 2) {
        segmentsToTest.push(segmentUrls[Math.floor(segmentUrls.length / 2)]);
      }

      // 4. 并行测试分片下载速度""",
    """      // 2. 解析 master/media playlist。旧逻辑会把 master playlist 中的
      // variant .m3u8 当成视频分片测速，文件很小，导致速度被严重低估。
      const masterLines = manifestContent.split('\\n');
      const variants: Array<{ url: string; width: number }> = [];
      for (let index = 0; index < masterLines.length; index += 1) {
        const line = masterLines[index].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
        const resolution = line.match(/RESOLUTION=(\\d+)x(\\d+)/i);
        let nextIndex = index + 1;
        while (
          nextIndex < masterLines.length &&
          (!masterLines[nextIndex].trim() || masterLines[nextIndex].trim().startsWith('#'))
        ) {
          nextIndex += 1;
        }
        const variantUrl = masterLines[nextIndex]?.trim();
        if (variantUrl) {
          variants.push({
            url: new URL(variantUrl, m3u8Url).href,
            width: resolution ? parseInt(resolution[1], 10) : 0,
          });
        }
      }

      const maxResolution = variants.reduce(
        (max, variant) => Math.max(max, variant.width),
        0
      );
      let quality = '未知';
      if (maxResolution > 0) {
        quality =
          maxResolution >= 3840 ? '4K' :
          maxResolution >= 2560 ? '2K' :
          maxResolution >= 1920 ? '1080P' :
          maxResolution >= 1280 ? '720P' :
          maxResolution >= 854 ? '480P' : 'SD';
      }

      let mediaManifestContent = manifestContent;
      let mediaPlaylistUrl = m3u8Url;
      if (variants.length > 0) {
        const sortedVariants = [...variants].sort((a, b) => b.width - a.width);
        const probeVariant =
          sortedVariants.find((variant) => variant.width > 0 && variant.width <= 1920) ||
          sortedVariants[sortedVariants.length - 1];
        if (probeVariant) {
          const variantResponse = await fetch(probeVariant.url, {
            signal: controller.signal,
          });
          if (variantResponse.ok) {
            mediaManifestContent = await variantResponse.text();
            mediaPlaylistUrl = probeVariant.url;
          }
        }
      }

      const segmentUrls = mediaManifestContent
        .split('\\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((url) => new URL(url, mediaPlaylistUrl).href)
        .filter((url) => !/\\.m3u8(?:\\?|$)/i.test(url));

      if (segmentUrls.length === 0) {
        throw new Error('No media segments found in manifest');
      }

      // 3. 选择测试分片（第一个和中间一个）
      const segmentsToTest: string[] = [];
      if (segmentUrls[0]) {
        segmentsToTest.push(segmentUrls[0]);
      }
      if (segmentUrls.length > 2) {
        segmentsToTest.push(segmentUrls[Math.floor(segmentUrls.length / 2)]);
      }

      // 4. 并行测试分片下载速度""",
)

# -----------------------------------------------------------------------------
# Playback persistence: avoid duplicate pause writes; keep final writes alive.
# -----------------------------------------------------------------------------
replace_once(
    'src/app/play/page.tsx',
    """        if (process.env.NEXT_PUBLIC_STORAGE_TYPE === 'upstash') {
          interval = 20000;
        }""",
    """        if (process.env.NEXT_PUBLIC_STORAGE_TYPE === 'upstash') {
          interval = 30000;
        }""",
)
replace_once(
    'src/app/play/page.tsx',
    """      artPlayerRef.current.on('pause', () => {
        saveCurrentPlayProgress();
      });

      if (artPlayerRef.current?.video) {""",
    """      if (artPlayerRef.current?.video) {""",
)

# -----------------------------------------------------------------------------
# Production cookies should only travel over HTTPS.
# -----------------------------------------------------------------------------
replace_count(
    'src/app/api/login/route.ts',
    '        secure: false,',
    "        secure: process.env.NODE_ENV === 'production',",
    4,
)
replace_once(
    'src/app/api/logout/route.ts',
    '    secure: false, // 根据协议自动设置',
    "    secure: process.env.NODE_ENV === 'production',",
)

# -----------------------------------------------------------------------------
# Middleware HMAC key import is static per warm instance; cache the CryptoKey.
# -----------------------------------------------------------------------------
replace_once(
    'src/middleware.ts',
    """async function verifySignature(
  data: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );""",
    """let cachedVerificationSecret = '';
let cachedVerificationKey: CryptoKey | null = null;

async function getVerificationKey(secret: string): Promise<CryptoKey> {
  if (cachedVerificationKey && cachedVerificationSecret === secret) {
    return cachedVerificationKey;
  }
  cachedVerificationKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  cachedVerificationSecret = secret;
  return cachedVerificationKey;
}

async function verifySignature(
  data: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const messageData = new TextEncoder().encode(data);

  try {
    const key = await getVerificationKey(secret);""",
)

print('Second optimization pass patched successfully.')
