import type { ConfirmOptions } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { formatDate, statusLabel } from '@/lib/utils';

/*
 * Shared lifecycle-tab definitions used by BOTH /jobs (org-wide) and
 * /my-orders (user-scoped). Keeping the canonical TABS list in one place
 * means a status/bucket change lands everywhere at once instead of drifting
 * between the two pages.
 *
 * `value` is the URL slug for `?tab=<value>` deep-links; `statuses`/`status`/
 * `assigned` are the filter payload the backend list endpoint accepts.
 * See EasyFix_Backend/services/job.service.js for the canonical status map.
 */
export type TabDef = {
  value: string;
  label: string;
  status?: number;       // single job_status code
  statuses?: number[];   // multi-code bucket (wins over `status`)
  assigned?: boolean;    // split BOOKED by fk_easyfixter_id presence
  /*
   * `quotationStatus` — drills into quotation_details via EXISTS on the
   * BE list endpoint. Powers the dashboard AttentionSummary tiles for
   * Estimate Approved / Rejected. Tabs that carry this don't pin a
   * single job_status; the BE clamps to "not closed/cancelled" so the
   * tab shows only jobs ops can still act on.
   */
  quotationStatus?: 'approved' | 'rejected';
  /*
   * `requestedBefore` — set to 'now' to filter jobs whose
   * requested_date_time has already passed (the "Running Late" tile).
   * Sent as the BE's `requestedBefore=now` query param. Tabs that
   * carry this also pin statuses=[0,1] so the BE only counts the
   * actionable late bucket.
   */
  requestedBefore?: 'now';
};

export const TABS: TabDef[] = [
  { value: 'all',                 label: 'All' },
  { value: 'unconfirmed',         label: 'Unconfirmed Orders',      status: 9 },
  { value: 'pending-scheduling',  label: 'Pending for Scheduling',  status: 0, assigned: false },
  { value: 'pending-start',       label: 'Pending to Start',        status: 1 },
  { value: 'pending-app-ack',     label: 'Pending App Ack',         status: 0, assigned: true },
  { value: 'pending-close',       label: 'Pending to Close',        statuses: [2, 20] },
  { value: 'audit-complete',      label: 'Audit & Complete',        statuses: [3, 5] },
  { value: 'pending-feedback',    label: 'Pending for Feedback',    status: 10 },
  { value: 'onhold',              label: 'Orders in Followup',      status: 21 },
  { value: 'estimate-pending',    label: 'Estimate Pending',        status: 15 },
  // Dashboard AttentionSummary drill-downs (2026-05-22). These tabs are
  // reachable via URL deep-link (?tab=…) from the dashboard tiles.
  // /jobs has no visible tab bar — tab is purely a filter selector
  // driven by the URL — so adding them here doesn't require a tab-bar
  // hide-list. The BE list endpoint applies the quotation / requested-
  // before filter via the new params (see service.list() 2026-05-22).
  { value: 'estimate-approved',   label: 'Estimate Approved',       quotationStatus: 'approved' },
  { value: 'estimate-rejected',   label: 'Estimate Rejected',       quotationStatus: 'rejected' },
  { value: 'running-late',        label: 'Running Late',            statuses: [0, 1], requestedBefore: 'now' },
  { value: 'call-later',          label: 'Call Later',              status: 9 },
  { value: 'cancelled',           label: 'Cancelled',               status: 6 },
];

export type CountsResp = {
  total: number;
  byStatus: Record<string, number>;
  bookedUnassigned: number;
  bookedAssigned: number;
};

/*
 * Resolve per-tab count from the shared counts response.
 * - BOOKED splits resolved from the precomputed bookedUnassigned/bookedAssigned.
 * - Multi-status buckets summed across byStatus codes.
 * - Single status pulled directly from byStatus.
 * - 'all' returns the total.
 */
export function countFor(tab: TabDef, counts: CountsResp | null): number | null {
  if (!counts) return null;
  if (tab.value === 'all') return counts.total;
  if (tab.status === 0 && tab.assigned === false) return counts.bookedUnassigned;
  if (tab.status === 0 && tab.assigned === true)  return counts.bookedAssigned;
  if (tab.statuses) return tab.statuses.reduce((s, code) => s + (counts.byStatus[String(code)] ?? 0), 0);
  if (tab.status !== undefined) return counts.byStatus[String(tab.status)] ?? 0;
  return 0;
}

/*
 * Minimal row shape the client-side search filter reads. Both /jobs and
 * /my-orders pass their richer JobRow (a structural superset) — the generic
 * `T extends SearchableJobRow` keeps the caller's exact row type flowing
 * through to the filtered result.
 */
export type SearchableJobRow = {
  job_id: number;
  job_reference_id: string | null;
  client_ref_id: string | null;
  job_status: number;
  job_type: string;
  source_type: string | null;
  client_name: string | null;
  customer_name: string | null;
  customer_mob_no: string | null;
  city_name: string | null;
  easyfixer_name: string | null;
  owner_name: string | null;
  fk_easyfixter_id: number | null;
  created_date_time: string;
  requested_date_time: string;
  scheduled_date_time: string | null;
  checkin_date_time: string | null;
  checkout_date_time: string | null;
};

/*
 * Client-side search over the currently-loaded page, shared by /jobs and
 * /my-orders (previously copy-pasted and drifting). Matches every visible
 * column INCLUDING the human-readable status label (so typing "scheduled"
 * matches status=1 rows) and the formatted date strings (so partial date
 * typing like "12 May" hits what the operator visually sees). The needle is
 * lowercased once; each candidate is compared as its lowercase string form.
 * Kept as a per-row haystack array (not a joined string) so a needle can
 * never false-positive across field boundaries.
 */
export function filterJobRows<T extends SearchableJobRow>(items: T[], q: string): T[] {
  if (!q) return items;
  const needle = q.toLowerCase();
  return items.filter((j) => {
    const haystacks: Array<unknown> = [
      j.job_id, j.job_reference_id, j.client_ref_id,
      j.client_name, j.customer_name, j.customer_mob_no,
      j.city_name, j.easyfixer_name, j.owner_name, j.job_type,
      j.source_type,
      j.job_status,
      statusLabel(Number(j.job_status), { assigned: j.fk_easyfixter_id != null }),
      j.created_date_time && formatDate(j.created_date_time),
      j.requested_date_time && formatDate(j.requested_date_time),
      j.scheduled_date_time && formatDate(j.scheduled_date_time),
      j.checkin_date_time && formatDate(j.checkin_date_time),
      j.checkout_date_time && formatDate(j.checkout_date_time),
    ];
    return haystacks.some((h) => h != null && String(h).toLowerCase().includes(needle));
  });
}

/*
 * Factory for the per-row quick status-change handler shared by /jobs and
 * /my-orders. The two pages differ only in (a) the confirm description copy
 * and (b) whether a counts refresh fires after reload — so those are passed
 * in rather than branched on. Everything else (confirm dialog shape, the
 * PATCH /admin/jobs/:id/status payload, the cache-clear → reload sequence,
 * row-busy + error wiring) is identical and lives here once.
 */
export function makeQuickStatusChange(opts: {
  confirmAction: (o?: ConfirmOptions) => Promise<boolean>;
  api: typeof api;
  description: ConfirmOptions['description'];
  setRowBusy: (id: number | null) => void;
  setErrorMsg: (m: string) => void;
  clearCache: () => void;
  reload: () => Promise<void>;
  afterReload?: () => void;
}) {
  return async function quickStatusChange(jobId: number, toStatus: number, verb: string) {
    const ok = await opts.confirmAction({
      title: `${verb} job #${jobId}?`,
      description: opts.description,
      confirmLabel: verb,
    });
    if (!ok) return;
    opts.setRowBusy(jobId);
    try {
      await opts.api.patch(`/admin/jobs/${jobId}/status`, { status: toStatus });
      opts.clearCache();
      await opts.reload();
      opts.afterReload?.();
    } catch (e) {
      opts.setErrorMsg(`${verb} failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      opts.setRowBusy(null);
    }
  };
}
