'use client';

import { Button } from './button';
import { useCancelConfirm } from '@/lib/use-cancel-confirm';

/*
 * Cancel button with a built-in "Discard changes?" prompt.
 *
 * Replaces the dozens of:
 *   <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
 * sites across the CRM with:
 *   <CancelButton onCancel={onClose} disabled={submitting} />
 *
 * Confirm dialog copy is centralized in `useCancelConfirm`. Callers can
 * still override per-instance via the `confirmTitle` / `confirmDescription`
 * props.
 */

export function CancelButton({
  onCancel,
  disabled,
  className,
  label = 'Cancel',
  confirmTitle,
  confirmDescription,
  confirmLabel,
  cancelLabel,
}: {
  onCancel: () => void;
  disabled?: boolean;
  className?: string;
  label?: string;
  confirmTitle?: string;
  confirmDescription?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}) {
  const handleCancel = useCancelConfirm(onCancel, {
    title: confirmTitle,
    description: confirmDescription,
    confirmLabel,
    cancelLabel,
  });
  return (
    /*
     * `type="button"` is critical here. HTML's default for a <button>
     * inside a <form> is type="submit", which means clicking Cancel
     * (or even the "Keep editing" choice in the confirm dialog while
     * the click event is in flight) accidentally submits the form
     * before the confirm dialog can intercept. Operators saw this as
     * "Cancel → Keep Editing fired a 'Failed to Save' toast" because
     * the partial form payload tried to POST and failed validation.
     * Forcing type=button ensures the click only ever triggers
     * handleCancel.
     */
    <Button type="button" variant="outline" onClick={handleCancel} disabled={disabled} className={className}>
      {label}
    </Button>
  );
}
