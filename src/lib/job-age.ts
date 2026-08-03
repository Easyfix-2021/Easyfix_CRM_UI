/*
 * Job Age — THE one shared formatter for "how long has this ticket been alive".
 *
 * Lives next to the other shared job helpers (job-tabs / job-stages /
 * job-address) rather than inside format.ts, which is deliberately kept to
 * generic, domain-free display formatters.
 *
 * ── The definition (server-owned, do NOT re-derive it client-side) ──────────
 *
 * Age measures elapsed time from ticket creation to the job's TERMINAL event,
 * or to NOW() while the job is still open:
 *
 *   START (always):  tbl_job.ticket_created_date_time
 *   END, by job_status:
 *     3, 5  Completed / Completed-alt → checkout_date_time
 *     6     Cancelled                 → cancel_date_time
 *     7     Enquiry                   → enquiry_date_time
 *     anything else (OPEN)            → NOW()   (keeps ticking)
 *
 * The backend computes this with TIMESTAMPDIFF(DAY, …) (which floors with the
 * TIME included — 23h59m ⇒ 0, 24h00m ⇒ 1) and ships two fields on every job
 * LIST row AND on the job detail payload:
 *
 *   ageDays: number   // floored whole days — the primary reading
 *   ageSecs: number   // precise seconds — sub-day display + the sort column
 *
 * The FE must NOT recompute age from timestamps. Three earlier hand-rolled
 * copies did exactly that (my-orders' `jobAgeLabel`, UnconfirmedJobsTable's
 * `jobAge`) and all of them were wrong for closed jobs: they measured
 * "created → right now", so a job completed 8 months ago kept ageing forever.
 * Those copies are gone; this module replaced them.
 *
 * ── Display contract ───────────────────────────────────────────────────────
 *
 *   ageDays >= 1  → "3d"            (whole days; the primary reading)
 *   ageDays == 0  → "5h" / "12m"    (derived from ageSecs, so a fresh job
 *                                    reads as something other than a bare 0)
 *   missing/null  → "—" (em-dash)   — NEVER "NaN" and never a misleading "0"
 *
 * Robustness mirrors the server's: a negative value (a backdated timestamp
 * correction) clamps to 0 rather than rendering as "-3 days".
 */

/*
 * The two fields the backend adds. Every job row type that wants an Age cell
 * spreads this in. Both optional so a row rendered against an older API deploy
 * (staging rollout, cached payload) type-checks and renders the em-dash.
 */
export type JobAgeFields = {
  ageDays?: number | null;
  ageSecs?: number | null;
};

/*
 * The literal sort key sent as `?sortBy=` for the Age column, whitelisted
 * server-side alongside job_id / created_date_time / … Named once here so
 * every sortable Age header (Manage Jobs, My Orders, the Pending-for-
 * Scheduling column set, Unconfirmed) sends the SAME string, and so a rename
 * on the backend is a one-line change here rather than a five-file grep.
 *
 * ⚠ THIS STRING IS THE BACKEND'S WHITELIST KEY, NOT A PROJECTION FIELD NAME.
 * It must stay byte-identical to a key of `SORTABLE_COLUMNS` in
 * EasyFix_Backend/services/job.service.js — the list validator derives its
 * `sortBy` valid() list from those keys, so an unknown literal is NOT a silent
 * no-op: Joi rejects it and `GET /admin/jobs` 400s the whole page. (It shipped
 * as 'ageSecs' — the PROJECTION alias — and every click on the Age header
 * blanked the grid with "Failed to load jobs: Validation failed", permanently
 * for anyone whose URL had `?sort=ageSecs:asc` persisted into it.)
 *
 * The key is `age`, and server-side it maps to the SECONDS expression — the
 * same constant the projection emits as `ageSecs` — never the floored day
 * value, or every job under 24h old would tie at 0 and order arbitrarily.
 */
export const JOB_AGE_SORT_KEY = 'age';

const EM_DASH = '—';

const SEC_PER_MIN  = 60;
const SEC_PER_HOUR = 3600;
const SEC_PER_DAY  = 86_400;

/*
 * Coerce an API value to a non-negative finite number, or null.
 * `unknown` in, because call sites hand us values off loosely-typed payloads
 * (`Record<string, unknown>` job details) as well as typed rows.
 */
function toCount(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  // Clamp: a backdated correction must not render as "-3d".
  return n < 0 ? 0 : Math.floor(n);
}

/*
 * Read the two age fields off anything job-shaped. Defensive (`unknown` in)
 * so a caller can pass a whole job row / detail object regardless of how
 * loosely its type declares these fields — no per-site casts needed.
 */
function readAge(row: unknown): { days: number | null; secs: number | null } {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
  const secs = toCount(r.ageSecs);
  // Fall back to deriving days from seconds when only ageSecs arrived, and
  // vice-versa — either field alone is enough to render something truthful.
  const days = toCount(r.ageDays) ?? (secs == null ? null : Math.floor(secs / SEC_PER_DAY));
  return { days, secs };
}

/*
 * formatJobAge — the compact cell reading. See the display contract above.
 *
 *   formatJobAge({ ageDays: 12, ageSecs: 1_080_000 })  → '12d 12h'
 *   formatJobAge({ ageDays: 2,  ageSecs: 172_800 })    → '2d'      (no "2d 0h")
 *   formatJobAge({ ageDays: 0,  ageSecs: 18_000 })     → '5h'
 *   formatJobAge({ ageDays: 0,  ageSecs: 720 })        → '12m'
 *   formatJobAge({ ageDays: 0,  ageSecs: 12 })         → '<1m'
 *   formatJobAge({ ageDays: 3 })                       → '3d'      (no ageSecs)
 *   formatJobAge({})                                   → '—'
 */
export function formatJobAge(row: unknown): string {
  const { days, secs } = readAge(row);
  if (days == null && secs == null) return EM_DASH;

  /*
   * Days + REMAINDER HOURS ("1d 2h", "2d", "3d 1h"). The hours part is the
   * remainder AFTER whole days, not the total — 26 hours is "1d 2h", never
   * "1d 26h". It is omitted when zero so a clean multiple of a day reads "2d"
   * rather than a noisy "2d 0h".
   */
  if (secs != null) {
    const d = Math.floor(secs / SEC_PER_DAY);
    const h = Math.floor((secs % SEC_PER_DAY) / SEC_PER_HOUR);
    if (d >= 1) return h > 0 ? `${d}d ${h}h` : `${d}d`;
    // Sub-day: hours, then minutes, so a fresh job never reads as a bare "0".
    if (h >= 1) return `${h}h`;
    const mins = Math.floor(secs / SEC_PER_MIN);
    return mins >= 1 ? `${mins}m` : '<1m';
  }

  /*
   * ageSecs absent (older backend payload): ageDays alone cannot yield the
   * hours part, so fall back to whole days. Never fabricate an hours component
   * we don't have.
   */
  if (days != null && days >= 1) return `${days}d`;
  return '0d';
}

/*
 * jobAgeTitle — the precise value for the cell's `title` tooltip, so the
 * floored "3d" on screen is always one hover away from "3d 4h 12m".
 * Returns undefined when there is nothing to say (so the attribute is
 * omitted rather than rendering an empty tooltip).
 */
export function jobAgeTitle(row: unknown): string | undefined {
  const { days, secs } = readAge(row);
  if (days == null && secs == null) return undefined;
  if (secs == null) return `Age: ${days}d (ticket created → close, or now if still open)`;
  const d = Math.floor(secs / SEC_PER_DAY);
  const h = Math.floor((secs % SEC_PER_DAY) / SEC_PER_HOUR);
  const m = Math.floor((secs % SEC_PER_HOUR) / SEC_PER_MIN);
  return `Age: ${d}d ${h}h ${m}m (ticket created → close, or now if still open)`;
}
