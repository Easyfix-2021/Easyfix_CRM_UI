/*
 * Job Stage Access — the per-user "which lifecycle stages may I touch?"
 * permission model. Mirrors EXACTLY the backend contract (services/*.js) so
 * the two never drift:
 *
 *   me.allowedStages = { mode: 'all' | 'list'; stages: string[] }
 *     - mode 'all'  → unrestricted (Admin / Finance / users with NO stage rows).
 *                     Every stage/tab/transition shows.
 *     - mode 'list' → restricted to `stages` (an array of STAGE_KEYS). The
 *                     user only sees jobs whose status falls in an allowed
 *                     stage, and only sees transition buttons INTO the target
 *                     statuses that allowed stage permits.
 *     - mode 'list' with an EMPTY `stages` → explicit NO ACCESS: no stage owns
 *                     any status, so every check below returns false (no tabs,
 *                     no rows, no transition buttons). This is a real, saveable
 *                     grant — NOT the same as 'all'. Keep the two apart.
 *
 * A stage maps a stage_key →
 *   - visibleStatuses  : the job_status codes that belong to the stage (what
 *                        rows/tabs the stage exposes).
 *   - transitionTargets: the job_status codes a job may be moved TO from this
 *                        stage (what quick-action / lifecycle buttons show).
 *   - label            : the human tab label (Title Case).
 *
 * The server LIST endpoint is authoritative — it already row-filters by the
 * user's allowed statuses. Everything here is UX + defense-in-depth so a
 * restricted user isn't shown tabs/rows/buttons the server would reject.
 */

export type StageKey =
  | 'unconfirmed'
  | 'pending-scheduling'
  | 'pending-start'
  | 'pending-close'
  | 'audit-complete'
  | 'pending-feedback'
  | 'onhold'
  | 'estimate-pending'
  | 'cancelled';

export type StageDef = {
  key: StageKey;
  label: string;
  /* job_status codes that belong to (are visible in) this stage. */
  visibleStatuses: number[];
  /* job_status codes a job may be transitioned TO from this stage. */
  transitionTargets: number[];
};

/*
 * THE pinned contract — must match the backend stage map verbatim.
 *   stage_key            visibleStatuses   transitionTargets   label
 *   unconfirmed          [9]               [0,6]               Unconfirmed Orders
 *   pending-scheduling   [0]               [1,6,9]             Pending for Scheduling
 *   pending-start        [1]               [2,20,21,6]         Pending to Start
 *   pending-close        [2,20]            [3,5,21,6]          Pending to Close
 *   audit-complete       [3,5]             [10]               Audit & Complete
 *   pending-feedback     [10]              []                  Pending for Feedback
 *   onhold               [21]              [1,6]               Orders in Followup
 *   estimate-pending     [15]              [0,1,6]             Estimate Pending
 *   cancelled            [6]               []                  Cancelled
 */
export const STAGES: Record<StageKey, StageDef> = {
  'unconfirmed':        { key: 'unconfirmed',        label: 'Unconfirmed Orders',     visibleStatuses: [9],      transitionTargets: [0, 6] },
  'pending-scheduling': { key: 'pending-scheduling', label: 'Pending for Scheduling', visibleStatuses: [0],      transitionTargets: [1, 6, 9] },
  'pending-start':      { key: 'pending-start',      label: 'Pending to Start',       visibleStatuses: [1],      transitionTargets: [2, 20, 21, 6] },
  'pending-close':      { key: 'pending-close',      label: 'Pending to Close',       visibleStatuses: [2, 20],  transitionTargets: [3, 5, 21, 6] },
  'audit-complete':     { key: 'audit-complete',     label: 'Audit & Complete',       visibleStatuses: [3, 5],   transitionTargets: [10] },
  'pending-feedback':   { key: 'pending-feedback',   label: 'Pending for Feedback',   visibleStatuses: [10],     transitionTargets: [] },
  'onhold':             { key: 'onhold',             label: 'Orders in Followup',     visibleStatuses: [21],     transitionTargets: [1, 6] },
  'estimate-pending':   { key: 'estimate-pending',   label: 'Estimate Pending',       visibleStatuses: [15],     transitionTargets: [0, 1, 6] },
  'cancelled':          { key: 'cancelled',          label: 'Cancelled',              visibleStatuses: [6],      transitionTargets: [] },
};

/* Canonical stage-key ordering — drives STAGE_OPTIONS + tab clamping. */
export const STAGE_KEYS: StageKey[] = Object.keys(STAGES) as StageKey[];

/* {value, label} options for the ScopeMultiSelect in the Edit User form. */
export const STAGE_OPTIONS: Array<{ value: StageKey; label: string }> =
  STAGE_KEYS.map((k) => ({ value: k, label: STAGES[k].label }));

/*
 * The shape carried on `me.allowedStages`. `mode:'all'` is unrestricted;
 * `mode:'list'` restricts to `stages`. Undefined/null is treated as
 * unrestricted everywhere below (fail-open on the FE — the server is the
 * authority, so a still-loading `me` never hides a tab it shouldn't).
 */
export type AllowedStages = { mode: 'all' | 'list'; stages: string[] };

function isUnrestricted(allowed: AllowedStages | undefined | null): boolean {
  return !allowed || allowed.mode === 'all';
}

/*
 * Union of the visible job_status codes across the given stage keys.
 * Unknown keys are ignored (tolerant of stale/garbage data).
 */
export function stageVisibleStatuses(keys: string[]): Set<number> {
  const out = new Set<number>();
  for (const k of keys) {
    const def = STAGES[k as StageKey];
    if (def) for (const code of def.visibleStatuses) out.add(code);
  }
  return out;
}

/*
 * Is a job at `source` status visible to a user with `allowed` stages?
 * Unrestricted → always true.
 */
export function stageVisible(allowed: AllowedStages | undefined | null, source: number): boolean {
  if (isUnrestricted(allowed)) return true;
  return stageVisibleStatuses(allowed!.stages).has(source);
}

/*
 * May a user with `allowed` stages move a job from `source` → `target`?
 * Unrestricted → always true.
 *
 * Restricted: there must exist an allowed stage that (a) OWNS the source
 * status (source ∈ its visibleStatuses) AND (b) permits the target
 * (target ∈ its transitionTargets). This encodes "only from a stage I can
 * see, and only to a target that stage's lifecycle allows".
 */
export function transitionAllowed(
  allowed: AllowedStages | undefined | null,
  source: number,
  target: number,
): boolean {
  if (isUnrestricted(allowed)) return true;
  for (const k of allowed!.stages) {
    const def = STAGES[k as StageKey];
    if (!def) continue;
    if (def.visibleStatuses.includes(source) && def.transitionTargets.includes(target)) {
      return true;
    }
  }
  return false;
}

/*
 * Filter a list of lifecycle TABS down to the ones a restricted user may
 * see. A tab is kept only if its status(es) intersect the allowed visible
 * statuses. Aggregate tabs that carry no explicit status (e.g. "All", or the
 * quotation-driven dashboard drill-downs) are dropped for restricted users —
 * a cross-stage view would imply visibility the user doesn't have. Mode
 * 'all' (or unrestricted) → every tab is returned unchanged.
 */
export function filterTabsForStages<T extends { status?: number; statuses?: number[] }>(
  tabs: T[],
  allowed: AllowedStages | undefined | null,
): T[] {
  if (isUnrestricted(allowed)) return tabs;
  const visible = stageVisibleStatuses(allowed!.stages);
  return tabs.filter((t) => {
    const codes = t.statuses ?? (t.status !== undefined ? [t.status] : []);
    if (codes.length === 0) return false;
    return codes.some((c) => visible.has(c));
  });
}
