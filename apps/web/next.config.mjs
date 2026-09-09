/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['postgres'],
  transpilePackages: ['@uttily/core', '@uttily/database', '@uttily/config'],
  images: {
    qualities: [75, 90],
  },
  async headers() {
    return [
      {
        // Public font assets must also load inside Stripe's cross-origin frames.
        source: '/fonts/sora/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cache-Control', value: 'public, max-age=86400' },
        ],
      },
      {
        // The remaining bundled fonts are static and safe to reuse between visits.
        source: '/fonts/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }],
      },
      {
        // The logo is a bundled asset, unlike user-uploaded rental photos.
        source: '/images/brand/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }],
      },
    ];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '12mb',
    },
  },
};

export default nextConfig;
