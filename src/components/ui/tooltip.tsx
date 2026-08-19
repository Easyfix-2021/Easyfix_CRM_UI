'use client';

import * as React from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
 * InfoTooltip — lightweight hover/click info popover (no Radix; matches the
 * project's dependency-light primitives, see components/ui/switch.tsx).
 *
 * CONTROLLED via React state, rendered ONLY while open (`{open && …}`) so it
 * is never pre-shown on mount. Behaviour:
 *   - Hover the icon → opens.
 *   - Leaving the icon does NOT close immediately — a 3s grace timer runs so
 *     the cursor can travel across the small gap onto the panel. Entering the
 *     panel (a DOM descendant) cancels the timer, so the panel stays open and
 *     is scrollable. Leaving the panel restarts the 3s grace, then it closes.
 *   - Click the icon → toggles (sticky open on touch / by intent).
 * The same explanation is always available non-hover in
 * Settings → Manage Auto Allocation → How It Works.
 */
const GRACE_MS = 3000;

export function InfoTooltip({
  children,
  label = 'More info',
  side = 'bottom',
  align = 'start',
  className,
  panelClassName,
}: {
  children: React.ReactNode;
  label?: string;
  side?: 'bottom' | 'top';
  align?: 'start' | 'end';
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = React.useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  const show = React.useCallback(() => { clearTimer(); setOpen(true); }, [clearTimer]);
  const hideSoon = React.useCallback((ms = GRACE_MS) => {
    clearTimer();
    timer.current = setTimeout(() => { setOpen(false); timer.current = null; }, ms);
  }, [clearTimer]);
  // Cleanup any pending timer on unmount.
  React.useEffect(() => clearTimer, [clearTimer]);

  const sideCls = side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2';
  const alignCls = align === 'end' ? 'right-0' : 'left-0';

  return (
    <span
      className={cn('relative inline-flex align-middle', className)}
      onMouseEnter={show}
      onMouseLeave={() => hideSoon()}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => (open ? (clearTimer(), setOpen(false)) : show())}
        className="inline-flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-help"
      >
        <Info className="size-4" />
      </button>
      {open && (
        <span
          role="tooltip"
          // Re-assert handlers on the panel too: it sits across a margin gap
          // from the icon, so guarantee enter cancels / leave restarts the grace.
          onMouseEnter={show}
          onMouseLeave={() => hideSoon()}
          className={cn(
            'absolute z-50 w-80 max-w-[22rem] max-h-[60vh] overflow-y-auto rounded-md border border-ink-100 bg-popover p-3',
            'text-left text-xs font-normal leading-relaxed text-ink-700 shadow-xl',
            sideCls,
            alignCls,
            panelClassName,
          )}
        >
          {children}
        </span>
      )}
    </span>
  );
}
