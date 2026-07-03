'use client';
import * as React from 'react';
import { Eye, CalendarCheck, Send } from 'lucide-react';
import { formatDate, statusLabel, statusTone } from '@/lib/utils';
import { CallableMobile } from '@/components/calls/CallButton';
import { CallHistoryButton } from '@/components/calls/CallHistoryButton';
import { MagicLinkActionPopup } from '@/components/job/MagicLinkActionPopup';
import { StatusChip } from '@/components/ui/StatusChip';
import { IconButton } from '@/components/ui/icon-button';

/*
 * UnconfirmedJobsTable — the focused column set ops requested for the
 * Unconfirmed bucket (job_status = 9). Shared by /jobs and /my-orders
 * so both pages stay aligned on what an Unconfirmed row looks like.
 *
 * Columns (left → right):
 *   1. Job ID
 *   2. Ticket Created Date  +  Job Age (e.g. "3d 4h")
 *   3. Client  +  Client Reference (Unique Code)
 *   4. City
 *   5. Current Status (pill)
 *   6. Action Taken Reason  (parsed from the structured remarks prefix
 *      we write in JobOutcomeDialog: `[Unreachable · ... · Reason: X]`)
 *   7. Remarks  (operator's free-text portion, after the structured
 *      prefix is stripped)
 *   8. Client SPOC  (name + email/contact line)
 *   9. Appointment  (requested_date_time + time_slot)
 *  10. Customer  (name + masked mobile with click-to-call)
 *  11. Source
 *  12. Action  (View, plus Confirm-and-Schedule when the operator has
 *      `isJobConfirm`)
 *
 * The `canConfirm` prop gates the Confirm icon — caller passes the
 * result of `actionFlags(me, ['isJobConfirm']).isJobConfirm`. Same
 * `openView`/`openConfirm` callbacks both pages already wire up for
 * their other tabs.
 */
export type UnconfirmedJobRow = {
  job_id: number;
  job_status: number;
  client_ref_id: string | null;
  ticket_created_date_time?: string | null;
  created_date_time: string;
  // Surfaces the row's last write time — the BE LIST projection adds
  // this so we can flag Save-Draft-edited rows with a "Draft" pill
  // next to the status badge. Optional so older API responses (during
  // staging rollouts) don't break the type narrow.
  last_update_time?: string | null;
  requested_date_time: string;
  time_slot?: string | null;
  remarks?: string | null;
  client_spoc?: string | null;
  client_spoc_name?: string | null;
  fk_easyfixter_id: number | null;
  customer_name: string | null;
  customer_mob_no: string | null;
  client_name: string | null;
  city_name: string | null;
  source_type: string | null;
  // Magic-Link surface (added 2026-05-28). BE list() projection exposes
  // these so the Unconfirmed table can render the "Customer Submitted"
  // / "Link Sent" pill and gate the Send Magic Link action. Optional so
  // older API responses during staging rollouts don't break the type.
  customer_submitted_at?: string | null;
  magic_link_sent_at?: string | null;
  magic_link_send_count?: number;
  // Per-client cap surfaced on the LIST projection (defaults to 3 when
  // no `magic_link_max_send_count` custom property is configured). Drives
  // the popup's disable-reason text + the Force Send (Override) branch.
  magic_link_max_send_count?: number | null;
  magic_link_last_action?: 'first' | 'reminder' | 'resend' | null;
  // Derived server-side from tbl_client_custom_properties
  // (auto_process_unconfirmed_order='true'). When false the client has
  // not opted into the magic-link flow and the action is hidden even
  // for operators carrying `isJobMagicLinkSend`.
  client_opted_in?: boolean | 0 | 1;
  // Latest PENDING customer cancel/reschedule request on this job, surfaced
  // by the BE LIST projection (correlated subquery on tbl_job_customer_request,
  // gated by a table-existence probe so un-migrated deploys return NULL).
  // Drives the "Customer Request" column AND hides the Send Magic Link
  // action once the customer has acted via the link. Optional so older API
  // responses during staging rollouts don't break the type narrow.
  pending_request_type?: 'cancel' | 'reschedule' | null;
  pending_request_reason?: string | null;
};

/*
 * Detects whether a job row has been touched since creation (i.e. has
 * Save Draft progress on it). 60-second buffer protects against the
 * unavoidable microsecond skew between the INSERT-time created_date_time
 * and last_update_time columns — both get NOW() on the original create
 * but their wall-clock values can differ by a few ms within the same
 * INSERT. Anything past 60s is unambiguously a real edit.
 */
function hasDraftEdit(row: UnconfirmedJobRow): boolean {
  if (!row.last_update_time || !row.created_date_time) return false;
  const created = new Date(row.created_date_time).getTime();
  const updated = new Date(row.last_update_time).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return false;
  return updated - created > 60_000;
}

export function UnconfirmedJobsTable({
  rows,
  loading,
  canConfirm,
  canSendMagicLink = false,
  userIsAdmin = false,
  openView,
  openConfirm,
  onMagicLinkSent,
}: {
  rows: UnconfirmedJobRow[];
  loading: boolean;
  canConfirm: boolean;
  // Mirrors `canConfirm`: parent passes
  // `actionFlags(me, ['isJobMagicLinkSend']).isJobMagicLinkSend`. The
  // `client_opted_in` half of the gate lives on the row itself and is
  // evaluated per-row below. Defaults to false so legacy callers that
  // don't yet wire this prop stay safe (button hidden).
  canSendMagicLink?: boolean;
  // True only when the logged-in operator carries role_name='Admin'
  // (literal). Surfaces the popup's Force Send (Override) button when
  // the per-client cap is hit. BE re-enforces the check.
  userIsAdmin?: boolean;
  openView: (jobId: number) => void;
  openConfirm: (jobId: number) => void;
  // Fired after the popup successfully POSTs to send-magic-link. Parent
  // should refetch the Unconfirmed list (via its useFetch / invalidate
  // mechanism) so the new sent_at / send_count flow back into the row.
  onMagicLinkSent?: () => void;
}) {
  // Track which row's Magic-Link popup is open. Single state because the
  // dialog is modal and at most one row's popup is mounted at a time.
  const [magicLinkRow, setMagicLinkRow] = React.useState<UnconfirmedJobRow | null>(null);
  return (
    <>
    <table className="data-table">
      <thead>
        <tr>
          <th className="stick-col-head stick-left">Job #</th>
          <th>Ticket Created · Age</th>
          <th>Client / Unique Code</th>
          <th>City</th>
          <th>Status</th>
          <th>Customer Request</th>
          <th>Action Taken Reason</th>
          <th>Remarks</th>
          <th>Client SPOC</th>
          <th>Appointment · Slot</th>
          <th>Customer</th>
          <th>Source</th>
          <th className="stick-col-head stick-right text-right">Action</th>
        </tr>
      </thead>
      <tbody>
        {loading && <tr><td colSpan={13} className="text-center py-8 text-muted-foreground">Loading…</td></tr>}
        {!loading && rows.length === 0 && (
          <tr><td colSpan={13} className="text-center py-8 text-muted-foreground">No unconfirmed orders.</td></tr>
        )}
        {!loading && rows.map((j) => {
          const { reason, freeText } = splitRemarks(j.remarks ?? '');
          const ticketTs = j.ticket_created_date_time ?? j.created_date_time;
          return (
            <tr key={j.job_id}>
              <td className="font-medium whitespace-nowrap stick-col stick-left">
                <span className="inline-flex items-center gap-1">
                  #{j.job_id}
                  <CallHistoryButton jobId={j.job_id} />
                </span>
              </td>
              <td className="text-xs whitespace-nowrap">
                <div>{ticketTs ? formatDate(ticketTs) : '—'}</div>
                <div className="text-[10px] text-muted-foreground">{ticketTs ? jobAge(ticketTs) : ''}</div>
              </td>
              <td className="text-xs whitespace-nowrap">
                <div className="font-medium">{j.client_name ?? '—'}</div>
                {j.client_ref_id && <div className="text-[10px] text-muted-foreground">{j.client_ref_id}</div>}
              </td>
              <td className="text-xs">{j.city_name ?? '—'}</td>
              {/*
                Status cell — two-row layout (2026-05-30 redesign):
                  Row 1: primary job_status chip (Unconfirmed / Booked / …)
                  Row 2: zero or more sub-status chips (Draft, Link Sent,
                         Customer Submitted) wrapped in a flex row so they
                         fall to a third visual line only if 3+ stack — but
                         in practice Link Sent and Customer Submitted are
                         mutually exclusive, so it's at most Draft + 1 here.
                Width: min-w-[160px] reserves enough horizontal space for
                "Customer Submitted" (the longest sub-status label) to fit
                on a single line without clipping. All chips share the
                shared <StatusChip /> primitive — one source of truth for
                shape, padding, border-radius, font-weight, border colour.

                Tone mapping:
                  - statusTone(code) from @/lib/utils picks the StatusChip
                    tone for the primary job_status (parallels the existing
                    statusColorClass mapping).
                  - Draft = amber, Link Sent = sky, Customer Submitted =
                    emerald — matches the prior copy-pasted classes.
              */}
              <td className="min-w-[160px]">
                <div className="flex flex-col gap-1">
                  <div>
                    <StatusChip
                      tone={statusTone(j.job_status)}
                      size="md"
                    >
                      {statusLabel(j.job_status, { assigned: j.fk_easyfixter_id != null })}
                    </StatusChip>
                  </div>
                  {(hasDraftEdit(j) || j.customer_submitted_at || j.magic_link_sent_at) && (
                    <div className="flex flex-wrap gap-1">
                      {hasDraftEdit(j) && (
                        <StatusChip
                          tone="amber"
                          size="sm"
                          title="Save Draft progress exists on this job. Open Confirm & Schedule to continue."
                        >
                          Draft
                        </StatusChip>
                      )}
                      {j.customer_submitted_at ? (
                        <StatusChip
                          tone="emerald"
                          size="sm"
                          title={`Customer submitted on ${formatDate(j.customer_submitted_at)}`}
                        >
                          Customer Submitted
                        </StatusChip>
                      ) : j.magic_link_sent_at ? (
                        <StatusChip
                          tone="sky"
                          size="sm"
                          title={`Sent ${relativeAge(j.magic_link_sent_at)} ago via ${j.magic_link_last_action ?? '—'} · ×${j.magic_link_send_count ?? 0}`}
                        >
                          Link Sent
                        </StatusChip>
                      ) : null}
                    </div>
                  )}
                </div>
              </td>
              {/*
                Customer Request cell — shows the latest PENDING cancel /
                reschedule request raised by the customer via the magic-link
                page. Cancel = rose chip, Reschedule = amber chip, with the
                reason as muted sub-text + a title tooltip. None → em-dash.
                The presence of a request also hides the Send action below.
              */}
              <td className="text-xs whitespace-nowrap">
                {j.pending_request_type === 'cancel' ? (
                  <div className="flex flex-col gap-0.5">
                    <StatusChip tone="rose" size="sm" title={j.pending_request_reason ?? undefined}>
                      Cancel Requested
                    </StatusChip>
                    {j.pending_request_reason && (
                      <div className="text-[10px] text-muted-foreground max-w-[160px] truncate" title={j.pending_request_reason}>
                        {j.pending_request_reason}
                      </div>
                    )}
                  </div>
                ) : j.pending_request_type === 'reschedule' ? (
                  <div className="flex flex-col gap-0.5">
                    <StatusChip tone="amber" size="sm" title={j.pending_request_reason ?? undefined}>
                      Reschedule Requested
                    </StatusChip>
                    {j.pending_request_reason && (
                      <div className="text-[10px] text-muted-foreground max-w-[160px] truncate" title={j.pending_request_reason}>
                        {j.pending_request_reason}
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="text-xs">{reason || <span className="text-muted-foreground">—</span>}</td>
              <td className="text-xs max-w-[220px]">
                <div className="truncate" title={freeText}>{freeText || <span className="text-muted-foreground">—</span>}</div>
              </td>
              <td className="text-xs whitespace-nowrap">
                {j.client_spoc_name || j.client_spoc
                  ? (
                    <>
                      <div>{j.client_spoc_name ?? '—'}</div>
                      {j.client_spoc && j.client_spoc !== j.client_spoc_name && (
                        <div className="text-[10px] text-muted-foreground">{j.client_spoc}</div>
                      )}
                    </>
                  )
                  : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="text-xs whitespace-nowrap">
                <div>{formatDate(j.requested_date_time)}</div>
                {j.time_slot && <div className="text-[10px] text-muted-foreground">{j.time_slot}</div>}
              </td>
              <td className="text-xs whitespace-nowrap">
                <div>{j.customer_name ?? '—'}</div>
                {/* Same click-to-call surface every other job-list page uses
                    (jobs/page, my-orders/page). Permission-gated on
                    isClickToCall and renders null when the operator lacks
                    it (falls back to a non-clickable masked string). The
                    customer's unmasked mobile is resolved server-side from
                    jobId — never sent over the wire from this row. */}
                <CallableMobile jobId={j.job_id} mobile={j.customer_mob_no} />
              </td>
              <td className="text-xs text-muted-foreground">{j.source_type ?? '—'}</td>
              <td className="stick-col stick-right text-right whitespace-nowrap">
                <div className="inline-flex items-center gap-0.5 justify-end">
                  <IconButton
                    icon={Eye}
                    intent="default"
                    label="View details"
                    onClick={() => openView(j.job_id)}
                  />
                  {canConfirm && (
                    <IconButton
                      icon={CalendarCheck}
                      intent="primary"
                      label="Confirm — fill details, pick services, and move to Scheduled"
                      onClick={() => openConfirm(j.job_id)}
                    />
                  )}
                  {/*
                    Send / Re-send Magic Link.

                    Gate (2026-06-08, simplified): SINGLE permission gate
                    on `canSendMagicLink` (= `isJobMagicLinkSend`). Was
                    previously double-gated against the client's
                    `client_opted_in` flag too, but that conflated the
                    cron's auto-trigger gate with the manual-trigger
                    gate. The auto_process_unconfirmed_order property
                    only governs whether the hourly cron auto-sends
                    magic links; the MANUAL operator click should work
                    for any unconfirmed order regardless of that flag.
                    The BE route mirrors this change — see
                    routes/admin/job-magic-link.js.

                    Still hidden once the customer has acted via the
                    link — either submitted details (`customer_submitted_at`)
                    or raised a pending cancel/reschedule request
                    (`pending_request_type`). Re-sending after the customer
                    has engaged would be noise, so we drop the trigger
                    entirely (other actions in the cell stay).
                  */}
                  {canSendMagicLink
                    && !j.customer_submitted_at
                    && j.pending_request_type == null && (
                    <IconButton
                      icon={Send}
                      intent="default"
                      label={j.magic_link_sent_at ? 'Re-send Magic Link' : 'Send Magic Link'}
                      onClick={() => setMagicLinkRow(j)}
                    />
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    {/*
      Magic-Link popup is mounted once at the table level and driven by
      the currently-selected row's state. Closing nulls the row state so
      next open re-mounts with fresh props. `onSent` invokes the parent's
      refetch hook so the row's sent_at / send_count / last_action flow
      back in without a manual page refresh.
    */}
    {magicLinkRow && (
      <MagicLinkActionPopup
        open={true}
        onClose={() => setMagicLinkRow(null)}
        jobId={magicLinkRow.job_id}
        magicLinkSentAt={magicLinkRow.magic_link_sent_at ?? null}
        magicLinkSendCount={magicLinkRow.magic_link_send_count ?? 0}
        magicLinkMaxSendCount={magicLinkRow.magic_link_max_send_count ?? 3}
        magicLinkLastAction={magicLinkRow.magic_link_last_action ?? null}
        customerSubmittedAt={magicLinkRow.customer_submitted_at ?? null}
        customerName={magicLinkRow.customer_name}
        customerMobileMasked={magicLinkRow.customer_mob_no ?? '—'}
        userIsAdmin={userIsAdmin}
        onSent={() => {
          onMagicLinkSent?.();
        }}
      />
    )}
    </>
  );
}

/*
 * Compact relative-age formatter for the "Link Sent" pill tooltip.
 * Mirrors the popup's `relativeTime` shape ("5 min", "2 hr", "3 days")
 * without re-importing it (kept local since this file already owns the
 * sibling `jobAge` helper for the same kind of inline read).
 */
function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/* Local CustomerMobile component removed — superseded by the shared
 * <CallableMobile> which routes through the Kaleyra click-to-call flow
 * (confirmation dialog → POST /admin/calls/click-to-call → bridged
 * voice call). The old `tel:` link punted to the OS dialer and didn't
 * write to tbl_job_caller_info, so calls placed from this surface
 * weren't auditable. The new component fixes that and matches the
 * pattern used on Manage Jobs / My Orders / Customer popup / dashboard.
 */

/*
 * Structured-remarks parser. The JobOutcomeDialog (Unreachable /
 * Enquiry popups) writes a prefix `[Unreachable · Pending Due To: X ·
 * Reason: Y] <free text>`. We split it back into the reason value
 * and the operator's free-text portion so the Unconfirmed table can
 * show them as separate columns.
 *
 * Fall-throughs (any remark not matching the prefix shape): we return
 * `{ reason: '', freeText: remarks }` so the Remarks column still
 * carries the raw text and the Reason column shows `—`. Future remark
 * shapes only need to land here if a new column wants to surface a
 * field; otherwise this is robust.
 */
function splitRemarks(remarks: string): { reason: string; freeText: string } {
  const m = remarks.match(/^\[(?:Unreachable|Enquiry)[^\]]*?Reason:\s*([^·\]]+?)\s*\]\s*(.*)$/s);
  if (!m) return { reason: '', freeText: remarks.trim() };
  return { reason: m[1].trim(), freeText: (m[2] || '').trim() };
}

/*
 * Job-age formatter — compact "Nd Nh" / "Nh Nm" / "Nm" depending on
 * magnitude. Used in the Ticket Created column so ops can see at a
 * glance how long a job has been sitting Unconfirmed.
 */
function jobAge(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}
