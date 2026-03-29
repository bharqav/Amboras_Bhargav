import './globals.css';
import type { Metadata } from 'next';
import { Space_Grotesk, IBM_Plex_Sans } from 'next/font/google';

const heading = Space_Grotesk({ subsets: ['latin'], variable: '--font-heading', weight: ['400', '600', '700'] });
const body = IBM_Plex_Sans({ subsets: ['latin'], variable: '--font-body', weight: ['400', '500', '600'] });

export const metadata: Metadata = {
  title: 'Store Analytics Dashboard',
  description: 'Amboras take-home analytics dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${heading.variable} ${body.variable}`}>{children}</body>
    </html>
  );
}
