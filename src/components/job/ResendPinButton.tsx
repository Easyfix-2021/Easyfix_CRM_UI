'use client';

/*
 * ResendPinButton — ops-side resend of the customer's 4-digit closing PIN.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * The PIN (tbl_job.otp, minted by job.service setStatus on the BOOKED
 * transition) moved from gating CHECK-IN to gating CHECK-OUT. That changed the
 * cost of a technician who cannot get the code: he used to be unable to START
 * (annoying); he is now unable to CLOSE a job he has already finished — work
 * done, customer gone, order stuck open and unbillable.
 *
 * His only self-service escape is the technician app's own resend
 * (POST /mobile/jobs/:id/checkin-sms). When that fails — wrong number on file,
 * customer deleted the SMS — ops previously had NO lever at all, because the
 * CRM neither shows nor re-sends the PIN anywhere. This is that lever.
 *
 * ─── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
 *
 * It never displays the PIN. The endpoint's success payload is `{ sent: true }`
 * and deliberately carries no code; this component types the response that way
 * so a future field cannot be rendered here by accident. Staff trigger the
 * message; only the customer's handset receives the digits.
 *
 * (Separate, and NOT fixed here because it is a backend concern: the admin
 * job-detail endpoint's projection is `SELECT j.*` on tbl_job, so `otp` is
 * already on the wire for anyone who opens a job in the CRM. Reported upstream
 * — nothing in THIS file widens that exposure.)
 *
 * ─── GRAMMAR ──────────────────────────────────────────────────────────────
 *
 * Deliberately the SAME row-icon grammar as the neighbouring quick actions
 * (View / Check-In / Reassign / Check-Out): a small lucide icon button with a
 * title tooltip, permission-gated by the caller. One component, rendered from
 * every list that shows a job a technician is currently holding, rather than a
 * second action vocabulary per page.
 */

import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';

/*
 * The action key the backend seeds into `menu_action` and grants via
 * `role_menu_action`; resolved into `me.permissions.actionPermissions` by
 * /api/auth/me. Declared ONCE here and imported by every call site so a rename
 * is a one-line change rather than a hunt through three pages — and so a typo
 * cannot silently hide the button on one page only.
 */
export const RESEND_PIN_ACTION = 'isJobCustomerPinResend';

/* Single source for the route, same reasoning as the action key above. */
const RESEND_PIN_PATH = (jobId: number) => `/admin/jobs/${jobId}/resend-customer-pin`;

/*
 * The job states where a technician is holding the order and can therefore
 * need the code:
 *   1  SCHEDULED   — accepted, travelling / on site, will close later
 *   2  IN PROGRESS — checked in; this is where the closing PIN actually bites
 *   20             — the second in-progress code the lists treat as "Pending
 *                    to Close" alongside 2 (see my-orders row actions)
 *
 * Not status 0: the PIN exists from BOOKED onward, but nobody needs it before a
 * technician is committed to the job, and an always-on button is one more thing
 * to mis-click on a customer's phone. Not 3/5/7/9: closed, cancelled or not yet
 * confirmed.
 */
const PIN_RESENDABLE_STATUSES = new Set([1, 2, 20]);

export type ResendPinButtonProps = {
  jobId: number;
  jobStatus: number;
  /* Customer identity for the confirmation copy. `customerMobile` arrives
   * ALREADY MASKED (first-4-then-bullets, middleware/mask-mobile.js), which is
   * exactly what we want: enough for the operator to recognise the number they
   * are about to text, not enough to read it out. */
  customerName: string | null;
  customerMobile: string | null;
  /* The caller's permission flag — `canJob[RESEND_PIN_ACTION]`. Passed rather
   * than read here so this component stays free of the auth context and can be
   * rendered inside any list. Falsy → renders nothing. */
  allowed: boolean;
};

export function ResendPinButton({
  jobId,
  jobStatus,
  customerName,
  customerMobile,
  allowed,
}: ResendPinButtonProps) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  if (!allowed || !PIN_RESENDABLE_STATUSES.has(jobStatus)) return null;

  const who = customerName?.trim() || 'the customer';
  const where = customerMobile?.trim() ? ` on ${customerMobile.trim()}` : '';

  async function onClick() {
    if (busy) return;
    /* Confirm FIRST — this texts a real person. The copy names the recipient
     * and the number, and says plainly that the operator will not see the code
     * either, so nobody clicks expecting to read it back themselves. */
    const ok = await confirm({
      title: 'Resend Customer PIN?',
      description:
        `A text message with the 4-digit closing PIN for order #${jobId} will be sent to `
        + `${who}${where}. The technician needs this PIN from the customer to close the job. `
        + `The PIN is not shown in the CRM — only the customer receives it.`,
      confirmLabel: 'Resend PIN',
      cancelLabel: 'Cancel',
      icon: <MessageSquare className="h-4 w-4" />,
      iconAccent: 'emerald',
    });
    if (!ok) return;
    setBusy(true);
    try {
      /* Response type is `{ sent: boolean }` ON PURPOSE — see the file header.
       * Do not widen it to carry the code. */
      await api.post<{ sent: boolean }>(RESEND_PIN_PATH(jobId), {});
      showToast({ variant: 'success', message: `PIN resent to ${who}.` });
    } catch (e) {
      /*
       * A 422 here is INFORMATION, not a crash: the server says "no mobile on
       * file for this customer" or "no PIN was ever minted for this job" —
       * both things ops can act on (fix the number, or confirm the order so a
       * PIN gets minted). So surface the server's own sentence via the shared
       * formatApiError rather than flattening every failure to a generic
       * "Resend failed", which would send the operator to a developer for a
       * message the API already wrote for them.
       */
      showToast({
        variant: 'error',
        message: formatApiError(e, { fallback: 'Could not resend the PIN.' }),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="inline-flex items-center gap-1 text-primary text-xs hover:underline disabled:opacity-50"
      title="Resend Customer PIN — text the closing PIN to the customer again"
      aria-label="Resend Customer PIN"
    >
      <MessageSquare className="h-3.5 w-3.5" />
    </button>
  );
}
