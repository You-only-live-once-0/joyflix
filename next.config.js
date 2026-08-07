/** @type {import('next').NextConfig} */
/* eslint-disable @typescript-eslint/no-var-requires */
const webpack = require('webpack');

const resolvedUpstashUrl =
  process.env.UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const resolvedUpstashToken =
  process.env.UPSTASH_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
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
    unoptimized: true,
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

const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  skipWaiting: true,
});

module.exports = withPWA(nextConfig);
