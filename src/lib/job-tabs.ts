import type { ConfirmOptions } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { formatDate, statusLabel } from '@/lib/utils';

/*
 * Job Stage Access lives in lib/job-stages.ts. `filterTabsForStages` narrows
 * the shared TABS list to what a stage-restricted user may see (a tab is kept
 * only when its status/statuses intersect the user's allowed visible
 * statuses). Re-exported here so the two list pages can pull both TABS and
 * the tab-filter from one module. See lib/job-stages.ts for the full contract.
 */
export { filterTabsForStages } from '@/lib/job-stages';
import { filterTabsForStages as filterTabs, type AllowedStages } from '@/lib/job-stages';

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
  // RETIRED (legacy-only): the offer-based flow never produces BOOKED+tech, so
  // this bucket is always empty. Sidebar entry is disabled (Sidebar.tsx
  // RETIRED_MENU_HREFS) and the page shows PendingAppAckRetired instead of a
  // table. Kept here so /jobs counts + deep-links still resolve the slug.
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

/*
 * The two list pages a sidebar menu row can deep-link into with `?tab=`.
 * Anything else is not a lifecycle surface and is never stage-clamped.
 */
const JOB_LIST_PATHS = new Set(['/my-orders', '/jobs']);

/*
 * Job Stage Access for the SIDEBAR. `filterTabsForStages` clamps the tab bar
 * INSIDE a page; this clamps the menu rows that link INTO one, so a restricted
 * user isn't offered "Unconfirmed Orders" when they can't see a single
 * unconfirmed job. Deliberately delegates to filterTabsForStages so the two
 * surfaces can't drift apart.
 *
 * Rules:
 *   - unrestricted, or a non-job href → always visible.
 *   - `?tab=<slug>` → visible only if that tab survives the stage filter.
 *   - NO tab param (the bare container link, e.g. "Jobs") → visible as long as
 *     the user has at least ONE reachable tab. The page self-clamps to their
 *     first allowed tab, so hiding it for a partially-restricted user would
 *     cost them a legitimate view; a NO-ACCESS user has none, so it hides.
 *   - an unknown slug → left visible (don't hide what we can't classify).
 */
export function jobHrefAllowedForStages(
  href: string,
  allowed: AllowedStages | null | undefined,
): boolean {
  if (!allowed || allowed.mode === 'all') return true;
  const [path, query] = String(href || '').split('?');
  if (!JOB_LIST_PATHS.has(path)) return true;
  const tabValue = new URLSearchParams(query || '').get('tab');
  if (!tabValue) return filterTabs(TABS, allowed).length > 0;
  const def = TABS.find((t) => t.value === tabValue);
  if (!def) return true;
  return filterTabs([def], allowed).length > 0;
}

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
  // Client SPOC snapshot (on tbl_job) — shown in the Unconfirmed / Pending-to-
  // Scheduling SPOC column; included in the haystack so the instant client-side
  // filter matches SPOC name too (mirrors the BE list() search predicate).
  client_spoc?: string | null;
  client_spoc_name?: string | null;
  fk_easyfixter_id: number | null;
  created_date_time: string;
  requested_date_time: string;
  scheduled_date_time: string | null;
  checkin_date_time: string | null;
  checkout_date_time: string | null;
};

/*
 * THE ONE LIST of what a job search matches.
 *
 * Both the filter and the search box's copy derive from this array, because
 * they had already drifted apart once: the placeholder advertised 4 fields
 * while the filter matched 14, so operators never discovered they could search
 * by Client SPOC, city or technician. A capability nobody knows about is
 * indistinguishable from one that doesn't exist.
 *
 * Adding a field here now updates the filter AND the UI copy together — there
 * is no second list to forget. `primary` marks the ones worth naming in the
 * (necessarily short) placeholder; every label appears in the full hover hint.
 */
const JOB_SEARCH_FIELDS: Array<{
  label: string;
  primary?: boolean;
  get: (j: SearchableJobRow) => unknown;
}> = [
  { label: 'job ID', primary: true, get: (j) => j.job_id },
  { label: 'ref', primary: true, get: (j) => j.job_reference_id },
  { label: 'client ref', get: (j) => j.client_ref_id },
  { label: 'client', primary: true, get: (j) => j.client_name },
  { label: 'customer', primary: true, get: (j) => j.customer_name },
  { label: 'mobile', primary: true, get: (j) => j.customer_mob_no },
  { label: 'city', get: (j) => j.city_name },
  { label: 'technician', primary: true, get: (j) => j.easyfixer_name },
  { label: 'owner', get: (j) => j.owner_name },
  { label: 'job type', get: (j) => j.job_type },
  { label: 'source', get: (j) => j.source_type },
  // Client SPOC snapshot on tbl_job — the BE's list() search covers the same two
  // columns, so server-side and client-side agree. Named in the placeholder
  // because it is the one operators most often don't realise is searchable.
  { label: 'client SPOC', primary: true, get: (j) => j.client_spoc_name },
  { label: 'SPOC mobile', get: (j) => j.client_spoc },
  { label: 'status', get: (j) => j.job_status },
  // The human-readable label too, so typing "scheduled" matches status=1 rows.
  {
    label: 'status label',
    get: (j) => statusLabel(Number(j.job_status), { assigned: j.fk_easyfixter_id != null }),
  },
  // Formatted dates, so partial typing like "12 May" hits what is on screen.
  { label: 'booked date', get: (j) => j.created_date_time && formatDate(j.created_date_time) },
  { label: 'requested date', get: (j) => j.requested_date_time && formatDate(j.requested_date_time) },
  { label: 'scheduled date', get: (j) => j.scheduled_date_time && formatDate(j.scheduled_date_time) },
  { label: 'check-in date', get: (j) => j.checkin_date_time && formatDate(j.checkin_date_time) },
  { label: 'check-out date', get: (j) => j.checkout_date_time && formatDate(j.checkout_date_time) },
];

/* Search-box copy, derived — never hand-written alongside the list above. */
export const JOB_SEARCH_PLACEHOLDER =
  `Search ${JOB_SEARCH_FIELDS.filter((f) => f.primary).map((f) => f.label).join(' / ')}…`;

/* Full list for a hover title, so nothing searchable stays hidden. */
export const JOB_SEARCH_HINT =
  `Searches: ${JOB_SEARCH_FIELDS.map((f) => f.label).join(', ')}.`;

/*
 * MASKED-VALUE MATCHING.
 *
 * The backend masks mobile-bearing fields on every /api/admin/* response
 * (middleware/mask-mobile.js): `customer_mob_no` becomes "9310••••••" whenever
 * `ui.customer.number.visible` is off, and `client_spoc` is masked
 * unconditionally. The SERVER still searches the RAW column, so a full
 * 10-digit mobile search matches server-side and the row comes back — but a
 * plain `includes()` against the masked string could never match it, and this
 * filter runs ON TOP of the server result. The row was therefore DROPPED: the
 * header said "1 matching orders" beside an empty table, and only the first 4
 * digits ever "worked", which made the failure look intermittent.
 *
 * So: when the stored value is masked, compare on digits against the visible
 * prefix only. A needle that is consistent with what we can see is a match
 * (the server's own predicate is the authority and has already been applied);
 * a needle that contradicts the visible digits, or is longer than the number
 * itself, is not. Keyed off the bullet character rather than a field
 * allow-list so any field the masker starts covering is handled for free.
 */
function maskedMatches(value: string, needle: string): boolean {
  const visible = value.slice(0, value.indexOf('•')).replace(/\D/g, '');
  const nd = needle.replace(/\D/g, '');
  // A non-numeric needle can never be about a masked mobile.
  if (!nd || nd !== needle.trim()) return false;
  // Masking preserves length (visible digits + one bullet per hidden digit),
  // so a needle longer than the number cannot be it.
  if (nd.length > value.length) return false;
  // Needle within the visible window → ordinary substring match.
  // Needle longer than the window → it must agree with every digit we can see.
  return nd.length <= visible.length ? visible.includes(nd) : nd.startsWith(visible);
}

/*
 * Client-side search over the currently-loaded page, shared by /jobs and
 * /my-orders (previously copy-pasted and drifting). The needle is lowercased
 * once; each candidate is compared as its lowercase string form. Kept as a
 * per-row haystack ARRAY (not a joined string) so a needle can never
 * false-positive across field boundaries.
 */
export function filterJobRows<T extends SearchableJobRow>(items: T[], q: string): T[] {
  if (!q) return items;
  const needle = q.toLowerCase();
  return items.filter((j) => JOB_SEARCH_FIELDS.some((f) => {
    const v = f.get(j);
    if (v == null) return false;
    const s = String(v);
    if (s.includes('•')) return maskedMatches(s, needle);
    return s.toLowerCase().includes(needle);
  }));
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
