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
      headerTone === 'primary' ? 'border-slate-200' : 'border-slate-100',
    )}>
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          'w-full text-left px-4 py-3 flex items-center gap-3 transition-colors',
          headerTone === 'primary'
            ? 'bg-gradient-to-r from-sky-700 to-sky-500 text-white hover:from-sky-600 hover:to-sky-400'
            : 'bg-slate-50 hover:bg-slate-100 text-slate-700',
        )}
      >
        {verified ? (
          <CheckCircle2 className={cn('h-5 w-5 shrink-0', headerTone === 'primary' ? 'text-emerald-300' : 'text-emerald-600')} />
        ) : (
          <Circle className={cn('h-5 w-5 shrink-0 opacity-70', headerTone === 'primary' ? 'text-white' : 'text-slate-400')} />
        )}
        <div className="flex-1 min-w-0">
          <div className={cn('font-semibold text-sm', headerTone === 'primary' ? 'tracking-wide uppercase' : '')}>
            {title}
          </div>
          {progress != null && (
            <div className={cn(
              'mt-1.5 h-1.5 w-full rounded-full overflow-hidden',
              headerTone === 'primary' ? 'bg-white/30' : 'bg-slate-200',
            )}>
              <div
                className={cn(
                  'h-full transition-all',
                  headerTone === 'primary' ? 'bg-white' : 'bg-emerald-500',
                )}
                style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
              />
            </div>
          )}
        </div>
        {progress != null && (
          <span className={cn('text-xs font-medium tabular-nums', headerTone === 'primary' ? 'text-white' : 'text-slate-600')}>
            {Math.round(progress)}%
          </span>
        )}
        {rightSlot}
        {open ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
      </button>
      {open && (
        <div className={cn(
          'p-4',
          headerTone === 'primary' ? 'bg-white' : 'bg-white border-t border-slate-100',
        )}>
          {children}
        </div>
      )}
    </div>
  );
}
