'use client';

import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

/*
 * useCancelConfirm — discard-changes confirm for the explicit Cancel
 * button on a form modal.
 *
 * Implementation note (2026-06-03):
 *   Now a thin adapter over useFormDirtyGuard. Both hooks fire the same
 *   shared `useConfirm` dialog with the same default copy — keeping the
 *   prompt consistent whether the operator hits Cancel, Esc, X, or
 *   clicks the overlay. Previously the two hooks held parallel copies
 *   of the prompt config; consolidating prevents future drift.
 *
 *   useFormDirtyGuard's return signature is `(o: boolean) => void`
 *   (Dialog's onOpenChange shape); we wrap that with an outer
 *   `() => void` that always passes `o=false` so the Cancel-button
 *   call site stays identical to the legacy API.
 *
 * Behaviour:
 *   - Always prompts before calling the supplied onCancel callback
 *     (matches the legacy CRM "every Cancel warns" UX policy).
 *   - `when()` short-circuits past the prompt — use to skip while
 *     a save is in flight or for a clean-form quick close.
 *
 * Usage (unchanged from the prior API):
 *
 *   const onCancel = useCancelConfirm(onClose);
 *   <Button onClick={onCancel}>Cancel</Button>
 *
 *   // With custom copy:
 *   const onCancel = useCancelConfirm(onClose, {
 *     title: 'Discard new role?',
 *     description: 'Any details you entered will be lost.',
 *   });
 */
export function useCancelConfirm(
  onCancel: () => void,
  opts?: {
    title?: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Return false to skip the prompt and call onCancel immediately. */
    when?: () => boolean;
  },
): () => void {
  // Delegate the prompt machinery to useFormDirtyGuard. isDirty stays
  // unset → defaults to true, so the prompt fires on every call
  // (matches the legacy useCancelConfirm contract: ALWAYS prompts).
  const guardedClose = useFormDirtyGuard(onCancel, opts);
  // Adapt the (o:boolean)=>void shape into the ()=>void shape that
  // Cancel-button onClick handlers expect. Always pass `false` since
  // a Cancel click is a "close attempt".
  return () => guardedClose(false);
}
