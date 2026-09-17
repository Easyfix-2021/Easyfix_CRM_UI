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
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { invalidateFetch } from '@/lib/hooks';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { RescheduleDialog } from './RescheduleDialog';
import { useCancelJob } from './CancelJob';
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
  /* Called INSTEAD of onActioned when an approved cancellation has cancelled
   * the job — a host that shows the job (the job console) closes itself, since
   * there is nothing left to act on. Absent → onActioned, as before. */
  onCancelled?: () => void;
  /* How the two triggers are drawn. 'icon' (default) for a table action cell;
   * 'button' for the JobModal banner, where labelled buttons match the
   * customer-request banner sitting directly above it. The DECISION is
   * identical either way — only the trigger markup differs. */
  variant?: 'icon' | 'button';
};

export function TechRequestActions({ jobId, request, allowed, onActioned, onCancelled, variant = 'icon' }: TechRequestActionsProps) {
  const confirm = useConfirm();
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /*
   * Approving a cancellation IS cancelling the job, so it goes through the ONE
   * shared cancel control every other surface uses (./CancelJob) rather than a
   * fourth copy of the PATCH. Only the trigger differs here — a row icon or a
   * banner button, never that module's footer Button — so this calls open()
   * and ignores `button`. defaultDueTo seeds the radio to Technician, since
   * that is who asked; ops can still change it.
   */
  const cancel = useCancelJob({
    jobId,
    defaultDueTo: 'Technician',
    disabled: busy,
    onCancelled: onCancelled ?? onActioned,
  });

  if (!allowed) return null;

  const isCancel = request.kind === 'cancel';
  const approveTitle = isCancel
    ? 'Approve Cancellation — opens Cancel Job so you can record the reason'
    : 'Approve Reschedule — opens Reschedule Job pre-filled with the requested time';
  const rejectTitle = isCancel
    ? 'Reject Cancellation — the job stays scheduled, unchanged'
    : 'Reject Reschedule — the job keeps its current appointment';
  const onApprove = () => (isCancel ? cancel.open() : setRescheduleOpen(true));

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

  /*
   * Two triggers, one flow. The row renders icons to sit in the action cell's
   * grammar; the JobModal banner renders labelled buttons to sit in the
   * customer-request banner's. Everything below the triggers is shared, so the
   * two surfaces cannot decide differently.
   */
  const triggers = variant === 'button' ? (
    <>
      <Button size="sm" disabled={busy} onClick={onApprove} title={approveTitle}>
        <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
        Approve
      </Button>
      <Button size="sm" variant="destructive" disabled={busy} onClick={onReject} title={rejectTitle}>
        <XCircle className="mr-1.5 h-3.5 w-3.5" />
        Reject
      </Button>
    </>
  ) : (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={onApprove}
        className="inline-flex items-center gap-1 text-success-strong text-xs hover:underline disabled:opacity-50"
        title={approveTitle}
        aria-label={isCancel ? 'Approve Cancellation Request' : 'Approve Reschedule Request'}
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onReject}
        className="inline-flex items-center gap-1 text-urgent-strong text-xs hover:underline disabled:opacity-50"
        title={rejectTitle}
        aria-label={isCancel ? 'Reject Cancellation Request' : 'Reject Reschedule Request'}
      >
        <XCircle className="h-3.5 w-3.5" />
      </button>
    </>
  );

  return (
    <>
      {triggers}

      {/* Approve a CANCELLATION — the ONE shared cancel control. */}
      {cancel.dialog}

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
