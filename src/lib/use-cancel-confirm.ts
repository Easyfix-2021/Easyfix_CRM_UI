'use client';

import { useConfirm } from '@/components/ui/confirm-dialog';

/*
 * useCancelConfirm — single source of truth for the "Cancel button on
 * a modal" UX across the CRM.
 *
 * Behavior:
 *   - Always prompts before calling the supplied onCancel callback.
 *   - Matches the legacy CRM flow where every Add/Edit modal warned
 *     before discarding unsaved input.
 *
 * Usage:
 *   const onCancel = useCancelConfirm(onClose);     // basic
 *   <Button variant="outline" onClick={onCancel}>Cancel</Button>
 *
 *   // With custom copy:
 *   const onCancel = useCancelConfirm(onClose, {
 *     title: 'Discard new role?',
 *     description: 'Any details you entered will be lost.',
 *   });
 *
 * NOTE: the helper does NOT inspect dirty state — operators explicitly
 * asked for a prompt on every Cancel. If a particular form wants to
 * skip the prompt when nothing has changed, it can pass a `when()`
 * predicate that returns false to short-circuit.
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
) {
  const confirm = useConfirm();
  return async () => {
    if (opts?.when && !opts.when()) {
      onCancel();
      return;
    }
    const ok = await confirm({
      title: opts?.title ?? 'Discard changes?',
      description: opts?.description ?? 'Any unsaved input will be lost.',
      confirmLabel: opts?.confirmLabel ?? 'Discard',
      cancelLabel: opts?.cancelLabel ?? 'Keep editing',
      variant: 'destructive',
    });
    if (ok) onCancel();
  };
}
