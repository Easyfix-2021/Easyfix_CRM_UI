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
