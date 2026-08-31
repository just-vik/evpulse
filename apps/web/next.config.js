/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
  output: "standalone",

  eslint: {
    ignoreDuringBuilds: true,
  },

  typescript: {
    ignoreBuildErrors: true,
  },


  // Required for standalone output to include node_modules from monorepo root
  outputFileTracingRoot: path.join(__dirname, '../../'),

  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.resolve(__dirname, 'src'),
    };
    // maplibre-gl uses web workers — tell webpack not to parse them as regular modules
    config.module.rules.push({
      test: /maplibre-gl.*\.js$/,
      resolve: { fullySpecified: false },
    });
    return config;
  },

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },

  // Proxy all /api/v1/ requests through Next.js server → avoids CORS/Cloudflare preflight.
  // destination is evaluated at BUILD time (standalone mode), so we pass it as ARG.
  // Default: evpulse-api:3000 (Docker service name). Override via INTERNAL_API_URL for local dev.
  async rewrites() {
    const dest = process.env.INTERNAL_API_URL || 'http://evpulse-api:3000';
    return [
      {
        source: '/api/v1/:path*',
        destination: `${dest}/api/v1/:path*`,
      },
    ];
  },

  headers: async () => [
    {
      source: "/api/:path*",
      headers: [
        { key: "Access-Control-Allow-Credentials", value: "true" },
        { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "Access-Control-Allow-Methods", value: "GET,OPTIONS,PATCH,DELETE,POST,PUT" },
        {
          key: "Access-Control-Allow-Headers",
          value:
            "X-CSRF-Token,X-Requested-With,Accept,Accept-Version,Content-Length,Content-MD5,Content-Type,Date,X-Api-Version",
        },
      ],
    },
    // Prevent browser from caching service worker files
    {
      source: "/sw.js",
      headers: [
        { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" },
        { key: "Service-Worker-Allowed", value: "/" },
      ],
    },
    {
      source: "/workbox-:hash.js",
      headers: [
        { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" },
      ],
    },
  ],

  env: {
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000",
    NEXT_PUBLIC_MAPBOX_TOKEN: process.env.NEXT_PUBLIC_MAPBOX_TOKEN,
  },
}

module.exports = nextConfig
