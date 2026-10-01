'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import type { JobComment } from './jobTypes';
// Shared with JobModal's Comments tab — the same thread, so the same labels.
import { LEGACY_REMARKS_FOR, jobStageLabel } from '@/lib/job-comment-labels';

/*
 * A pending customer cancel/reschedule request (tbl_job_customer_request),
 * surfaced by GET /admin/jobs/:id/customer-requests. These live in a SEPARATE
 * store from tbl_job_comment: the backend only mirrors NEW web magic-link
 * requests into the comment thread (never the WhatsApp path, never pre-fix
 * rows), so a pending ask can exist with NO matching comment row. We read it
 * directly and pin any pending request at the top of the panel so ops always
 * see the customer's reason + remarks when confirming/scheduling.
 */
type CustomerRequest = {
  request_id: number;
  request_type: string;               // 'cancel' | 'reschedule'
  reason?: string | null;
  remarks?: string | null;
  preferred_datetime?: string | null;
  preferred_slot?: string | null;     // booking band the customer picked; NULL on older rows
  request_status: string;             // 'pending' | 'actioned' | 'dismissed'
};

/*
 * Read-only "Remarks / Comments" panel — the job's tbl_job_comment thread
 * (GET /admin/jobs/:id/comments) rendered as a compact 4-column table
 * (Date/Time · Remarks · By · Reason), with any PENDING customer request
 * (reason + remarks + requested date) pinned above it. No add form. Dropped
 * into the bottom of the Confirm & Schedule and Schedule & Assign modals so
 * ops can see the existing remarks history — and the customer's pending ask —
 * without leaving the modal.
 *
 * `collapsible` is OPT-IN (2026-07-15) so the two hosts can differ without one
 * dictating to the other: Schedule & Assign moved this panel up between Job
 * Details and the technician list, where a long thread would push the Top 10
 * off-screen, so it collapses and starts CLOSED there. Confirm & Schedule keeps
 * the panel always-open at the bottom — passing nothing preserves exactly that.
 */
export function JobRemarksView({
  jobId,
  collapsible = false,
  defaultOpen = true,
  fill = false,
}: {
  jobId: number | null;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /*
   * FILL the height the host gives it and scroll inside, instead of the default
   * 12rem cap. The job consoles set a fixed tile height for remarks and
   * internal notes side by side, so a long thread scrolls rather than
   * stretching the row. Opt-in: every other host keeps the cap.
   */
  fill?: boolean;
}) {
  const { data, loading } = useFetch<JobComment[]>(
    jobId ? `/admin/jobs/${jobId}/comments` : null,
    { enabled: !!jobId },
  );
  const { data: reqData } = useFetch<CustomerRequest[]>(
    jobId ? `/admin/jobs/${jobId}/customer-requests` : null,
    { enabled: !!jobId },
  );
  const [bodyOpen, setBodyOpen] = useState(defaultOpen);
  const rows = data ?? [];
  const pendingRequests = (reqData ?? []).filter((r) => r.request_status === 'pending');
  // Only claim "No remarks yet" when BOTH stores are empty.
  const isEmpty = !loading && rows.length === 0 && pendingRequests.length === 0;

  // Non-collapsible hosts are always open; `open` only gates the body.
  const open = !collapsible || bodyOpen;
  // Surface the thread size on the collapsed header so ops know whether it's
  // worth expanding — a bare "Comments" chevron gives them no reason to click.
  const count = rows.length + pendingRequests.length;

  return (
    <div className={`rounded-md border bg-muted/30 ${fill ? 'flex h-full min-h-0 flex-col' : ''}`}>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setBodyOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 px-3 py-2 border-b text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-primary"
        >
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
          Remarks / Comments
          {count > 0 && <span className="font-normal normal-case">({count})</span>}
          {pendingRequests.length > 0 && (
            <span className="font-normal normal-case text-warning-strong">
              · {pendingRequests.length} pending customer request{pendingRequests.length > 1 ? 's' : ''}
            </span>
          )}
        </button>
      ) : (
        <div className="px-3 py-2 border-b text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Remarks / Comments
        </div>
      )}
      <div className={`${fill ? 'min-h-0 flex-1' : 'max-h-48'} overflow-y-auto ${open ? '' : 'hidden'}`}>
        {pendingRequests.map((r) => (
          <div
            key={`req-${r.request_id}`}
            className="px-3 py-2 border-b bg-warning-tint text-xs text-warning-strong"
          >
            <span className="font-semibold capitalize">Customer {r.request_type} request</span>
            {r.reason ? <> · {r.reason}</> : null}
            {r.preferred_datetime ? <> · New: {formatDate(r.preferred_datetime)}{r.preferred_slot ? ` (${r.preferred_slot})` : ''}</> : null}
            {r.remarks ? <div className="mt-0.5">Remarks: {r.remarks}</div> : null}
          </div>
        ))}
        {loading && <div className="px-3 py-3 text-sm text-muted-foreground">Loading…</div>}
        {isEmpty && (
          <div className="px-3 py-3 text-sm text-muted-foreground">No remarks yet.</div>
        )}
        {!loading && rows.length > 0 && (
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-3 py-1.5 font-medium">Date / Time</th>
                {/*
                  * Remarks For + Stage (2026-09-30 per ops). Without them this
                  * panel showed a reschedule as an undifferentiated remark:
                  * an operator standing in Schedule & Assign — the very screen
                  * where they are deciding what to do next — could not see that
                  * the job had been rescheduled, let alone from which stage.
                  * Both read the same fields as the Comments tab, via the
                  * shared lib/job-comment-labels.
                  */}
                <th className="px-3 py-1.5 font-medium whitespace-nowrap">Remarks For</th>
                <th className="px-3 py-1.5 font-medium whitespace-nowrap">Stage</th>
                <th className="px-3 py-1.5 font-medium">Remarks</th>
                <th className="px-3 py-1.5 font-medium">By</th>
                <th className="px-3 py-1.5 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-t align-top">
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">{formatDate(c.created_on)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {c.remarks_for ?? LEGACY_REMARKS_FOR[c.comment_on] ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  {/* Em dash, not blank, for a row with no recorded stage —
                      mostly Node-era rows (2026-04-29 → 2026-09-30), when most
                      writers stored none — and a blank cell reads like a
                      rendering bug rather than "not recorded back then". */}
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">
                    {jobStageLabel(c.job_stage) || <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-1.5">{c.comments || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{c.remark_by || c.user_name || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-3 py-1.5">{c.enum_desc || <span className="text-muted-foreground">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
