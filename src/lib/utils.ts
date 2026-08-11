/* eslint-disable @typescript-eslint/no-explicit-any,no-console */
import he from 'he';

function getDoubanImageProxyConfig(): {
  proxyType:
    | 'direct'
    | 'server'
    | 'img3'
    | 'cmliussss-cdn-tencent'
    | 'cmliussss-cdn-ali'
    | 'custom';
  proxyUrl: string;
} {
  const runtimeConfig = (window as any).RUNTIME_CONFIG;
  const doubanImageProxyType =
    runtimeConfig?.DOUBAN_IMAGE_PROXY_TYPE ||
    localStorage.getItem('doubanImageProxyType') ||
    'server';
  const doubanImageProxy =
    runtimeConfig?.DOUBAN_IMAGE_PROXY ||
    localStorage.getItem('doubanImageProxyUrl') ||
    '';
  return {
    proxyType: doubanImageProxyType,
    proxyUrl: doubanImageProxy,
  };
}

/**
 * 处理图片 URL，如果设置了图片代理则使用代理
 */
export function processImageUrl(originalUrl: string): string {
  if (!originalUrl) return originalUrl;

  // 仅处理豆瓣图片代理
  if (!originalUrl.includes('doubanio.com')) {
    return originalUrl;
  }

  const { proxyType, proxyUrl } = getDoubanImageProxyConfig();
  switch (proxyType) {
    case 'server':
      return `/api/image-proxy?url=${encodeURIComponent(originalUrl)}`;
    case 'img3':
      return originalUrl.replace(/img\d+\.doubanio\.com/g, 'img3.doubanio.com');
    case 'cmliussss-cdn-tencent':
      return originalUrl.replace(
        /img\d+\.doubanio\.com/g,
        'img.doubanio.cmliussss.net'
      );
    case 'cmliussss-cdn-ali':
      return originalUrl.replace(
        /img\d+\.doubanio\.com/g,
        'img.doubanio.cmliussss.com'
      );
    case 'custom':
      return `${proxyUrl}${encodeURIComponent(originalUrl)}`;
    case 'direct':
    default:
      return originalUrl;
  }
}

/**
 * 从m3u8地址获取视频质量等级和网络信息（多点抽样增强版）
 * @param m3u8Url m3u8播放列表的URL
 * @returns Promise<{quality: string, loadSpeed: string, pingTime: number, speedJitter: number}> 视频质量等级和网络信息
 */
export async function getVideoResolutionFromM3u8(m3u8Url: string): Promise<{
  quality: string;
  loadSpeed: string;
  pingTime: number;
  speedJitter: number;
}> {
  return new Promise(async (resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Timeout: Multi-point sampling test took too long'));
    }, 10000); // 10秒总超时

    try {
      // 1. 获取M3U8清单文件，计算初始延迟(Ping)
      const pingStart = performance.now();
      const manifestResponse = await fetch(m3u8Url, { signal: controller.signal });
      const pingTime = performance.now() - pingStart;

      if (!manifestResponse.ok) {
        throw new Error(`Manifest fetch failed with status: ${manifestResponse.status}`);
      }
      const manifestContent = await manifestResponse.text();

      // 2. 解析 master/media playlist。旧逻辑会把 master playlist 中的
      // variant .m3u8 当成视频分片测速，文件很小，导致速度被严重低估。
      const masterLines = manifestContent.split('\n');
      const variants: Array<{ url: string; width: number }> = [];
      for (let index = 0; index < masterLines.length; index += 1) {
        const line = masterLines[index].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
        const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/i);
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
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((url) => new URL(url, mediaPlaylistUrl).href)
        .filter((url) => !/\.m3u8(?:\?|$)/i.test(url));

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

      // 4. 并行测试分片下载速度
      const testSegment = async (url: string): Promise<number> => {
        try {
          // 测速只读取前 256 KiB，避免为了选源先把多个完整 TS/fMP4 分片下载一遍。
          const SAMPLE_LIMIT = 256 * 1024;
          const startTime = performance.now();
          const segmentResponse = await fetch(url, { signal: controller.signal });
          if (!segmentResponse.ok) return 0;

          let size = 0;
          if (segmentResponse.body) {
            const reader = segmentResponse.body.getReader();
            while (size < SAMPLE_LIMIT) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value?.byteLength || 0;
            }
            if (size >= SAMPLE_LIMIT) {
              await reader.cancel().catch(() => undefined);
            }
          } else {
            size = Math.min((await segmentResponse.arrayBuffer()).byteLength, SAMPLE_LIMIT);
          }

          const loadTime = performance.now() - startTime;
          if (loadTime <= 0 || size <= 0) return 0;
          return size / 1024 / (loadTime / 1000); // KB/s
        } catch (error) {
          return 0; // 任何错误都视为速度为0
        }
      };

      const speedSamples = (await Promise.all(segmentsToTest.map(testSegment))).filter(speed => speed > 0);

      if (speedSamples.length === 0) {
        throw new Error('All segment download tests failed');
      }

      // 5. 计算最终统计数据
      const avgSpeed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
      const finalLoadSpeed = avgSpeed >= 1024 ? `${(avgSpeed / 1024).toFixed(1)} MB/s` : `${avgSpeed.toFixed(1)} KB/s`;
      
      let speedJitter = 0;
      if (speedSamples.length > 1) {
        const mean = avgSpeed;
        const variance = speedSamples.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / speedSamples.length;
        speedJitter = Math.sqrt(variance);
      }

      clearTimeout(timeout);
      resolve({ quality, loadSpeed: finalLoadSpeed, pingTime: Math.round(pingTime), speedJitter });

    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

export function cleanHtmlTags(text: string): string {
  if (!text) return '';

  const cleanedText = text
    .replace(/<[^>]+>/g, '\n') // 将 HTML 标签替换为换行
    .replace(/\n+/g, '\n') // 将多个连续换行合并为一个
    .replace(/[ \t]+/g, ' ') // 将多个连续空格和制表符合并为一个空格，但保留换行符
    .replace(/^\n+|\n+$/g, '') // 去掉首尾换行
    .trim(); // 去掉首尾空格

  // 使用 he 库解码 HTML 实体
  return he.decode(cleanedText);
}
