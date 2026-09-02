'use client';
import * as React from 'react';
import { ChevronDown, ChevronUp, CheckCircle2, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
 * Collapsible accordion section used by the Easyfixer Verification page.
 * Used both for the 3 outer sections (Lead, Registration Verification,
 * Technician Activation) and for the 4 inner sub-sections (Professional,
 * Personal & Family, Banking, Identity Documents).
 *
 * - `progress` (0-100) renders the slim bar under the title; pass null to hide.
 * - `verified` swaps the circle icon for the green check.
 * - `headerTone`:
 *     'primary' = blue gradient band (matches legacy outer-section header)
 *     'sub'     = lighter grey band (inner sub-section header)
 */

/*
 * Discriminated prop types (2026-06-11). Callers MUST pick exactly
 * one open-state source: `open` (controlled by parent) OR `defaultOpen`
 * (uncontrolled, seeded once). `never` on the opposing field prevents
 * accidentally mixing the two — a previously-silent footgun where
 * `open` would silently win and `defaultOpen` became a no-op.
 *
 * `onOpenChange` stays in BaseProps — even uncontrolled callers may
 * want to observe state changes, so it's not part of the discrimination.
 */
type BaseProps = {
  title: React.ReactNode;
  progress?: number | null;
  verified?: boolean;
  headerTone?: 'primary' | 'sub';
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
};
type ControlledProps = {
  open: boolean;
  defaultOpen?: never;
};
type UncontrolledProps = {
  open?: never;
  defaultOpen?: boolean;
};
export type VerificationSectionProps = BaseProps & (ControlledProps | UncontrolledProps);

export function VerificationSection({
  title,
  progress = null,
  verified = false,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  headerTone = 'primary',
  rightSlot,
  children,
}: VerificationSectionProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const handleToggle = () => {
    const next = !open;
    if (isControlled) {
      onOpenChange?.(next);
    } else {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    }
  };

  return (
    <div className={cn(
      'rounded-md border bg-card shadow-sm overflow-hidden',
      headerTone === 'primary' ? 'border-ink-100' : 'border-ink-100',
    )}>
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          'w-full text-left px-4 py-3 flex items-center gap-3 transition-colors',
          /*
           * (a) STABLE SURFACE — the hover's dark gradient stop moved from
           * `--brand-700` to `--destructive-strong`, which is the SAME COLOUR
           * under a name that does not invert.
           *
           * The resting pair is already safe: `--brand-600` (38.82%) and
           * `--primary` (45.49%) are both STABLE — one value in `:root` and in
           * `.dark` — so `text-white` holds in both themes. The hover was not.
           * `--brand-700` is 355.51 69.03% 30.39% in `:root` but 355 57.14%
           * 91.76% in `.dark`: it and `--brand-100` swap with each other, so
           * hovering this header in dark mode slid the left half of the
           * gradient to a near-white pink under the white label — the same
           * failure commit 497cd6e measured on DialogHeader, where `--ink-900`
           * went 17.31:1 to 1.08:1 against white.
           *
           * `--destructive-strong` is declared 355.51 69.03% 30.39% on BOTH
           * sides of brand.css — string-identical to light-mode `--brand-700`,
           * not merely close — so the LIGHT THEME RENDERS PIXEL-IDENTICALLY and
           * dark mode now darkens on hover instead of inverting. It is the same
           * step of the brand-red ramp; the app already leans on it for exactly
           * this job in `bg-destructive hover:bg-destructive-strong` (see
           * MagicLinkActionPopup, quicksight/vertical-orders), which is why it
           * is the stable name available at this lightness.
           *
           * `hover:to-brand-600` needs no change — `--brand-600` is stable.
           */
          headerTone === 'primary'
            ? 'bg-gradient-to-r from-brand-600 to-primary text-white hover:from-destructive-strong hover:to-brand-600'
            : 'bg-ink-50 hover:bg-ink-100 text-ink-700',
        )}
      >
        {verified ? (
          <CheckCircle2 className={cn('h-5 w-5 shrink-0', headerTone === 'primary' ? 'text-success-tint' : 'text-success-strong')} />
        ) : (
          <Circle className={cn('h-5 w-5 shrink-0 opacity-70', headerTone === 'primary' ? 'text-white' : 'text-ink-500')} />
        )}
        <div className="flex-1 min-w-0">
          <div className={cn('font-semibold text-sm', headerTone === 'primary' ? 'tracking-wide uppercase' : '')}>
            {title}
          </div>
          {progress != null && (
            <div className={cn(
              'mt-1.5 h-1.5 w-full rounded-full overflow-hidden',
              headerTone === 'primary' ? 'bg-white/30' : 'bg-ink-100',
            )}>
              <div
                className={cn(
                  'h-full transition-all',
                  headerTone === 'primary' ? 'bg-white' : 'bg-success',
                )}
                style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
              />
            </div>
          )}
        </div>
        {progress != null && (
          <span className={cn('text-xs font-medium tabular-nums', headerTone === 'primary' ? 'text-white' : 'text-ink-700')}>
            {Math.round(progress)}%
          </span>
        )}
        {rightSlot}
        {open ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
      </button>
      {open && (
        <div className={cn(
          'p-4',
          headerTone === 'primary' ? 'bg-card' : 'bg-card border-t border-ink-100',
        )}>
          {children}
        </div>
      )}
    </div>
  );
}
