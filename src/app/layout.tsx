import type { Metadata } from 'next';
import { Mulish } from 'next/font/google';
import './globals.css';

const mulish = Mulish({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mulish',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'EasyFix CRM',
  description: 'Internal CRM for EasyFix operations',
  icons: { icon: '/favicon.png', apple: '/favicon.png' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mulish.variable}>
      <body className="font-sans antialiased bg-background text-foreground">{children}</body>
    </html>
  );
}
