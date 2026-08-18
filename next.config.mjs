/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    '/api/**/*': ['./node_modules/ffmpeg-static/**'],
  },
};

export default nextConfig;
