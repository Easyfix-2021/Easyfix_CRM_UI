import { isUnrestricted, stageVisibleStatuses, type AllowedStages } from './job-stages';

/*
 * Bucket Status — the legacy CRM's 3-way categorical view over job_status
 * (Open / Closed / Cancelled), and the Job Status dropdown derived from it.
 *
 * WHY THESE TWO LIVE TOGETHER. They describe the SAME column at different
 * granularities, and the backend ANDs whatever both filters send. Held apart,
 * a status added to one silently fails to appear in the other — so the map is
 * the single source and the option list is derived from it, not maintained
 * beside it.
 *
 * Lifted out of app/(authed)/jobs/page.tsx (2026-08-18) so the derivation is
 * testable: a page component drags React and the Next runtime into any test
 * that imports it, which is why the rule it encodes had no coverage before.
 */

/*
 * The mapping (rule verified 2026-05-19):
 *   closed    → 3 (COMPLETED), 5 (COMPLETED_ALT)
 *   cancelled → 6 (CANCELLED), 7 (ENQUIRY)
 *   open      → everything else valid (0,1,2,9,10,15,20,21)
 * `open` is the complement, so adding a new active status only requires
 * adding it here.
 */
export const BUCKET_STATUS_MAP: Record<string, number[]> = {
  open:      [0, 1, 2, 9, 10, 15, 20, 21],
  closed:    [3, 5],
  cancelled: [6, 7],
};

export type StatusOption = { value: string; label: string };

/* The full Job Status dropdown, ungated. */
export const JOB_STATUS_OPTIONS: StatusOption[] = [
  { value: '0',  label: 'Booked' },
  { value: '1',  label: 'Scheduled' },
  { value: '2',  label: 'In Progress' },
  { value: '3',  label: 'Completed' },
  { value: '6',  label: 'Cancelled' },
  { value: '7',  label: 'Enquiry' },
  { value: '9',  label: 'Unconfirmed' },
  { value: '10', label: 'Revisit' },
  { value: '15', label: 'Estimate Pending' },
  { value: '20', label: 'Pending to Close' },
  { value: '21', label: 'Followup' },
];

/*
 * Job Status offers ONLY the statuses inside the chosen bucket.
 *
 * Bucket Status and Job Status filter the same column and the backend ANDs
 * them, so "Closed" + "Booked" is a guaranteed-empty result the UI was happy
 * to let an operator assemble, with nothing on screen explaining the emptiness.
 * Narrowing the options makes the contradiction unconstructable rather than
 * merely wrong.
 *
 * No bucket selected → every status, which is the previous behaviour.
 */
export function jobStatusOptionsFor(bucketStatus: string, allowed?: AllowedStages | null): StatusOption[] {
  const ids = bucketStatus ? BUCKET_STATUS_MAP[bucketStatus] : null;
  const visible = isUnrestricted(allowed) ? null : stageVisibleStatuses(allowed!.stages);
  if (!ids && !visible) return JOB_STATUS_OPTIONS;
  return JOB_STATUS_OPTIONS.filter((o) => {
    const code = Number(o.value);
    if (ids && !ids.includes(code)) return false;
    if (visible && !visible.has(code)) return false;
    return true;
  });
}

/*
 * JOB STAGE ACCESS IN THE FILTERS THEMSELVES (2026-09-16).
 *
 * A stage-restricted user used to get a SEPARATE bucket panel above the filter
 * card, so their Manage Jobs looked like a different page from everyone else's.
 * The owner's call: one filter panel for everybody, and where a user lacks
 * access, the dropdown simply does not offer that value.
 *
 * Both option builders therefore narrow on two independent axes — the selected
 * bucket (Open / Closed / Cancelled) and the user's own stage grant — and both
 * reuse job-stages' rule rather than re-deriving it: `isUnrestricted` decides
 * whether a grant applies at all (no rows = every stage), and
 * `stageVisibleStatuses` turns granted stage_keys into job_status codes. The
 * two vocabularies do NOT overlap by name — these options are keyed
 * 'scheduling' / 'close' / 'audit' while a grant is keyed 'pending-scheduling'
 * / 'pending-close' / 'audit-complete' — so the comparison is made in STATUS
 * CODES, the one representation both sides agree on.
 */

/* ─────────────────────────────────────────────────────────────────────
 * JOB STAGE filter — legacy parity (2026-08-18).
 *
 * The legacy CRM's "Job Status" control is NOT a list of job_status codes.
 * It is a MULTI-SELECT of workflow STAGES whose values are strings
 * ('unconfirmed', 'scheduling', …), resolved server-side by
 * UtilityFunctions.resolveJobStatus() into a set of job_status ids plus an
 * optional technician-presence flag. The new CRM shipped a single-select of
 * raw numeric codes instead, so the two lists could never agree — an operator
 * comparing them saw different option names filtering a different axis.
 *
 * Ported verbatim from UtilityFunctions.java:1880-1915. Two details in that
 * mapping are deliberate and easy to "correct" into a bug:
 *
 *   • `audit` is status 10, NOT [3,5]. The new CRM's own Audit & Complete TAB
 *     uses [3,5] and files 10 under "Pending for Feedback" — the two systems
 *     have those buckets crossed. Legacy is the reference here, so `audit`
 *     stays 10 and `completed` takes [3,5].
 *
 *   • scheduling / acknowledge are the SAME status (0), separated only by
 *     whether a technician is attached. Selecting BOTH must drop the flag
 *     entirely rather than AND two contradictory conditions.
 * ───────────────────────────────────────────────────────────────────── */

/*
 * Sorted by LABEL, matching legacy's
 * `returnList.sort(Comparator.comparing(Recipients::getContactName))` — so the
 * two dropdowns read in the same order side by side.
 */
export const JOB_STAGE_OPTIONS: StatusOption[] = [
  { value: 'audit',        label: 'Audit & complete' },
  { value: 'cancel',       label: 'Cancelled' },
  { value: 'completed',    label: 'Completed' },
  { value: 'enquiry',      label: 'Enquiry' },
  { value: 'fulfillment',  label: 'Fulfillment on hold' },
  { value: 'acknowledge',  label: 'Pending app acknowledgement' },
  { value: 'approval',     label: 'Pending for approval' },
  { value: 'scheduling',   label: 'Pending for scheduling' },
  { value: 'close',        label: 'Pending to close on app' },
  { value: 'start',        label: 'Pending to start' },
  { value: 'unconfirmed',  label: 'Unconfirmed' },
];

/* Stage → job_status ids. `scheduling`/`acknowledge` are handled separately. */
const STAGE_STATUS_IDS: Record<string, number[]> = {
  unconfirmed: [9],
  start:       [1],
  close:       [2, 20],
  audit:       [10],
  approval:    [15],
  fulfillment: [21],
  completed:   [3, 5],
  enquiry:     [7],
  cancel:      [6],
};

export type StageFilter = { statuses: number[]; assigned?: boolean };

/*
 * A TAB, EXPRESSED AS A FILTER SELECTION (2026-09-16).
 *
 * Manage Jobs used to carry TWO status mechanisms: the `?tab=` bucket, whose
 * pins were unconditional, and the Bucket / Job Status dropdowns. They could
 * contradict each other, so the dropdowns were HIDDEN whenever a bucket was
 * active — which is why a bucket-scoped user saw a different filter panel from
 * everyone else, with a separate card above it.
 *
 * Owner's call: one panel for everybody. So a tab now PRE-SELECTS the
 * dropdowns and the dropdowns are the only status mechanism. The translation is
 * DERIVED from the same stage definitions the dropdown offers, not typed out as
 * a second table that could drift from them:
 *
 *   1. the tab's own status codes (and its `assigned` axis, if it pins one);
 *   2. every stage option whose resolved statuses fall inside those codes and
 *      whose `assigned` axis agrees;
 *   3. only if those stages cover the tab's codes EXACTLY is the tab
 *      expressible — otherwise nothing is pre-selected and the tab's extra
 *      pins (a date window, a quotation state) keep doing their own work.
 *
 * Returning empty is therefore a real answer, not a failure: `running-late`
 * (statuses 0+1 AND requested-before-now) is not a status selection, and
 * pretending it were would widen it.
 */
export function tabSelectionFor(tab: TabStatusDef | undefined | null): { bucketStatus: string; stages: string[] } {
  const none = { bucketStatus: '', stages: [] as string[] };
  if (!tab) return none;
  const codes = tab.statuses ?? (tab.status !== undefined ? [tab.status] : []);
  if (codes.length === 0) return none;
  const codeSet = new Set(codes);

  const stages = JOB_STAGE_OPTIONS.filter((o) => {
    const r = resolveStageFilter([o.value]);
    if (!r || r.statuses.length === 0) return false;
    if (!r.statuses.every((c) => codeSet.has(c))) return false;
    // The technician axis has to agree, or "Pending for scheduling" would also
    // match the assigned-but-unacknowledged bucket that shares status 0.
    if (tab.assigned !== undefined && r.assigned !== tab.assigned) return false;
    if (tab.assigned === undefined && r.assigned !== undefined) return false;
    return true;
  }).map((o) => o.value);

  if (stages.length === 0) return none;
  const covered = new Set(stages.flatMap((v) => resolveStageFilter([v])?.statuses ?? []));
  if (covered.size !== codeSet.size || [...codeSet].some((c) => !covered.has(c))) return none;

  const bucketStatus = Object.keys(BUCKET_STATUS_MAP)
    .find((k) => codes.every((c) => BUCKET_STATUS_MAP[k].includes(c))) ?? '';
  return { bucketStatus, stages };
}

/*
 * Resolve selected stages into the backend's `statuses` + `assigned` pair.
 *
 * `assigned` reproduces legacy's efrFlag, including its looseness: the flag
 * applies to EVERY selected id, not only the zeros. Picking
 * "Pending for scheduling" + "Unconfirmed" therefore yields
 * statuses=[0,9] & assigned=false — unconfirmed jobs that already have a
 * technician drop out. That is what legacy does today, and parity is the
 * requirement; narrowing it would be a different filter wearing the same name.
 */
export function resolveStageFilter(selected: string[]): StageFilter | null {
  if (!selected || selected.length === 0) return null;
  const picked = new Set(selected.map((s) => String(s).trim().toLowerCase()));

  const ids: number[] = [];
  let assigned: boolean | undefined;

  const hasScheduling = picked.has('scheduling');
  const hasAcknowledge = picked.has('acknowledge');
  if (hasScheduling || hasAcknowledge) {
    ids.push(0);
    // Both → the technician axis is not being filtered at all.
    if (hasScheduling && hasAcknowledge) assigned = undefined;
    else assigned = hasAcknowledge;
  }

  for (const stage of picked) {
    for (const id of STAGE_STATUS_IDS[stage] ?? []) ids.push(id);
  }

  // Dedupe, preserving first-seen order (legacy uses a LinkedHashSet).
  return { statuses: [...new Set(ids)], assigned };
}

/*
 * Stage options scoped to the chosen Bucket Status.
 *
 * Same rule the numeric dropdown enforced: Bucket Status and the stage filter
 * both narrow job_status and the backend ANDs them, so "Closed" + "Pending to
 * start" is a guaranteed-empty result. Offering only stages whose ids fall
 * inside the bucket makes that contradiction unconstructable instead of merely
 * unexplained. No bucket → every stage.
 */
export function jobStageOptionsFor(bucketStatus: string, allowed?: AllowedStages | null): StatusOption[] {
  const ids = bucketStatus ? BUCKET_STATUS_MAP[bucketStatus] : null;
  const visible = isUnrestricted(allowed) ? null : stageVisibleStatuses(allowed!.stages);
  if (!ids && !visible) return JOB_STAGE_OPTIONS;
  return JOB_STAGE_OPTIONS.filter((o) => {
    const resolved = resolveStageFilter([o.value]);
    if (!resolved) return false;
    if (ids && !resolved.statuses.some((c) => ids.includes(c))) return false;
    if (visible && !resolved.statuses.some((c) => visible.has(c))) return false;
    return true;
  });
}

/*
 * The Open / Closed / Cancelled selector, minus any bucket the user cannot see
 * a single status inside. Without this a restricted user could pick "Closed",
 * get an empty Job Status list and an empty table, with nothing saying why.
 */
export const BUCKET_OPTIONS: StatusOption[] = [
  { value: 'open',      label: 'Open' },
  { value: 'closed',    label: 'Closed / Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function bucketOptionsFor(allowed?: AllowedStages | null): StatusOption[] {
  if (isUnrestricted(allowed)) return BUCKET_OPTIONS;
  const visible = stageVisibleStatuses(allowed!.stages);
  return BUCKET_OPTIONS.filter((b) => (BUCKET_STATUS_MAP[b.value] || []).some((c) => visible.has(c)));
}

/* ─────────────────────────────────────────────────────────────────────
 * The single status-precedence rule.
 *
 * Manage Jobs derived the status parameters in THREE places — the list
 * request, the Export button's query string, and the bulk-action filter prop.
 * Each re-implemented the precedence by hand, and on 2026-08-18 two of the
 * three had already drifted: the Export builder ignored stage selections and
 * the server-side search entirely, so the sheet silently contained rows the
 * operator had filtered off screen. Nothing failed; the file was just wider
 * than the table it claimed to mirror.
 *
 * One function, one rule, one place to test. Callers shape the result for
 * their transport (object spread vs URLSearchParams) but never re-derive it.
 * ───────────────────────────────────────────────────────────────────── */

export type TabStatusDef = { status?: number; statuses?: number[]; assigned?: boolean };
/* Values are transport-ready: `statuses`/`assigned` are strings because both
 * the query string and api.get send them verbatim. Absent keys mean "don't
 * send", which api.get strips and URLSearchParams simply never sets. */
export type StatusParams = { status?: number; statuses?: string; assigned?: string };

export function buildStatusParams({
  psActive = false,
  stages = [],
  bucketStatus = '',
  tab = null,
}: {
  psActive?: boolean;
  stages?: string[];
  bucketStatus?: string;
  tab?: TabStatusDef | null;
}): StatusParams {
  /*
   * Pending for Scheduling IS the bucket `job_status = 0 AND efr IS NULL`. Its
   * pins are unconditional — no filter may widen or replace them — so both
   * operator overrides are disarmed there and only the tab speaks. This also
   * neutralises a stale selection carried over from another tab.
   */
  const stageFilter = psActive ? null : resolveStageFilter(stages);

  // 1. Stages outrank everything: legacy's resolveJobStatus() returns the
  //    Open/Closed/Cancelled group ONLY when no stage is ticked.
  if (stageFilter) {
    return {
      statuses: stageFilter.statuses.join(','),
      ...(stageFilter.assigned === undefined
        ? {}
        : { assigned: String(stageFilter.assigned) }),
    };
  }

  // 2. Bucket Status — an explicit categorical pick beats the tab. It says
  //    nothing about technician presence, so `assigned` is deliberately absent.
  const bucket = (!psActive && bucketStatus) ? BUCKET_STATUS_MAP[bucketStatus] : null;
  if (bucket) return { statuses: bucket.join(',') };

  // 3. The tab's own pins.
  const out: StatusParams = {};
  if (tab?.statuses) out.statuses = tab.statuses.join(',');
  else if (tab?.status != null) out.status = tab.status;
  if (tab?.assigned !== undefined) out.assigned = String(tab.assigned);
  return out;
}
