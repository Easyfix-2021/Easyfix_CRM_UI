'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/*
 * Checkbox — the shared, styled native checkbox.
 *
 * Why a component and not a bare `<input type="checkbox">`: two things a raw
 * input can't do inline.
 *
 *   1. INDETERMINATE. It is a DOM *property*, not an attribute — React will
 *      not set it from JSX, so a "some of this page is selected" header
 *      checkbox rendered as plain JSX silently shows as unchecked. The ref
 *      effect below is the only way to drive it, and putting it here means no
 *      caller has to remember.
 *   2. A DISABLED CHECKBOX SWALLOWS ITS OWN TOOLTIP. Browsers suppress
 *      pointer events on a disabled control, so `title` never fires and the
 *      operator gets an unexplained dead box. The wrapper `<span>` carries
 *      the title instead, so hovering a blocked row still says WHY.
 *
 * Row-selection callers should pass `title` on the disabled case — an
 * un-clickable control with no explanation is how operators learn a rule from
 * a failure summary instead of from the screen.
 */
export function Checkbox({
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
  title,
  label,
  className,
}: {
  checked: boolean;
  /** Renders the mixed "–" state. Ignored when `checked` is true. */
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  /** Hover text. Survives `disabled` because it lives on the wrapper. */
  title?: string;
  /** Accessible name — required when there is no visible <label> beside it. */
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !checked && indeterminate;
  }, [checked, indeterminate]);

  return (
    <span title={title} className={cn('inline-flex items-center', disabled && 'cursor-not-allowed')}>
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          'h-4 w-4 cursor-pointer accent-primary align-middle',
          disabled && 'cursor-not-allowed opacity-40',
          className,
        )}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
        // Row checkboxes sit inside cells that may gain click handlers later;
        // stop the click here so selecting never doubles as "open the row".
        onClick={(e) => e.stopPropagation()}
      />
    </span>
  );
}
