/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['postgres'],
  transpilePackages: ['@uttily/core', '@uttily/database', '@uttily/config'],
  async headers() {
    return [
      {
        // Public font assets must also load inside Stripe's cross-origin frames.
        source: '/fonts/sora/:path*',
        headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }],
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
