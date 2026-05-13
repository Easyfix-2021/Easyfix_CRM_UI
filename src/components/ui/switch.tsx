'use client';

import { cn } from '@/lib/utils';

/*
 * Lightweight ARIA-compliant toggle switch. Avoided pulling in
 * @radix-ui/react-switch just for one form field; this matches the visual
 * weight of the rest of the shadcn-style controls already in the project.
 *
 * Use exactly like a checkbox:
 *   <Switch checked={active} onCheckedChange={setActive} />
 *
 * Keyboard: Space / Enter toggles; Tab focuses. Visible focus ring uses
 * the same `ring-ring` token as buttons + inputs so focus order stays
 * coherent across the form.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  className,
  ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      id={id}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        checked ? 'bg-primary' : 'bg-slate-300',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
