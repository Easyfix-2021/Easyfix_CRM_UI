import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

/*
 * Mulish is SELF-HOSTED, not pulled from Google Fonts at build time.
 *
 * `next/font/google` downloads the woff2 from fonts.gstatic.com during
 * `next build`, which makes every production image build depend on outbound
 * internet from the Docker builder. That dependency broke the Prod UI deploy:
 *
 *     Failed to fetch font file from `https://fonts.gstatic.com/...woff2`
 *     `next/font` error: Failed to fetch `Mulish` from Google Fonts.
 *     Build failed because of webpack errors
 *
 * Next retries three times and then fails the build outright — there is no
 * fallback path, so a blocked egress rule, a DNS hiccup or Google rate-limiting
 * the CI IP takes the whole deploy down. Vendoring the file makes the build
 * hermetic: no network, no retry, no flake, and one fewer third party in the
 * deploy path.
 *
 * The file is the LATIN subset of Mulish v18 — a VARIABLE font, so this single
 * ~30 KB woff2 covers the whole 400–700 range the UI uses (previously four
 * static weights). `weight: '400 700'` declares that range to the browser.
 * Mulish is SIL Open Font License 1.1, which permits redistribution.
 *
 * To refresh: fetch the CSS below and download the src URL from the block
 * commented "latin" (NOT latin-ext), replacing fonts/mulish-latin.woff2:
 * https://fonts.googleapis.com/css2?family=Mulish:wght@400;500;600;700&display=swap
 */
const mulish = localFont({
  src: './fonts/mulish-latin.woff2',
  weight: '400 700',
  style: 'normal',
  variable: '--font-mulish',
  display: 'swap',
  // Keeps the metric-compatible fallback Next would otherwise infer from the
  // Google metadata we no longer fetch, so swap-in doesn't shift layout.
  fallback: ['system-ui', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
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
