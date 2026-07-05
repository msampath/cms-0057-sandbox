import './globals.css';

export const metadata = {
  title: 'CMS-0057-F Interoperability Simulator',
  description:
    'A working simulation of the four payer FHIR APIs mandated by the CMS Interoperability and Prior Authorization final rule (CMS-0057-F), driven by real BCBSIL 2026 prior authorization grid data.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
