import './globals.css';

export const metadata = {
  title: 'CMS-0057-F Simulator',
  description: 'Dual-window Interoperability Simulator for the CMS-0057-F workflow'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
