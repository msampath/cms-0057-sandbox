/** @type {import('next').NextConfig} */
const nextConfig = {
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
