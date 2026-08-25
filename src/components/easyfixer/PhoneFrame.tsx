'use client';

import { useEffect, useState, type ReactNode } from 'react';

/*
 * PhoneFrame — a phone bezel around a TRUE 390 × 844 viewport.
 *
 * 390 × 844 is the technician app's design viewport (iPhone 14 logical
 * points). The inner box is held at exactly that size in CSS pixels and
 * the WRAPPER is scaled with `transform: scale()` when the operator's
 * viewport is too short to show it whole. That distinction is the whole
 * point of the component: a scaled transform leaves the framed document
 * believing it is 390 px wide, so the app's media queries, its
 * `Dimensions`-derived layout and its safe-area insets all resolve to the
 * same values they would on a real handset. Shrinking the iframe's own
 * width/height instead would silently move it into a different breakpoint
 * and the operator would be looking at a layout no technician ever sees.
 *
 * Colours are brand tokens only (`npm run check:brand` rejects a
 * `#1a1a1a` bezel and a `bg-slate-900` one alike): the bezel is
 * `bg-foreground` — the darkest ink in the ramp, and correctly inverted
 * in dark mode — the screen well is `bg-background`, and the seam between
 * them is `border-border`.
 */

/** The app's design viewport, in CSS pixels. Never scaled — see above. */
const SCREEN_W = 390;
const SCREEN_H = 844;
/** Bezel thickness and the height of the notch band above the screen. */
const BEZEL = 12;
const NOTCH_H = 28;

const OUTER_W = SCREEN_W + BEZEL * 2;
const OUTER_H = SCREEN_H + NOTCH_H + BEZEL * 2;

/**
 * Vertical room the CRM page chrome (back-link, title, banners, footer
 * note) takes above and below the frame. Subtracted from the viewport
 * before fitting so the whole phone stays on screen without a scroll.
 */
const PAGE_CHROME_PX = 260;
/** Never shrink past this — below it the app's text stops being readable. */
const MIN_SCALE = 0.5;

export function PhoneFrame({
  children,
  label = 'Read-only mirror',
}: {
  children: ReactNode;
  label?: string;
}) {
  /*
   * Start at 1 so the server-rendered markup and the first client commit
   * agree (no hydration mismatch); the effect corrects it immediately.
   */
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const fit = () => {
      const available = window.innerHeight - PAGE_CHROME_PX;
      setScale(Math.max(MIN_SCALE, Math.min(1, available / OUTER_H)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  return (
    /*
     * The outer box carries the SCALED dimensions so the surrounding page
     * reserves the space the frame actually occupies. Without it the
     * layout would still reserve the full 884 px and leave a long gap
     * under a scaled-down phone.
     */
    <div
      className="mx-auto"
      style={{ width: OUTER_W * scale, height: OUTER_H * scale }}
    >
      <div
        className="rounded-[2.25rem] bg-foreground shadow-lg"
        style={{
          width: OUTER_W,
          height: OUTER_H,
          padding: BEZEL,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        {/* Notch band — doubles as the permanent "this is not live" label. */}
        <div
          className="flex items-center justify-center rounded-t-[1.5rem]"
          style={{ height: NOTCH_H, width: SCREEN_W }}
        >
          <span className="text-background text-xs font-medium tracking-wide">
            {label}
          </span>
        </div>
        {/* Screen well — the iframe sits here at a true 390 × 844. */}
        <div
          className="overflow-hidden rounded-[1.5rem] border border-border bg-background"
          style={{ width: SCREEN_W, height: SCREEN_H }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
