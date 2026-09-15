'use client';

/*
 * TechRequestActions — the Approve / Reject pair on a Technician Requests row
 * (My Orders → Pending to Start).
 *
 * ─── WHAT AN OPERATOR IS DECIDING ─────────────────────────────────────────
 *
 * A technician standing at (or on the way to) a job asked from the mobile app
 * for the order to be CANCELLED or for its appointment to be MOVED. Neither ask
 * changes the job: it sits at job_status = 1 carrying a sticky flag
 * (tbl_job.is_cancelled_by_app / is_rescheduled_by_app) until somebody answers
 * it. See src/lib/job-app-request.ts for the predicate these rows come from.
 *
 * ─── WHY APPROVE IS NOT AN "APPROVE" ENDPOINT ─────────────────────────────
 *
 * Approving a cancellation IS cancelling the job, and approving a reschedule IS
 * rescheduling it. So Approve opens the SAME two dialogs ops already use
 * everywhere else and hits the SAME two endpoints — no third cancel path to
 * keep in step with the other two, and the operator gets the audit those flows
 * already demand (a cancellation reason, a reschedule reason + remarks) instead
 * of a one-click write with no explanation on the record.
 *
 * That works because both endpoints now clear the flag they answer
 * (services/job.service.js resolveAppRequests). Before that change an approved
 * cancellation left the flag at 1 forever and the technician's app kept showing
 * the ask as open.
 *
 * Legacy parity: the legacy CRM's "Cancelled Before Start" Approve does exactly
 * this — it opens the ordinary Cancel Job modal and makes ops re-pick a reason
 * (EasyFix_CRM appCheckoutJobDetail.vm:547 → cancelJob(jobId, 2)). Its
 * reschedule Approve applies the technician's datetime verbatim with no reason
 * at all; we deliberately go through the audited dialog instead, pre-filled
 * with what the technician asked for, so the move has a reason on the record.
 *
 * ─── WHY REJECT NEEDS ONE ─────────────────────────────────────────────────
 *
 * A rejection leaves the job exactly as it was — same status, same technician,
 * same appointment — so no existing write can express it. PATCH
 * /admin/jobs/:id/app-request/reject clears the one flag and writes a
 * tbl_job_comment saying who declined and why; nothing else on the job moves.
 * (Legacy's Reject is a different thing entirely: it force-opens the technician
 * picker and makes ops re-schedule the whole job. The owner asked for the flag
 * clear, which is the better product and what this does.)
 *
 * ─── GRAMMAR ──────────────────────────────────────────────────────────────
 *
 * Same row-icon grammar as its neighbours (View / Reassign / Resend PIN):
 * lucide icons with a title + aria-label, gated by the caller's permission flag
 * rather than by reading auth context here, so the component drops into any
 * list. Modelled on ResendPinButton, which is the estate's self-contained
 * row-action shape.
 */

import { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { invalidateFetch } from '@/lib/hooks';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { CancelWithReasonDialog } from './CancelWithReasonDialog';
import { RescheduleDialog } from './RescheduleDialog';
// ST lives in JobModal (the estate's one status-code map) — same import
// ScheduleAssignModal's cancel mount uses. No bundle cost here: every page that
// renders this row already mounts JobModal.
import { ST } from './JobModal';
import type { AppRequest } from '@/lib/job-app-request';

/*
 * The action key the backend seeds into `menu_action` and grants via
 * `role_menu_action` (migrations/2026-09-15-seed-job-app-request-action.sql),
 * resolved into `me.permissions.actionPermissions` by /api/auth/me. Declared
 * ONCE here and imported by the call site so a rename is a one-line change and
 * a typo cannot silently hide the buttons on one page only — same contract as
 * RESEND_PIN_ACTION.
 *
 * It gates the pair, not just Reject. Approve's two endpoints carry their own
 * guards (requireStageForTransition on status / reschedule), but an operator
 * who may not resolve technician requests should not be offered the decision at
 * all — a disabled-looking Approve beside a hidden Reject is not a decision.
 */
export const APP_REQUEST_ACTION = 'isJobAppRequestResolve';

const REJECT_PATH = (jobId: number) => `/admin/jobs/${jobId}/app-request/reject`;

/*
 * 'YYYY-MM-DD HH:mm' (tbl_job.reschedule_date_time_app, a VARCHAR the app wrote
 * as IST wall-clock) → the 'YYYY-MM-DDTHH:mm' DateTimeSlotPicker wants. Slice
 * then swap, exactly as JobModal's customer-request pre-fill does: NEVER
 * new Date() it, which re-reads an IST literal in the browser's zone and can
 * shift the day across the +05:30 boundary.
 */
function toPickerValue(raw: string | null): string {
  return raw ? String(raw).slice(0, 16).replace(' ', 'T') : '';
}

export type TechRequestActionsProps = {
  jobId: number;
  /* The ask being decided — the SAME object the Request column rendered, passed
   * in rather than re-derived, so the buttons can never act on a different ask
   * than the chip says (a job carrying both flags shows the cancel one). */
  request: AppRequest;
  /* `canJob[APP_REQUEST_ACTION]`. Falsy → renders nothing. */
  allowed: boolean;
  /* Bump the page's reload signal. Every decision moves the row out of this
   * queue and an approved cancellation leaves the tab entirely, so the refresh
   * has to be the page-wide one, not this section's own refetch. */
  onActioned: () => void;
};

export function TechRequestActions({ jobId, request, allowed, onActioned }: TechRequestActionsProps) {
  const confirm = useConfirm();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!allowed) return null;

  const isCancel = request.kind === 'cancel';

  async function onReject() {
    if (busy) return;
    const ok = await confirm({
      title: isCancel ? 'Reject Cancellation Request?' : 'Reject Reschedule Request?',
      description: isCancel
        ? `Order #${jobId} will stay scheduled with the same technician — the cancellation request is declined `
          + `and the row leaves this queue. Nothing else about the job changes.`
        : `Order #${jobId} keeps its current appointment — the reschedule request is declined and the row `
          + `leaves this queue. Nothing else about the job changes.`,
      confirmLabel: 'Reject Request',
      cancelLabel: 'Back',
      icon: <XCircle className="h-4 w-4" />,
      iconAccent: 'rose',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.patch(REJECT_PATH(jobId), { kind: request.kind });
      showToast({ variant: 'success', message: 'Request Rejected' });
      // The reject writes a tbl_job_comment; drop the cached pre-reject thread
      // so opening this job next shows it (30s TTL).
      invalidateFetch((k) => k.startsWith(`/admin/jobs/${jobId}/comments`));
      onActioned();
    } catch (e) {
      /*
       * A 409 APP_REQUEST_NOT_PENDING is INFORMATION, not a crash: another
       * operator answered this ask, or the technician withdrew and re-raised.
       * The server's own sentence says so, so surface it rather than flattening
       * every failure to a generic message.
       */
      showToast({
        variant: 'error',
        message: formatApiError(e, { fallback: 'Could not reject the request.' }),
      });
      // Whatever happened, this row's state is no longer what we painted.
      onActioned();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => (isCancel ? setCancelOpen(true) : setRescheduleOpen(true))}
        className="inline-flex items-center gap-1 text-success-strong text-xs hover:underline disabled:opacity-50"
        title={isCancel
          ? 'Approve Cancellation — opens Cancel Job so you can record the reason'
          : 'Approve Reschedule — opens Reschedule Job pre-filled with the requested time'}
        aria-label={isCancel ? 'Approve Cancellation Request' : 'Approve Reschedule Request'}
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onReject}
        className="inline-flex items-center gap-1 text-urgent-strong text-xs hover:underline disabled:opacity-50"
        title={isCancel
          ? 'Reject Cancellation — the job stays scheduled, unchanged'
          : 'Reject Reschedule — the job keeps its current appointment'}
        aria-label={isCancel ? 'Reject Cancellation Request' : 'Reject Reschedule Request'}
      >
        <XCircle className="h-3.5 w-3.5" />
      </button>

      {/* Approve a CANCELLATION — the same PATCH /:id/status contract JobModal
          and Schedule & Assign use. Defaults the "Cancellation Due To" radio to
          Technician, since that is who asked; ops can still change it (the
          technician's ask is not always the real cause). */}
      <CancelWithReasonDialog
        open={cancelOpen}
        defaultDueTo="Technician"
        onClose={() => setCancelOpen(false)}
        onSubmit={async (reasonId, comment) => {
          await api.patch(`/admin/jobs/${jobId}/status`, { status: ST.CANCELLED, reasonId, comment });
          showToast({ variant: 'success', message: 'Job Cancelled' });
          setCancelOpen(false);
          invalidateFetch((k) => k.startsWith(`/admin/jobs/${jobId}/comments`));
          onActioned();
        }}
      />

      {/* Approve a RESCHEDULE — pre-filled with the slot the technician asked
          for and the reason they gave, so ops only has to pick a CRM reschedule
          reason and confirm. The reason is left empty on purpose: the audit
          trail wants an action_type=8 CRM reason, not the technician's.
          If the requested slot has already passed the picker refuses it and the
          server would too (blockPastAppointment) — ops picks a real one. */}
      <RescheduleDialog
        open={rescheduleOpen}
        jobId={rescheduleOpen ? jobId : null}
        initialDateTime={toPickerValue(request.requestedFor)}
        initialRemarks={`Technician requested reschedule${request.reason ? `: ${request.reason}` : ''}`}
        onClose={() => setRescheduleOpen(false)}
        onDone={onActioned}
      />
    </>
  );
}
