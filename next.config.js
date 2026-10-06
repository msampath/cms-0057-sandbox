/** @type {import('next').NextConfig} */
const nextConfig = {
  // Served at surakshith.com/cms-0057 behind a Firebase Hosting rewrite to
  // Cloud Run (the portfolio site owns the domain root). Hardcoded rather
  // than env-driven so dev, Docker, and
  // prod all serve identical paths: http://localhost:3000/cms-0057.
  // next/link and static assets pick this up automatically; literal fetch()
  // calls in client components go through lib/basePath.js apiUrl().
  basePath: '/cms-0057',
  reactStrictMode: true,
  // The SMART App Launcher and the CDS Hooks Sandbox open /ehr/launch in an
  // iframe. Firebase Hosting adds X-Frame-Options: DENY to every path on the
  // domain, and browsers ignore X-Frame-Options when a CSP frame-ancestors
  // directive is present, so this list is what decides who may frame pages.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' https://launch.smarthealthit.org https://sandbox.cds-hooks.org"
          }
        ]
      }
    ];
  },
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
