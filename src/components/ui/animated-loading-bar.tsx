'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

type Tone = 'sky' | 'emerald' | 'rose' | 'slate';

const TONE_CLASS: Record<Tone, { text: string; border: string; bg: string }> = {
  sky:     { text: 'text-sky-700',     border: 'border-sky-200',     bg: 'bg-sky-50/60' },
  emerald: { text: 'text-emerald-700', border: 'border-emerald-200', bg: 'bg-emerald-50/60' },
  rose:    { text: 'text-rose-700',    border: 'border-rose-200',    bg: 'bg-rose-50/60' },
  slate:   { text: 'text-slate-600',   border: 'border-slate-200',   bg: 'bg-white/95' },
};

/*
 * Animated loading strip that fades + slides in/out smoothly (2026-06-11).
 *
 * Extracted from the public Profile Update form after the third inline
 * occurrence appeared. Pattern: render the bar UNCONDITIONALLY but
 * animate `opacity` + `max-height` + `border-color` + `bg` in lockstep
 * via Tailwind's `transition-all duration-200 ease-out`. Result is a
 * smooth slide-in / fade-in instead of an abrupt pop — and zero layout
 * shift on its surrounding content when it appears/disappears.
 *
 * `aria-hidden` mirrors the visible state so screen readers don't
 * announce stale "loading" text in the resting state.
 *
 * Props:
 *   - `visible`: drives the animation. State flips trigger the fade.
 *   - `message`: the operator-facing label next to the spinner.
 *   - `tone`: colour theme. Defaults to `sky` (informational). Use
 *     `emerald` for success/save flows, `rose` for warning flows,
 *     `slate` for muted neutral indicators (e.g. inside scrollable
 *     result containers where the visual weight should fade in).
 *   - `sticky`: when true, pins the bar to the top of its nearest
 *     scrolling ancestor (use inside `overflow-y-auto` containers,
 *     e.g. the pincode-search results list). Drops the rounded
 *     corners since sticky bars usually run edge-to-edge of their
 *     container; raises z-index above scrolling content.
 */
export function AnimatedLoadingBar({
  visible,
  message,
  tone = 'sky',
  sticky = false,
}: {
  visible: boolean;
  message: string;
  tone?: Tone;
  sticky?: boolean;
}) {
  const t = TONE_CLASS[tone];
  return (
    <div
      aria-hidden={!visible}
      className={
        `flex items-center gap-1.5 text-[11px] ${t.text} ` +
        `overflow-hidden transition-all duration-200 ease-out border ` +
        (sticky
          ? 'sticky top-0 z-10 backdrop-blur-[1px] rounded-none '
          : 'rounded-md ') +
        (visible
          ? `max-h-10 opacity-100 px-3 py-1.5 ${t.border} ${t.bg}`
          : 'max-h-0 opacity-0 px-3 py-0 border-transparent bg-transparent')
      }
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> {message}
    </div>
  );
}
