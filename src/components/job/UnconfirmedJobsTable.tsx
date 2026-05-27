'use client';
import * as React from 'react';
import { Eye, CalendarCheck } from 'lucide-react';
import { formatDate, statusColorClass, statusLabel } from '@/lib/utils';
import { CallableMobile } from '@/components/calls/CallButton';

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
  openView,
  openConfirm,
}: {
  rows: UnconfirmedJobRow[];
  loading: boolean;
  canConfirm: boolean;
  openView: (jobId: number) => void;
  openConfirm: (jobId: number) => void;
}) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th className="stick-col-head stick-left">Job #</th>
          <th>Ticket Created · Age</th>
          <th>Client / Unique Code</th>
          <th>City</th>
          <th>Status</th>
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
        {loading && <tr><td colSpan={12} className="text-center py-8 text-muted-foreground">Loading…</td></tr>}
        {!loading && rows.length === 0 && (
          <tr><td colSpan={12} className="text-center py-8 text-muted-foreground">No unconfirmed orders.</td></tr>
        )}
        {!loading && rows.map((j) => {
          const { reason, freeText } = splitRemarks(j.remarks ?? '');
          const ticketTs = j.ticket_created_date_time ?? j.created_date_time;
          return (
            <tr key={j.job_id}>
              <td className="font-medium whitespace-nowrap stick-col stick-left">#{j.job_id}</td>
              <td className="text-xs whitespace-nowrap">
                <div>{ticketTs ? formatDate(ticketTs) : '—'}</div>
                <div className="text-[10px] text-muted-foreground">{ticketTs ? jobAge(ticketTs) : ''}</div>
              </td>
              <td className="text-xs whitespace-nowrap">
                <div className="font-medium">{j.client_name ?? '—'}</div>
                {j.client_ref_id && <div className="text-[10px] text-muted-foreground">{j.client_ref_id}</div>}
              </td>
              <td className="text-xs">{j.city_name ?? '—'}</td>
              <td>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${statusColorClass(j.job_status)}`}>
                  {statusLabel(j.job_status, { assigned: j.fk_easyfixter_id != null })}
                </span>
                {/*
                  Draft indicator — added 2026-05-28. Visible only when an
                  Unconfirmed row has been edited since creation (Save Draft
                  was clicked on the Confirm modal). Derived from
                  last_update_time vs created_date_time; no extra column.
                  Tooltip on hover spells out what it means so operators
                  scanning the list don't have to guess.
                */}
                {hasDraftEdit(j) && (
                  <span
                    className="ml-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap bg-amber-100 text-amber-800 border border-amber-300"
                    title="Save Draft progress exists on this job. Open Confirm & Schedule to continue."
                  >
                    Draft
                  </span>
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
                <div className="inline-flex items-center gap-1 justify-end">
                  <button
                    type="button"
                    onClick={() => openView(j.job_id)}
                    className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                    title="View details"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                  {canConfirm && (
                    <button
                      type="button"
                      onClick={() => openConfirm(j.job_id)}
                      className="inline-flex items-center gap-1 text-purple-700 text-xs hover:underline"
                      title="Confirm — fill details, pick services, and move to Scheduled"
                    >
                      <CalendarCheck className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
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
