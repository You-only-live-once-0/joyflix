/** @type {import('next').NextConfig} */
/* eslint-disable @typescript-eslint/no-var-requires */
const webpack = require('webpack');
const defaultCache = require('next-pwa/cache');

const resolvedUpstashUrl =
  process.env.UPSTASH_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  '';
const resolvedUpstashToken =
  process.env.UPSTASH_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  '';
const detectedStorageType =
  process.env.NEXT_PUBLIC_STORAGE_TYPE ||
  (resolvedUpstashUrl && resolvedUpstashToken ? 'upstash' : 'localstorage');

const nextConfig = {
  output: 'standalone',
  env: {
    NEXT_PUBLIC_STORAGE_TYPE: detectedStorageType,
    USERNAME: process.env.USERNAME || 'admin',
  },
  eslint: {
    dirs: ['src'],
  },

  reactStrictMode: false,
  swcMinify: true,

  images: {
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 2592000,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },

  webpack(config, { isServer, nextRuntime }) {
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg')
    );

    config.module.rules.push(
      {
        ...fileLoaderRule,
        test: /\.svg$/i,
        resourceQuery: /url/,
      },
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ },
        loader: '@svgr/webpack',
        options: {
          dimensions: false,
          titleProp: true,
        },
      }
    );

    fileLoaderRule.exclude = /\.svg$/i;

    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };

    if ((isServer || nextRuntime) && resolvedUpstashUrl && resolvedUpstashToken) {
      config.plugins.push(
        new webpack.DefinePlugin({
          'process.env.UPSTASH_URL': JSON.stringify(resolvedUpstashUrl),
          'process.env.UPSTASH_TOKEN': JSON.stringify(resolvedUpstashToken),
        })
      );
    }

    return config;
  },
};

const privateApiPattern =
  /\/api\/(?:favorites|playrecords|searchhistory|skipconfigs|admin)(?:\/|$|\?)/i;
const streamingApiPattern = /\/api\/searchstream(?:\?|$)/i;
const streamingMediaPattern =
  /\.(?:m3u8|ts|m4s|mp4|webm|ogv)(?:\?.*)?$/i;

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
});

module.exports = withPWA(nextConfig);
