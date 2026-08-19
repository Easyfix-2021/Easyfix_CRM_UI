import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        // Background is the CARD surface for editable inputs. With
        // `bg-background` operators reported the field looked greyed
        // out (same hue as the page background), making them think
        // the input was disabled. `bg-card` gives a clean canvas that
        // visually says "click me" — white in light mode, ink-700 in
        // dark — where the old hardcoded `bg-white` stayed white on a
        // dark page. Note `bg-input` is NOT the fill: `--input` is the
        // BORDER colour in this theme (see `border-input` below).
        'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-colors',
        // No focus ring on click — user explicitly asked us to remove
        // the blue outline. We still darken the border via
        // `focus-visible:border-foreground/40` so keyboard-Tab users can
        // see where they are, but mouse-clicked inputs get no ring and
        // no default browser outline (`focus:outline-none` keeps the
        // user-agent default from sneaking back in once Tailwind's ring
        // utility is gone).
        'placeholder:text-muted-foreground focus:outline-none focus-visible:outline-none focus-visible:border-foreground/40',
        // Disabled inputs go GREY (clearly distinct from the white
        // editable state). Tailwind's `disabled:` variant lets us
        // attach this without callers having to repeat the class.
        // Opacity stays at 60% so the prefilled value is still
        // legible (50% was too washed out).
        'disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-700 disabled:opacity-90',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';
