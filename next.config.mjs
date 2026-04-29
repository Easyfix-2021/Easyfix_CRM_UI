import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // `standalone` output produces a self-contained .next/standalone/ tree
  // (server.js + a pruned node_modules) which the production Docker image
  // copies as-is. This shrinks the runtime image from ~900 MB → ~180 MB
  // and removes the need for `npm` / `next` to be present at runtime.
  // See Dockerfile for the multi-stage that consumes this output.
  output: 'standalone',

  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5100/api'}/:path*`,
      },
    ];
  },
};

export default nextConfig;
