import './globals.css';

// Next's default for prerendered pages is Cache-Control: s-maxage=31536000,
// which lets the Firebase Hosting CDN pin the HTML shell for a year. The
// shell then survives redeploys and the public URL keeps serving old markup
// while the API routes (already Cache-Control: private) return fresh data.
// Capping revalidation at a minute keeps static generation and still lets a
// deploy show up. Applies to every segment below this layout.
export const revalidate = 60;

export const metadata = {
  title: 'CMS-0057-F and CMS-0062-P Interoperability Sandbox',
  description:
    'A working model of the CMS-0057-F final rule payer FHIR APIs, extended for the proposed CMS-0062-P drug prior authorization rule and driven by BCBSIL 2026 prior authorization grid data.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
