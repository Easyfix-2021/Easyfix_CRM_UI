/**
 * The EasyFix logo — one component for every surface.
 *
 * WHY THIS EXISTS
 *
 * The logo used to be five hardcoded `<Image src="/logo.png">` tags across the
 * sidebar, login and three public pages, pointing at three PNGs. Two of them
 * were the same file byte-for-byte, and the asset itself was CYAN rather than
 * brand red — so on a light surface the white "EASY" disappeared and the mark
 * read as "Fix" beside a floating blue house. That is why the login page wraps
 * it in a dark contrast pill.
 *
 * Collapsing the five sites into one component is what makes the rest possible:
 * a surface-aware variant, a festival ornament, and a future brand change all
 * happen here instead of in five places that were already out of step.
 *
 * `npm run check:brand` forbids `<Image src="/logo…">` anywhere except this
 * file, so the five sites cannot quietly come back.
 */

import Image from 'next/image';

export type LogoVariant = 'tagline' | 'horizontal' | 'wordmark' | 'icon';
export type LogoSurface = 'light' | 'dark' | 'auto';

/*
 * Intrinsic aspect ratios, taken from each asset's viewBox in the brand kit.
 *
 * These are why `height` alone is enough to size the logo: width is derived, so
 * the box is correct on the very first paint and nothing reflows when the SVG
 * loads. Getting one wrong shows up as layout shift, not as a wrong-looking
 * logo, which is the harder bug to spot — so they are transcribed, not guessed.
 *
 * THEY TRACK THE KIT AND MUST BE RE-READ WHEN IT IS REGENERATED. The 2026-08-18
 * regeneration changed the tagline lockup from 315.361 to 297.639 tall — a 6%
 * shift that silently mis-sizes every tagline render until this constant moves
 * with it. `npm run brand:sync` refreshes the FILES; nothing refreshes these
 * numbers, so check them whenever sync reports a lockup updated.
 */
const ASPECT: Record<LogoVariant, number> = {
  tagline: 1000 / 297.639,
  horizontal: 1000 / 242.542,
  wordmark: 1000 / 196.327,
  // Tiles are square, so the icon variant is 1:1.
  icon: 1,
};

/*
 * `-onlight` is the two-ink treatment: ink wordmark, red house and red "Fix".
 * `-ondark` is its counterpart for dark grounds.
 */
const SRC: Record<LogoVariant, { light: string; dark: string }> = {
  tagline: {
    light: '/brand/logo-tagline-onlight.svg',
    dark: '/brand/logo-tagline-ondark.svg',
  },
  horizontal: {
    light: '/brand/logo-horizontal-onlight.svg',
    dark: '/brand/logo-horizontal-ondark.svg',
  },
  wordmark: {
    light: '/brand/wordmark-onlight.svg',
    dark: '/brand/wordmark-ondark.svg',
  },
  /*
   * `icon` is a TILE, not a silhouette — it carries its own background. The kit
   * dropped the bare `mark-*` family on 2026-08-18 and ships these instead, so
   * the red tile goes on light grounds and the white tile on dark ones, each
   * chosen to stand out rather than to match the surface behind it.
   */
  icon: {
    light: '/brand/icon-rounded-red.svg',
    dark: '/brand/icon-rounded.svg',
  },
};

export type LogoProps = {
  variant?: LogoVariant;
  surface?: LogoSurface;
  /** Rendered height in px. Width follows from the asset's own aspect ratio. */
  height?: number;
  className?: string;
  priority?: boolean;
  alt?: string;
};

export function Logo({
  variant = 'horizontal',
  surface = 'light',
  height = 32,
  className,
  priority = false,
  alt = 'EasyFix',
}: LogoProps) {
  const width = Math.round(height * ASPECT[variant]);
  const src = SRC[variant];

  /*
   * `auto` renders BOTH files and lets CSS pick — no JS, no hydration flash.
   *
   * A JS-driven choice would need the theme before first paint, and reading
   * localStorage in a client component happens after hydration: the wrong logo
   * would show for a frame on every load. Two <img> tags cost a few hundred
   * bytes and are correct from the first pixel. Only one is ever visible, and
   * the hidden one is marked aria-hidden so it is announced once, not twice.
   */
  if (surface === 'auto') {
    return (
      <>
        <Image
          src={src.light}
          alt={alt}
          width={width}
          height={height}
          priority={priority}
          className={`dark:hidden ${className ?? ''}`}
        />
        <Image
          src={src.dark}
          alt=""
          aria-hidden="true"
          width={width}
          height={height}
          priority={priority}
          className={`hidden dark:block ${className ?? ''}`}
        />
      </>
    );
  }

  return (
    <Image
      src={surface === 'dark' ? src.dark : src.light}
      alt={alt}
      width={width}
      height={height}
      priority={priority}
      className={className}
    />
  );
}

export default Logo;
