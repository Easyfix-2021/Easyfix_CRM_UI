'use client';

/*
 * THE ONE CANCEL-JOB CONTROL.
 *
 * ─── WHY IT EXISTS (owner, 2026-09-15) ────────────────────────────────────
 *
 * Four surfaces cancel a job — JobModal's footer, Schedule & Assign, Reassign
 * Technician, and the Approve on a technician's cancellation request — and
 * each had its own copy of the same twelve lines: a destructive Button, a
 * CancelWithReasonDialog, the PATCH, the toast, the comment-cache eviction.
 * Four copies of a label drift, and they did: three said "Cancel" and the
 * fourth said "Cancel Job". The owner asked for the shared component, and the
 * label is only the visible half — the write drifting would be worse and
 * silent.
 *
 * ─── WHY A HOOK PLUS A BUTTON, NOT ONE COMPONENT ──────────────────────────
 *
 * The obvious shape — one component rendering trigger + dialog — would put a
 * Radix Dialog INSIDE the calling modal's DialogContent, because that is where
 * the footer button lives. Every dialog in this estate is mounted as a SIBLING
 * of DialogContent instead (AddRemarksDialog, RescheduleDialog,
 * PincodeListModal, and all four cancels before this refactor), and changing
 * that is a focus-trap question no build or unit test can answer. So the hook
 * hands back two nodes the caller places exactly where they already were:
 *
 *   const cancel = useCancelJob({ jobId, onCancelled });
 *   …<DialogFooter>{cancel.button}</DialogFooter></DialogContent>
 *   {cancel.dialog}
 *
 * `button` is the canonical control; a surface whose trigger is not a footer
 * button (the request row's icon) ignores it and calls `open()` instead. Both
 * come from ONE call, so a caller cannot take the write without the label or
 * adopt half of it.
 */

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { invalidateFetch } from '@/lib/hooks';
import { showToast } from '@/components/ui/toast';
import { ST } from '@/lib/utils';
import { CancelWithReasonDialog } from './CancelWithReasonDialog';

/*
 * The footer label, in one place. "Cancel" — NOT "Cancel Job" — because that
 * is what JobModal and Schedule & Assign have always said and consistency is
 * the point of this module. It reads as "dismiss the dialog" only in
 * isolation; in context it sits in the destructive-red variant beside an
 * outline "Close", which is the button that dismisses.
 */
export const CANCEL_JOB_LABEL = 'Cancel';

export type CancelDueTo = 'Customer' | 'Client' | 'EasyFix' | 'Technician';

export type UseCancelJobOptions = {
  /* Null while a modal is still resolving which job it is on — the button
   * disables itself and the dialog will not write. */
  jobId: number | null;
  /* Pre-selects the "Cancellation Due To" radio. Omit for the Customer default
   * every long-standing surface uses; 'Technician' when approving that
   * technician's own ask. Still a radio either way. */
  defaultDueTo?: CancelDueTo;
  /* Disable the button while the caller is committing something else. */
  disabled?: boolean;
  /* Run after the cancel has COMMITTED and the comment cache is evicted —
   * refresh the list, close the modal, bump a reload key. Awaited, so a caller
   * that refetches before closing still gets its order. */
  onCancelled: () => void | Promise<void>;
};

export function useCancelJob({ jobId, defaultDueTo, disabled, onCancelled }: UseCancelJobOptions): {
  open: () => void;
  button: ReactNode;
  dialog: ReactNode;
} {
  const [cancelOpen, setCancelOpen] = useState(false);

  return {
    open: () => setCancelOpen(true),

    button: (
      <Button
        variant="destructive"
        onClick={() => setCancelOpen(true)}
        disabled={!jobId || !!disabled}
      >
        {CANCEL_JOB_LABEL}
      </Button>
    ),

    dialog: jobId == null ? null : (
      <CancelWithReasonDialog
        open={cancelOpen}
        defaultDueTo={defaultDueTo}
        onClose={() => setCancelOpen(false)}
        onSubmit={async (reasonId, comment) => {
          await api.patch(`/admin/jobs/${jobId}/status`, { status: ST.CANCELLED, reasonId, comment });
          showToast({ variant: 'success', message: 'Job Cancelled' });
          setCancelOpen(false);
          /*
           * The cancel writes a tbl_job_comment row. Evict AFTER the PATCH, never
           * before: evicting first lets a refetch race the write and re-cache the
           * pre-cancel thread (pinned by tests/cancel-refreshes-comments.test.js).
           */
          invalidateFetch((k) => k.startsWith(`/admin/jobs/${jobId}/comments`));
          await onCancelled();
        }}
      />
    ),
  };
}
