'use client';

import type { LucideIcon } from 'lucide-react';
import type { MouseEventHandler } from 'react';
import { cn } from '@/lib/utils';

/*
 * IconButton — the single canonical per-row action icon for the CRM.
 *
 * Before this component, four divergent styles coexisted across the
 * settings + list pages: naked `p-1` icons (Manage Users/Roles/Pincodes),
 * boxed shadcn `<Button size="sm" variant="ghost">` (10 settings pages —
 * the heavy box-fill we're eliminating), text-link `hover:underline` icons
 * (Deep Skills, Zones), and the RowActionsMenu cluster (Manage Clients).
 * This unifies them: ONE naked icon button, uniform size/padding/color
 * everywhere, hover = subtle bg tint (not a heavy boxed fill), intent
 * drives the icon color.
 *
 * Layout-agnostic on purpose: it renders only the button. The page owns
 * the wrapping `<td>` / flex `<div>` (right-aligned, centered, frozen
 * column, etc.) so it drops into every existing row-action cell.
 *
 * Intent → color:
 *   default  — muted-foreground, hover→foreground (view/info/neutral)
 *   primary  — blue-600,    hover→blue-700    (edit / primary action)
 *   danger   — red-600,     hover→red-700     (deactivate / delete)
 *   success  — emerald-600, hover→emerald-700 (reactivate / mark-serviceable)
 *
 * Sizing is fixed (NOT a prop) so it cannot drift per-page: a `size-4`
 * (16px) icon with a snug `p-0.5` padding (NO fixed box) so adjacent
 * actions sit tight together — the hover tint hugs the icon rather than a
 * wide 28px square. Busy swaps the icon for a current-color spinner.
 */

const INTENT_CLASSES: Record<NonNullable<IconButtonProps['intent']>, string> = {
  default: 'text-muted-foreground hover:text-foreground',
  primary: 'text-blue-600 hover:text-blue-700',
  danger: 'text-red-600 hover:text-red-700',
  success: 'text-emerald-600 hover:text-emerald-700',
};

export interface IconButtonProps {
  icon: LucideIcon;
  /* Accessible name — used for BOTH `title` (tooltip) and `aria-label`. */
  label: string;
  intent?: 'default' | 'primary' | 'danger' | 'success';
  onClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  /* In-flight: shows a spinner and blocks clicks (implies disabled). */
  busy?: boolean;
  className?: string;
}

export function IconButton({
  icon: Icon,
  label,
  intent = 'default',
  onClick,
  disabled,
  busy,
  className,
}: IconButtonProps) {
  const isDisabled = disabled || busy;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      title={label}
      aria-label={label}
      aria-busy={busy || undefined}
      className={cn(
        // Naked icon button: snug p-0.5 padding around the icon (no fixed box),
        // subtle bg tint on hover (NOT the heavy ghost-Button fill) so adjacent
        // row actions sit tight together.
        'inline-flex shrink-0 items-center justify-center rounded p-0.5',
        'transition-colors hover:bg-muted/60 cursor-pointer',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
        INTENT_CLASSES[intent],
        className,
      )}
    >
      {busy ? (
        <span
          className="size-4 inline-block rounded-full border-2 border-current border-r-transparent animate-spin"
          aria-hidden="true"
        />
      ) : (
        <Icon className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}
