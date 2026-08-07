from pathlib import Path
import re

path = Path('src/app/play/page.tsx')
text = path.read_text(encoding='utf-8')

# The page already lazy-loads these packages; remove duplicate eager imports.
text = text.replace("import Artplayer from 'artplayer';\n", '', 1)
text = text.replace("import Hls from 'hls.js';\n", '', 1)

ensure_pattern = re.compile(
    r"  const ensureVideoSource = \(video: HTMLVideoElement \| null, url: string\) => \{.*?\n  \};\n\n  // Wake Lock",
    re.S,
)
ensure_replacement = r"""  const isHlsPlaybackUrl = (url: string): boolean =>
    /\.m3u8(?:$|[?#])/i.test(url) ||
    /[?&](?:type|format)=m3u8(?:&|$)/i.test(url);

  const ensureVideoSource = (video: HTMLVideoElement | null, url: string) => {
    if (!video || !url) return;
    const sources = Array.from(video.getElementsByTagName('source'));

    // HLS.js / native HLS owns the media source. Keeping an extra <source>
    // can trigger a second, competing network load.
    if (isHlsPlaybackUrl(url)) {
      sources.forEach((source) => source.remove());
    } else {
      const existed = sources.some((source) => source.src === url);
      if (!existed) {
        sources.forEach((source) => source.remove());
        const sourceEl = document.createElement('source');
        sourceEl.src = url;
        video.appendChild(sourceEl);
      }
    }

    video.preload = 'auto';
    video.playsInline = true;
    video.disableRemotePlayback = false;
    if (video.hasAttribute('disableRemotePlayback')) {
      video.removeAttribute('disableRemotePlayback');
    }
  };

  // Wake Lock"""
text, count = ensure_pattern.subn(ensure_replacement, text, count=1)
if count != 1:
    raise SystemExit('ensureVideoSource replacement failed')

old = "        url: videoUrl,\n        poster: '/assets/img/poster.png',"
new = "        url: videoUrl,\n        type: isHlsPlaybackUrl(videoUrl) ? 'm3u8' : undefined,\n        poster: '/assets/img/poster.png',"
if old not in text:
    raise SystemExit('Artplayer url marker missing')
text = text.replace(old, new, 1)

old = "        moreVideoAttr: {\n          crossOrigin: 'anonymous',\n        },"
new = "        moreVideoAttr: {\n          preload: 'auto',\n        },"
if old not in text:
    raise SystemExit('moreVideoAttr marker missing')
text = text.replace(old, new, 1)

marker = """            if (video.hls) {
              video.hls.destroy();
            }
            const hls = new Hls({"""
replacement = """            if (video.hls) {
              video.hls.destroy();
            }

            // Safari/iOS use native HLS when Media Source Extensions are not
            // available. Native playback is generally the most stable path there.
            if (!Hls.isSupported()) {
              if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = url;
                video.preload = 'auto';
                video.load();
              } else {
                console.error('当前浏览器不支持 HLS 播放');
              }
              return;
            }

            const hls = new Hls({"""
if marker not in text:
    raise SystemExit('native HLS insertion marker missing')
text = text.replace(marker, replacement, 1)

old_config = """            const hls = new Hls({
              debug: false, // 关闭日志
              enableWorker: true, // WebWorker 解码，降低主线程压力
              lowLatencyMode: true, // 开启低延迟 LL-HLS

              /* 缓冲/内存相关 - 极致流畅版 */
              maxBufferLength: 80, // 前向缓冲最大 80s，过大容易导致高延迟
              maxMaxBufferLength: 200, // 设置一个安全的最大上限，防止意外的缓冲裁剪
              backBufferLength: 40, // 仅保留 40s 已播放内容，避免内存占用
              maxBufferSize: 500 * 1000 * 1000, // 约 500MB，超出后触发清理

              /* 自定义loader */
              loader: blockAdEnabledRef.current
                ? CustomHlsJsLoader
                : Hls.DefaultConfig.loader,
            });"""
new_config = """            const hls = new Hls({
              debug: false,
              enableWorker: true,

              // TV/movie playback is VOD. LL-HLS trades buffer headroom for
              // latency, so disable it and prioritize continuous playback.
              lowLatencyMode: false,
              capLevelToPlayerSize: true,
              startLevel: -1,
              testBandwidth: true,
              startFragPrefetch: true,

              // Conservative ABR: step up slowly and step down early when the
              // connection cannot sustain the current bitrate.
              abrEwmaDefaultEstimate: 2_000_000,
              abrEwmaDefaultEstimateMax: 4_000_000,
              abrBandWidthFactor: 0.82,
              abrBandWidthUpFactor: 0.62,
              abrMaxWithRealBitrate: true,
              maxStarvationDelay: 2,
              maxLoadingDelay: 3,

              // Keep enough forward buffer without the previous 500 MB memory
              // ceiling, which can be costly on phones and long episodes.
              maxBufferLength: 50,
              maxMaxBufferLength: 120,
              backBufferLength: 60,
              maxBufferSize: 96 * 1000 * 1000,
              maxBufferHole: 0.5,
              nudgeOffset: 0.1,
              nudgeMaxRetry: 5,

              loader: blockAdEnabledRef.current
                ? CustomHlsJsLoader
                : Hls.DefaultConfig.loader,
            });"""
if old_config not in text:
    raise SystemExit('HLS config block missing')
text = text.replace(old_config, new_config, 1)

old_filter = """                      if (response.data && typeof response.data === 'string') {
                        // 过滤掉广告段 - 实现更精确的广告过滤逻辑
                        response.data = filterAdsFromM3U8(response.data);
                      }"""
new_filter = """                      if (response.data && typeof response.data === 'string') {
                        const rawManifest = response.data;
                        const rawSegments =
                          (rawManifest.match(/#EXTINF:/g) || []).length;

                        // Only filter media playlists. If the heuristic removes
                        // too much, fall back to the original manifest rather than
                        // turning valid segments into playback stalls.
                        if (rawSegments > 0) {
                          const filteredManifest = filterAdsFromM3U8(rawManifest);
                          const filteredSegments =
                            (filteredManifest.match(/#EXTINF:/g) || []).length;
                          const safeThreshold = Math.max(
                            1,
                            Math.floor(rawSegments * 0.65)
                          );
                          response.data =
                            filteredManifest.includes('#EXTM3U') &&
                            filteredSegments >= safeThreshold
                              ? filteredManifest
                              : rawManifest;
                        }
                      }"""
if old_filter not in text:
    raise SystemExit('ad filter block missing')
text = text.replace(old_filter, new_filter, 1)

old_error = """            hls.on(Hls.Events.ERROR, function (event: any, data: any) {
              console.error('HLS Error:', event, data);
              if (data.fatal) {
                switch (data.type) {
                  case Hls.ErrorTypes.NETWORK_ERROR:
                    console.log('网络错误，尝试恢复...');
                    hls.startLoad();
                    break;
                  case Hls.ErrorTypes.MEDIA_ERROR:
                    console.log('媒体错误，尝试恢复...');
                    hls.recoverMediaError();
                    break;
                  default:
                    console.log('无法恢复的错误');
                    hls.destroy();
                    break;
                }
              }
            });"""
new_error = """            let stallCount = 0;
            let lastStallAt = 0;

            hls.on(Hls.Events.FRAG_LOADED, () => {
              if (Date.now() - lastStallAt > 30000) {
                stallCount = 0;
              }
            });

            hls.on(Hls.Events.ERROR, function (event: any, data: any) {
              console.error('HLS Error:', event, data);

              if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
                const now = Date.now();
                stallCount = now - lastStallAt < 30000 ? stallCount + 1 : 1;
                lastStallAt = now;

                // Repeated stalls: temporarily cap one level lower. This keeps
                // playback moving instead of repeatedly chasing a high bitrate.
                if (
                  stallCount >= 2 &&
                  hls.autoLevelEnabled &&
                  hls.currentLevel > 0
                ) {
                  hls.autoLevelCapping = Math.max(0, hls.currentLevel - 1);
                  if (artPlayerRef.current) {
                    artPlayerRef.current.notice.show = '网络波动，已自动降低画质';
                  }
                }
              }

              if (data.fatal) {
                switch (data.type) {
                  case Hls.ErrorTypes.NETWORK_ERROR:
                    console.log('网络错误，尝试恢复...');
                    hls.startLoad();
                    break;
                  case Hls.ErrorTypes.MEDIA_ERROR:
                    console.log('媒体错误，尝试恢复...');
                    hls.recoverMediaError();
                    break;
                  default:
                    console.log('无法恢复的错误');
                    hls.destroy();
                    break;
                }
              }
            });"""
if old_error not in text:
    raise SystemExit('HLS error block missing')
text = text.replace(old_error, new_error, 1)

# Smoothness-first for new users. Existing explicit localStorage preferences
# remain untouched.
old_default = "    return true;\n  });\n  const blockAdEnabledRef"
new_default = "    return false;\n  });\n  const blockAdEnabledRef"
if old_default not in text:
    raise SystemExit('ad-block default marker missing')
text = text.replace(old_default, new_default, 1)

path.write_text(text, encoding='utf-8')
print('Playback optimization applied')
