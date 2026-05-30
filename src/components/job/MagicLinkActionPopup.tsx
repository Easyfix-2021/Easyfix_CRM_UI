'use client';

/*
 * MagicLinkActionPopup — confirmation dialog for triggering / re-triggering
 * the customer Magic-Link WhatsApp send on an Unconfirmed Order row.
 *
 * Lifecycle (driven entirely by the parent's row state — this component
 * does NOT fetch status itself):
 *
 *   1. First send         — `magicLinkSentAt === null`
 *                            → one primary CTA ("Send WhatsApp Link"),
 *                              POST { action: 'first' }.
 *
 *   2. Re-send / nudge    — `magicLinkSentAt !== null` AND
 *                           `customerSubmittedAt === null`
 *                            → two CTAs:
 *                              - "Send Reminder" (amber)  → action: 'reminder'
 *                              - "Resend Form"   (sky/default) → action: 'resend'
 *
 *   3. Already submitted  — `customerSubmittedAt !== null`
 *                            → both CTAs disabled + tooltip explaining.
 *
 * Send-count cap: `magicLinkSendCount >= 3` disables both CTAs with a
 * tooltip "Send limit reached (3 sends max per order)." regardless of
 * which of the three render states applies (apart from "already
 * submitted", which trumps with its own reason).
 *
 * Toasts: success on delivery; error on ApiError / network failure. The
 * busy state is local — the parent's `onSent` callback is invoked AFTER
 * the dialog has closed so the parent can refetch / patch its row.
 */

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { formatDate } from '@/lib/utils';

export function MagicLinkActionPopup({
  open,
  onClose,
  jobId,
  magicLinkSentAt,
  magicLinkSendCount,
  magicLinkLastAction,
  customerSubmittedAt,
  customerName,
  customerMobileMasked,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  jobId: number;
  magicLinkSentAt: string | null;
  magicLinkSendCount: number;
  magicLinkLastAction: 'first' | 'reminder' | 'resend' | null;
  customerSubmittedAt: string | null;
  customerName: string | null;
  customerMobileMasked: string;
  onSent: (result: { delivered: boolean; action: string; send_count: number }) => void;
}) {
  // Local in-flight flag. Resets to false on error so the operator can
  // retry without re-opening the dialog. On success we close the dialog
  // (parent's `onSent` runs after close so the row refresh happens
  // against the post-close UI state).
  const [busy, setBusy] = React.useState(false);

  // Track which action is currently in-flight so we can render the
  // "Sending…" label on the specific button the operator clicked
  // (rather than both reminder + resend showing the same spinner).
  const [pendingAction, setPendingAction] = React.useState<
    'first' | 'reminder' | 'resend' | null
  >(null);

  const submitted = customerSubmittedAt !== null;
  const hasBeenSent = magicLinkSentAt !== null;
  const capReached = magicLinkSendCount >= 3;

  // Composed disable reasons. Order matters: "already submitted" wins
  // over "cap reached" because it carries the more decisive narrative
  // ("the customer is done, you're not blocked, you're complete").
  const disableReason: string | null = submitted
    ? 'Customer has already submitted — no further sends needed.'
    : capReached
      ? 'Send limit reached (3 sends max per order).'
      : null;

  const actionsDisabled = disableReason !== null || busy;

  async function send(action: 'first' | 'reminder' | 'resend') {
    if (actionsDisabled) return;
    setBusy(true);
    setPendingAction(action);
    try {
      const result = await api.post<{
        delivered: boolean;
        error?: string;
        token?: string;
        url?: string;
        action: string;
        send_count: number;
        magic_link_sent_at: string;
      }>(`/admin/jobs/${jobId}/send-magic-link`, { action });
      showToast({ variant: 'success', message: 'Magic link sent.' });
      // Notify parent BEFORE closing so the parent can immediately
      // patch its row state and the next render shows the new counter
      // without a flash of stale data.
      onSent({
        delivered: result.delivered,
        action: result.action,
        send_count: result.send_count,
      });
      onClose();
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to send magic link.';
      showToast({ variant: 'error', message: msg });
    } finally {
      // Only clear local flags; if we closed the dialog the parent's
      // re-render will unmount this state anyway, but clearing keeps
      // things consistent on the error path where we stay open.
      setBusy(false);
      setPendingAction(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Block dialog dismissal while an in-flight POST is running —
        // the toast subsystem also paints a busy overlay, but
        // belt-and-suspenders here ensures Esc / outside-click can't
        // tear down the component mid-request.
        if (!o && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send WhatsApp Link</DialogTitle>
          <DialogDescription>
            Customer: {customerName ?? '—'} · {customerMobileMasked}
          </DialogDescription>
        </DialogHeader>

        {/* STATUS BLOCK — three mutually-exclusive states. Each carries
            its own colour scheme so the operator gets an at-a-glance
            read of "where this order stands" before deciding to act. */}
        <div>
          {submitted ? (
            <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
              ✓ Customer submitted on {formatDate(customerSubmittedAt!)} — no further sends needed.
            </p>
          ) : hasBeenSent ? (
            <p className="text-sm text-sky-700 bg-sky-50 border border-sky-200 rounded px-3 py-2">
              Last sent {relativeTime(magicLinkSentAt!)} via{' '}
              <strong>{magicLinkLastAction ?? '—'}</strong>. Sent {magicLinkSendCount}{' '}
              time{magicLinkSendCount === 1 ? '' : 's'} total.
            </p>
          ) : (
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2">
              No magic link has been sent for this order yet.
            </p>
          )}
        </div>

        {/* CTA SECTION — branched by lifecycle state. Footer is
            inlined here (rather than via DialogFooter) so the layout
            keeps a tidy two-cluster shape: action buttons on the left,
            Cancel on the right. */}
        <div className="flex items-center justify-between gap-2 pt-2">
          <div className="flex items-center gap-2">
            {hasBeenSent ? (
              <>
                <Button
                  type="button"
                  onClick={() => send('reminder')}
                  disabled={actionsDisabled}
                  title={disableReason ?? undefined}
                  className="bg-amber-500 hover:bg-amber-600 text-white"
                >
                  {busy && pendingAction === 'reminder' ? 'Sending…' : 'Send Reminder'}
                </Button>
                <Button
                  type="button"
                  onClick={() => send('resend')}
                  disabled={actionsDisabled}
                  title={disableReason ?? undefined}
                >
                  {busy && pendingAction === 'resend' ? 'Sending…' : 'Resend Form'}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={() => send('first')}
                disabled={actionsDisabled}
                title={disableReason ?? undefined}
              >
                {busy && pendingAction === 'first' ? 'Sending…' : 'Send WhatsApp Link'}
              </Button>
            )}
          </div>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Tiny inline relative-time helper. Intentionally NOT extracted to
 * `@/lib/utils` — it's only used here, and the lib already exposes the
 * absolute `formatDate` which is the right tool for the
 * already-submitted branch. Mixing absolute + relative is deliberate:
 * "last sent 12 min ago" is the operator's mental model for in-flight
 * follow-ups; "submitted on 18 Mar 2026" is the right read for a
 * closed-out order.
 */
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
