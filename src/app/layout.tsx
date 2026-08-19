import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { THEME_INIT_SCRIPT } from '@/lib/use-theme';

/*
 * IBM Plex Sans is SELF-HOSTED, not pulled from Google Fonts at build time.
 *
 * `next/font/google` downloads the woff2 from fonts.gstatic.com during
 * `next build`, which makes every production image build depend on outbound
 * internet from the Docker builder. That dependency already broke the Prod UI
 * deploy once, on the font this replaces:
 *
 *     Failed to fetch font file from `https://fonts.gstatic.com/...woff2`
 *     Build failed because of webpack errors
 *
 * Next retries three times and then fails outright — no fallback path — so a
 * blocked egress rule or a rate-limited CI IP takes the whole deploy down.
 * Vendoring keeps the build hermetic. Do not "simplify" this back to
 * next/font/google.
 *
 * WHY THREE FILES INSTEAD OF ONE VARIABLE FONT
 *
 * Mulish shipped as a single variable woff2 spanning 400-700. IBM Plex Sans has
 * no variable release, and the EasyFix identity permits exactly three weights —
 * 400, 500, 600 — so three static faces is the complete set rather than a
 * subset. Weights above 600 are a brand violation and `npm run check:brand`
 * rejects `font-bold`, so there is deliberately no 700 face to fall back on.
 *
 * IBM Plex is SIL Open Font License 1.1; OFL.txt ships alongside the fonts.
 * Source: EasyFix-Brand-Kit/build/fonts/, converted TTF -> woff2.
 *
 * Devanagari is NOT bundled: the CRM is staff-facing and English-only. The
 * technician app bundles IBM Plex Sans Devanagari because it renders Hindi.
 */
const plex = localFont({
  src: [
    { path: './fonts/ibm-plex-sans-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-sans-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-sans-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-plex',
  display: 'swap',
  // Metric-compatible fallbacks so swap-in does not shift layout.
  fallback: ['system-ui', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
});

export const metadata: Metadata = {
  title: 'EasyFix CRM',
  description: 'Internal CRM for EasyFix operations',
  /*
   * A real favicon set, not one wordmark reused everywhere.
   *
   * This used to be `/favicon.png` for both slots — a 1054x276 wordmark, so the
   * browser squashed a 3.8:1 strip into a 16px square tab and iOS did the same
   * on the home screen. The set below is the mark rendered at each target size:
   * .ico first for legacy tab chrome, the pngs for browsers that read `sizes`,
   * and a purpose-built 180px apple-touch-icon for iOS.
   */
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16.png', type: 'image/png', sizes: '16x16' },
      { url: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
      { url: '/icon-512.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={plex.variable} suppressHydrationWarning>
      <head>
        {/*
          * Sets the `dark` class BEFORE first paint.
          *
          * The theme lives in localStorage, which a client component can only
          * read after hydration — so without this every load would paint light
          * and then snap to dark a frame later. A blocking inline script is the
          * standard fix and the only one that has no flash.
          *
          * suppressHydrationWarning on <html> is required: this script mutates
          * the class list before React reconciles, so server and client markup
          * legitimately differ on that one attribute.
          */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans antialiased bg-background text-foreground">{children}</body>
    </html>
  );
}
