import type { Config } from 'tailwindcss';
// ESM import instead of CommonJS `require('tailwindcss-animate')`. Next.js
// 15 + Node 20's newer ESM loader runs this .ts config as an ES module
// when Tailwind triggers a config refresh during route compilation
// (observed on the call-info page load — `require is not defined`).
// The plugin ships dual CJS + ESM exports so the import works at both
// dev-server boot and on hot-reload.
import animate from 'tailwindcss-animate';

/*
 * Every colour here resolves to a CSS custom property defined in
 * src/app/brand.css, which is GENERATED from src/brand/tokens.ts over
 * src/brand/palette.ts. There are deliberately no colour literals in this file
 * — a rebrand is an edit to palette.ts plus `npm run brand:gen`, and nothing
 * else. `npm run check:brand` enforces that.
 *
 * The `hsl(var(--token))` form is what makes alpha modifiers work: `bg-primary/10`
 * and `border-border/40` are used in ~500 places and a hex-valued custom
 * property cannot support them.
 *
 * Typeface: IBM Plex Sans, weights 400/500/600 only per the identity document,
 * self-hosted via next/font/local in layout.tsx.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem' },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        /*
         * --popover / --popover-foreground have existed in CSS since the shadcn
         * scaffold but were never mapped here, so `bg-popover` compiled to no
         * rule at all and every popover using it rendered TRANSPARENT. The
         * workaround was a hardcoded `bg-white`, which is invisible-by-design in
         * dark mode. Mapping the alias fixes the cause instead of the symptom.
         */
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar))',
          foreground: 'hsl(var(--sidebar-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
        },
        /*
         * Brand ramps — the landing ground for the raw-utility sweep. Every
         * `slate-*` becomes an `ink-*`, every action `sky-*`/`blue-*` becomes
         * `primary`/`brand-*`, and every informational one becomes `info-*`.
         */
        ink: {
          900: 'hsl(var(--ink-900))',
          700: 'hsl(var(--ink-700))',
          500: 'hsl(var(--ink-500))',
          300: 'hsl(var(--ink-300))',
          100: 'hsl(var(--ink-100))',
          50: 'hsl(var(--ink-50))',
        },
        brand: {
          50: 'hsl(var(--brand-50))',
          100: 'hsl(var(--brand-100))',
          500: 'hsl(var(--brand-500))',
          600: 'hsl(var(--brand-600))',
          700: 'hsl(var(--brand-700))',
        },

        /*
         * Meaning families — solid / tint / on-tint text. Both statusColorClass()
         * and StatusChip's TONE_CLASSES collapse onto this one shape, so a status
         * colour is defined once instead of in two parallel tables.
         *
         * The legacy hardcoded `status` palette (#6c7a89, #3598dc, #f39c12,
         * #26c281, #e43a45, #9b59b6) is gone: it was build-time hex, so it could
         * never follow a theme change or render in dark mode, and violet had no
         * counterpart in the identity at all.
         */
        success: {
          DEFAULT: 'hsl(var(--success))',
          tint: 'hsl(var(--success-tint))',
          strong: 'hsl(var(--success-strong))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          tint: 'hsl(var(--warning-tint))',
          strong: 'hsl(var(--warning-strong))',
        },
        urgent: {
          DEFAULT: 'hsl(var(--urgent))',
          tint: 'hsl(var(--urgent-tint))',
          strong: 'hsl(var(--urgent-strong))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          tint: 'hsl(var(--info-tint))',
          strong: 'hsl(var(--info-strong))',
          deep: 'hsl(var(--info-deep))',
        },
        gold: {
          DEFAULT: 'hsl(var(--gold))',
          tint: 'hsl(var(--gold-tint))',
          strong: 'hsl(var(--gold-strong))',
        },
        neutral: {
          DEFAULT: 'hsl(var(--neutral))',
          tint: 'hsl(var(--neutral-tint))',
          strong: 'hsl(var(--neutral-strong))',
        },
      },
      fontFamily: {
        sans: ['var(--font-plex)', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [animate],
};

export default config;
