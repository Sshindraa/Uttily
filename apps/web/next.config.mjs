/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@uttily/core', '@uttily/database', '@uttily/config'],
};

export default nextConfig;
