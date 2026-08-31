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

export const metadata: Metadata = {
  metadataBase: new URL('https://bbls-launch-studio.safa-bdm.chatgpt.site'),
  title: 'BBLS — Boutique Brand & Website Studio',
  description: 'Distinctive brand identities and custom websites for founder-led businesses.',
  openGraph: {
    title: 'BBLS — Boutique Brand & Website Studio',
    description: 'Distinctive brand identities and custom websites for founder-led businesses.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'BBLS — Boutique Brand & Website Studio.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'BBLS — Boutique Brand & Website Studio',
    description: 'Distinctive brand identities and custom websites for founder-led businesses.',
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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
