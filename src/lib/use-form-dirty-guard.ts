'use client';

import * as React from 'react';
import { useConfirm } from '@/components/ui/confirm-dialog';

/*
 * useFormDirtyGuard — discard-changes confirmation for ALL close paths
 * (Esc / X / overlay-click / programmatic onClose) on form modals.
 *
 * Companion to useCancelConfirm:
 *   - useCancelConfirm covers the explicit Cancel BUTTON.
 *   - useFormDirtyGuard covers everything else — the close paths that
 *     route through Dialog's `onOpenChange(false)`.
 *
 * Why a hook (not a wrapper component):
 *   - Form modals across the codebase use slightly different Dialog
 *     props (some pass extra className, some compose with form state,
 *     some block on `saving`). A hook that returns a single guarded
 *     onOpenChange handler drops in next to existing code without
 *     restructuring the JSX tree.
 *   - It composes cleanly with useCancelConfirm — both consult useConfirm
 *     so the prompt copy is consistent across button + Esc paths.
 *
 * Usage (one modal, simple):
 *
 *   const [name, setName] = useState('');
 *   const isDirty = name !== ''; // however the modal computes "dirty"
 *   const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty });
 *   ...
 *   <Dialog open onOpenChange={guardedOpenChange}>
 *
 * Usage (with saving guard, matches the typical CRM pattern):
 *
 *   const guardedOpenChange = useFormDirtyGuard(onClose, {
 *     isDirty: isDirty || saving,
 *     // saving forces the prompt to skip — a save-in-flight close
 *     // should be no-op (matches existing `!saving && onClose()` idiom)
 *     when: () => !saving,
 *   });
 *
 * Behavior:
 *   - When `o === true` (dialog opening) → no-op; the modal owns its
 *     own open state via the `open` prop.
 *   - When `o === false` AND `isDirty()` returns false → close immediately.
 *   - When `o === false` AND `isDirty()` returns true → confirm prompt.
 *   - When `when()` returns false → close immediately (use to gate on
 *     external state like in-flight save).
 *
 * The prompt copy mirrors useCancelConfirm so operators see the same
 * dialog whether they hit Cancel or Esc.
 */
export function useFormDirtyGuard(
  onClose: () => void,
  opts?: {
    /**
     * Snapshot or callback indicating whether the form has unsaved
     * input. Optional — when omitted, the prompt fires on EVERY close
     * attempt (matches useCancelConfirm's behaviour and ops policy:
     * "show the discard prompt on Esc / X / overlay-click"). Provide
     * a function when a particular modal wants to skip the prompt on
     * a clean (untouched) close.
     */
    isDirty?: boolean | (() => boolean);
    /**
     * Optional gate. Return false to skip the prompt and run onClose
     * immediately — e.g. when a save is in flight and the modal is
     * about to unmount anyway.
     */
    when?: () => boolean;
    title?: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  },
): (o: boolean) => void {
  const confirm = useConfirm();
  // Stash latest opts in a ref so the returned handler doesn't go stale
  // when callers pass inline objects (which is the typical call shape).
  const optsRef = React.useRef(opts);
  optsRef.current = opts;

  return React.useCallback((o: boolean) => {
    if (o) return; // opening is a no-op — open state is owned upstream
    const cur = optsRef.current ?? {};
    if (cur.when && !cur.when()) {
      onClose();
      return;
    }
    // isDirty defaults to TRUE — match useCancelConfirm: prompt every
    // time unless the caller explicitly opts out via a function/snapshot
    // that returns false.
    const dirty = cur.isDirty === undefined
      ? true
      : typeof cur.isDirty === 'function' ? cur.isDirty() : cur.isDirty;
    if (!dirty) {
      onClose();
      return;
    }
    // Fire-and-forget — useConfirm resolves async; the close happens on
    // confirm and is a no-op on cancel. We deliberately don't await
    // here (the handler must be synchronous to fit Dialog's onOpenChange
    // signature). React batches state updates inside the await chain
    // so there's no visible delay before the prompt appears.
    void (async () => {
      const ok = await confirm({
        title: cur.title ?? 'Discard changes?',
        description: cur.description ?? 'Any unsaved input will be lost.',
        confirmLabel: cur.confirmLabel ?? 'Discard',
        cancelLabel: cur.cancelLabel ?? 'Keep editing',
        variant: 'destructive',
      });
      if (ok) onClose();
    })();
  }, [confirm, onClose]);
}
