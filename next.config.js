/** @type {import('next').NextConfig} */
const nextConfig = {
  // Served at surakshith.com/cms-0057 behind CloudFront (portfolio site owns
  // the domain root). Hardcoded rather than env-driven so dev, Docker, and
  // prod all serve identical paths: http://localhost:3000/cms-0057.
  // next/link and static assets pick this up automatically; literal fetch()
  // calls in client components go through lib/basePath.js apiUrl().
  basePath: '/cms-0057',
  reactStrictMode: true,
  webpack: (config) => {
    // Webpack walks up from the project root looking for things to watch.
    // On Windows non-system drives that includes folders the user can't
    // lstat (System Volume Information, $Recycle.Bin, Temp). Telling
    // Webpack to ignore them silences the "Watchpack Error: EINVAL" spam.
    config.watchOptions = {
      ...config.watchOptions,
      ignored: [
        '**/node_modules',
        '**/.git',
        '**/.next',
        'I:/System Volume Information',
        'I:/Temp',
        'I:/$Recycle.Bin'
      ]
    };
    return config;
  }
};

module.exports = nextConfig;
