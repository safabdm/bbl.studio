import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const title = 'Website Design in Orange County | BBLS Studio';
const description = 'BBLS is a boutique website design studio serving Orange County businesses. Distinctive websites designed to build credibility, generate inquiries, and support business growth.';

export const metadata: Metadata = {
  metadataBase: new URL('https://bbls.studio'),
  title,
  description,
  applicationName: 'BBLS',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  openGraph: {
    title,
    description,
    type: 'website',
    locale: 'en_US',
    siteName: 'BBLS',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'BBLS Boutique Brand & Launch Studio in Orange County. Website design, brand, and launch support.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
