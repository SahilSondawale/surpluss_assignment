import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Smaller Docker image: the build contains only the files needed to run.
  output: 'standalone',
};

export default nextConfig;
