'use client';

import * as React from 'react';

/*
 * MarqueeOnHover — single-line text that:
 *   - renders truncated by `overflow-hidden` when it fits,
 *   - starts scrolling left on parent `:hover`, continuously, until
 *     the entire text has moved off the left edge, then loops without
 *     any pause/hold between iterations,
 *   - snaps back to its start position the instant hover ends (the CSS
 *     removes the `animation` property when the `:hover` rule no
 *     longer matches, dropping the transform to identity).
 *
 * Animation is CSS-keyframes driven (see `@keyframes marquee-scroll`
 * in globals.css). No JS rAF loop runs on idle cards. The component
 * computes the inner span's `scrollWidth` once + on resize and sets
 * `--marquee-distance` so the same keyframe scales to any text
 * length.
 *
 * Trigger rule (globals.css): `a:hover .group-hover-marquee` — the
 * marquee only activates when the immediate parent (or ancestor) is
 * an `<a>` element being hovered. That's how FlowCardTile and
 * AttentionSummary trigger it: their tiles are `<Link>` (which
 * renders as `<a>`).
 *
 * Extracted from `app/(authed)/dashboard/page.tsx` on 2026-05-28 so
 * AttentionSummary can re-use the same pattern. The original FlowCardTile
 * usage continues to import from here.
 */
export function MarqueeOnHover({
  children,
  className,
  animateOverride,
  durationOverride,
  onMeasure,
}: {
  children: React.ReactNode;
  className?: string;
  /*
   * When set by the parent (e.g. FlowCardTile decides "if either line
   * overflows, both animate"), this overrides the local overflow check.
   * Lets two side-by-side marquees stay synchronised so the visual
   * doesn't have one line moving while the other sits still.
   */
  animateOverride?: boolean;
  /*
   * When set, replaces the locally-computed duration in milliseconds
   * (2026-05-28). Used to keep two lines on the same card in
   * lockstep: the parent picks the MAX duration across both children
   * and feeds it back here so the shorter text scrolls slower —
   * both lines complete each cycle at exactly the same moment,
   * eliminating the desync that otherwise grows loop-by-loop.
   */
  durationOverride?: number;
  /*
   * Reports the local overflow status AND inner scroll width back to
   * the parent so a card can union the per-line states into one
   * shared decision (overflow union → animateOverride; max exitDist
   * → durationOverride).
   *
   * `exitDist` is the inner span's full scrollWidth in pixels, used
   * by the parent to compute a shared duration that matches the
   * longest line.
   */
  onMeasure?: (overflows: boolean, exitDist: number) => void;
}) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const innerRef = React.useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = React.useState(0);
  const [exitDist, setExitDist] = React.useState(0);

  React.useEffect(() => {
    const measure = () => {
      const w = wrapRef.current?.clientWidth ?? 0;
      const i = innerRef.current?.scrollWidth ?? 0;
      const ov = Math.max(0, i - w);
      setOverflow(ov);
      setExitDist(i);
      onMeasure?.(ov > 0, i);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [children, onMeasure]);

  // animate if EITHER our own line overflows OR the parent told us to
  // (because a sibling line on the same card overflows). Keeps both
  // lines moving in unison even when one of them fits.
  const animates = (animateOverride ?? false) || overflow > 0;
  /*
   * Duration is proportional to distance (1 px ≈ 12ms → ~80 px/sec).
   * Min duration 3000ms keeps very short overflows from looking
   * frantic. The +16px buffer on `--marquee-distance` ensures the
   * last character clears the wrapper's right edge before the loop
   * restart, so no half-character is visible at the moment of snap.
   *
   * `durationOverride` (2026-05-28) lets the parent pin both lines to
   * the SAME duration — the shared duration is the max of both
   * children's locally-computed values, so the shorter text scrolls
   * slower and both finish in lockstep.
   */
  const PX_PER_SEC = 80;
  const localDurationMs = Math.max(3000, Math.round((exitDist / PX_PER_SEC) * 1000));
  const durationMs = durationOverride ?? localDurationMs;

  return (
    <div ref={wrapRef} className={`${className ?? ''} overflow-hidden`}>
      <span
        ref={innerRef}
        /*
         * `group-hover-marquee` is the consumer hook the CSS rule
         * `a:hover .group-hover-marquee` watches. No animation is
         * applied by default — the transform sits at translateX(0).
         * On parent <a>:hover, the CSS grafts the animation onto this
         * span and the keyframe plays. On hover-out, the animation
         * declaration is removed and the transform snaps back to 0 —
         * giving the "reset from start" behaviour. Next hover replays
         * the keyframe from 0% with no leftover frame position.
         */
        className={`inline-block whitespace-nowrap ${animates ? 'group-hover-marquee' : ''}`}
        style={
          animates
            ? ({
                ['--marquee-distance' as string]: `-${exitDist + 16}px`,
                ['--marquee-duration' as string]: `${durationMs}ms`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {children}
      </span>
    </div>
  );
}
