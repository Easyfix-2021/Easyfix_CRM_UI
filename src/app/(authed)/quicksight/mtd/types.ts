/*
 * QuickSight — MTD: the shapes the four /api/admin/quicksight/mtd endpoints
 * return.
 *
 * A transcription of the two backend services, not a re-modelling of them: the
 * field names, the nesting and the nulls are the server's.
 *
 *   /mtd/report   MtdReportResponse    the six KPI tiles and sections 1 to 10
 *                 (EasyFix_Backend services/quicksight/mtd-report.service.js)
 *   /mtd/jobs     MtdJobsResponse      section 11, one page of one matrix cell
 *   /mtd          MtdTableResponse     the per-SPOC book-of-business table
 *   /mtd/summary  the same totals with no rows (this tab has no use for it)
 *                 (EasyFix_Backend services/quicksight/mtd.service.js)
 *
 * THREE THINGS TO READ BEFORE USING THE REPORT TYPES.
 *
 *   `ordersCreated` IS NOT PART OF `inHand` AND RECONCILES AGAINST NOTHING.
 *   It counts the tickets RAISED in the window; completed / cancelled / open
 *   count jobs by when they closed, were cancelled, or simply are — mostly
 *   other jobs from other months. A month can complete more than it created,
 *   and that is not a bug to explain away in the UI.
 *
 *   THERE ARE TWO COMPLETION RATES AND BOTH ARE CORRECT.
 *   `kpis.completionPct` is (completed + open) / inHand — it counts open jobs
 *   on both sides. `completionVsCancellation.completionRate` is completed /
 *   (completed + cancelled) — FINISHED jobs only, so it is always the higher
 *   number. They answer different questions; nothing here reconciles them.
 *
 *   THERE ARE TWO COMPLETED COUNTS AND BOTH ARE CORRECT.
 *   `kpis.completed` counts closures on the AUDIT & CHECKOUT day, which is what
 *   this report has always shipped. `completedOnCheckin.count` counts the same
 *   jobs on the APP CHECK-IN day, which is the basis the owner's MIS v2 moved
 *   to. They are offered side by side on purpose, neither replaces the other,
 *   and `completedOnCheckin.complete` says when the second is only a floor.
 */

import type { DateWindow } from '@/lib/report-window';
import type { MtdJobSortKey, MtdSortKey } from './api';

/* ── the shape every percentage on the tab arrives in ─────────────────────── */

/**
 * One percentage, as the backend's `pct()` builds it: the two counts it was
 * made of, and the value to one decimal.
 *
 * `pct` IS NULL WHEN `den` IS 0 — never 0. A zero denominator is "there was
 * nothing to measure", which is not the same claim as "0%", so every render
 * site prints an en dash there (see `pct1` in ./sections/shared).
 */
export type MtdPct = {
  num: number;
  den: number;
  pct: number | null;
};

/* ── /mtd/report ──────────────────────────────────────────────────────────── */

/** The window and the pickers that produced this build, as the server read them. */
export type MtdScope = {
  /** null, never 0, when the filter is All. */
  verticalId: number | null;
  zonalManagerId: number | null;
  /** null = every option. Never an empty array: an empty pick IS "every option". */
  clientIds: number[] | null;
  verticals: string[] | null;
  spocUserIds: number[] | null;
};

/**
 * When the database was read, and whether today is still filling.
 *
 * `dayStillFilling` is true before 23:00 IST: it is what makes the last bar of
 * the day-wise chart a PARTIAL bar rather than a finished one, and it is why
 * that bar is excluded from the forecast's average.
 */
export type MtdAsOf = {
  /** ISO instant the counts were read (the cache entry's build time, up to 60s old). */
  readAt: string;
  /** Today in IST, 'YYYY-MM-DD'. */
  day: string;
  dayStillFilling: boolean;
};

/**
 * The tab's six tiles and the two figures only the client report shows, in the
 * template's order.
 *
 * `inHand` = completed + cancelled + open, the denominator of three of the
 * four percentages. `tatPct`'s and `sdaPct`'s denominator is COMPLETED, not
 * inHand — a cancelled or open job has no turnaround and no arrival to have
 * met.
 *
 * completionPct.num + cancelledPct.num === inHand by construction, so the
 * Completion % and Cancelled % tiles are complements of each other to the
 * decimal they are shown at.
 *
 * ⚠ ESCALATED IS DIVIDED BY `inHand`, NOT BY `completed`. The MIS template
 * counts `Is Escalated = 1` over completed, cancelled AND open rows alike, and
 * its tile reads "N% of jobs in hand" — an escalation is a complaint about a
 * job, and the jobs people escalate hardest are the ones still OPEN. Labelling
 * this figure against completed jobs would overstate the rate several times
 * over, so every render site must say "of jobs in hand".
 */
export type MtdKpis = {
  /** Tickets RAISED in the window. Not part of inHand — see the module header. */
  ordersCreated: number;
  /** Closures counted on the AUDIT & CHECKOUT day. `completedOnCheckin` is the other basis. */
  completed: number;
  cancelled: number;
  open: number;
  inHand: number;
  completionPct: MtdPct;
  tatPct: MtdPct;
  /**
   * Completed jobs whose SDA Status is 1, over completed — the same shape as
   * `tatPct`, and `den` is the same number.
   *
   * A completed job whose SDA Status is BLANK stays in the DENOMINATOR, exactly
   * as the template leaves it there. Dropping those rows would raise the
   * percentage every time the underlying data got worse.
   */
  sdaPct: MtdPct;
  cancelledPct: MtdPct;
  /** Jobs flagged escalated across ALL THREE sets. `escalatedBySet` splits it. */
  escalated: number;
  /** `escalated` over `inHand` — never over `completed`. See the warning above. */
  escalatedPct: MtdPct;
};

/**
 * Where `kpis.escalated` sits: the three parts always sum to it.
 *
 * Carried so a breakdown costs no second walk of the job list, and so a tile
 * can show that most escalations usually sit on OPEN jobs — which is the whole
 * reason the metric is counted over jobs in hand rather than over closures.
 */
export type MtdEscalatedBySet = {
  completed: number;
  cancelled: number;
  open: number;
};

/**
 * Completed jobs counted on the APP CHECK-IN DATE — the owner's MIS v2 basis,
 * offered BESIDE `kpis.completed` rather than in place of it.
 *
 * v2 derives one basis column for every row in its file and filters every
 * figure through it, so there the check-in date does not merely re-bucket the
 * closures: it decides which of them are in the month at all, and with them
 * TAT %, SDA %, the city split and the days-open bands. `kpis.completed` is
 * already live on the closure basis, so the backend keeps that number byte for
 * byte and ships this one alongside it.
 *
 * `count` + `beforeWindow` + `afterWindow` + `unknownDate` === `kpis.completed`:
 * every closure this window holds sits on exactly one side of the check-in
 * window.
 */
export type MtdCompletedOnCheckin = {
  /** Always 'checkin' — the basis this object is counted on, named rather than implied. */
  basis: string;
  /** The count on this basis. Equals `daily.totals.completedCheckin`. */
  count: number;
  /** Held closures whose check-in day falls BEFORE the window. */
  beforeWindow: number;
  /** Held closures whose check-in day falls AFTER the window. */
  afterWindow: number;
  /** Held closures with no usable date on either basis. */
  unknownDate: number;
  /**
   * How many of the held closures had a BLANK check-in cell and so fell back
   * to their closure day (the template's own `doneAt()` fallback). A large
   * number here means the two bases are closer than they look.
   */
  noCheckinDate: number;
  /**
   * FALSE WHEN THE WINDOW ENDS BEFORE TODAY, and then `count` IS A FLOOR — not
   * a figure comparable with the owner's file. A job that checked in inside a
   * past window but was audited after it never reached this report at all,
   * because the completed set is read on the closure date. True for the
   * month-to-date view the tab opens on. Every render site must respect this
   * rather than presenting a short number as v2's.
   */
  complete: boolean;
};

/**
 * One bar of section 1 — a day, or a Monday-start week once the range is wider
 * than 62 days.
 *
 * `open` is THE BACKLOG AT THE END OF THE BUCKET'S LAST DAY: jobs raised on or
 * before that day and not yet completed or cancelled by then. It is NULL
 * before `daily.openFrom`, and that null is a GAP IN THE LINE, never a zero —
 * those days genuinely cannot be reconstructed from the jobs the window holds.
 *
 * `partial` marks the bucket that covers today while today is still filling.
 */
export type MtdDailyBucket = {
  from: string;
  to: string;
  created: number;
  /** Closures placed on their AUDIT & CHECKOUT day. */
  completed: number;
  /**
   * The same closures placed on their APP CHECK-IN day instead — v2's basis,
   * aligned bucket for bucket with `completed` so the two can be read against
   * each other. Their totals differ: a job can check in inside the window and
   * close outside it, or the other way round.
   */
  completedCheckin: number;
  open: number | null;
  partial: boolean;
};

/**
 * The dashed next-day segment: the average of the last two COMPLETE buckets,
 * carried one day forward. Offered only in the day view and only when the
 * range runs up to today.
 *
 * It is NOT one of `buckets` — the chart draws it as its own dashed line.
 * `beyondRange` false means it lands on today's part-day bar; true means the
 * day after the range, which is an extra category on the axis.
 */
export type MtdForecast = {
  day: string;
  created: number;
  completed: number;
  basisDays: string[];
  window: number;
  beyondRange: boolean;
};

export type MtdDaily = {
  granularity: 'day' | 'week';
  buckets: MtdDailyBucket[];
  /**
   * totals.created === kpis.ordersCreated, totals.completed === kpis.completed,
   * and totals.completedCheckin === completedOnCheckin.count.
   */
  totals: { created: number; completed: number; completedCheckin: number };
  /** The first day the backlog line can honestly be drawn for, or null when it cannot at all. */
  openFrom: string | null;
  forecast: MtdForecast | null;
};

/** Section 2's donut. `completionRate` is finished jobs only — see the module header. */
export type MtdCompletionVsCancellation = {
  completed: number;
  cancelled: number;
  finished: number;
  completionRate: MtdPct;
};

/** One of the four days-open bands of sections 3 and 4. */
export type MtdDaysOpenBucket = {
  /** '0-2' | '3-5' | '6-9' | '9+' — the API's key, and what a selection is stored as. */
  key: string;
  label: string;
  completed: number;
  cancelled: number;
  total: number;
  cancelRate: MtdPct;
};

/**
 * Sections 3 and 4: FINISHED jobs only, split by the export's Aging column.
 * Open jobs are not in this section at all.
 *
 * `worstBucket` is the band with the HIGHEST CANCEL RATE, not the most
 * cancellations — a band with three jobs and two cancellations is the one
 * worth looking at even though a busier band lost more. It is the band the
 * tiles highlight.
 */
export type MtdByDaysOpen = {
  buckets: MtdDaysOpenBucket[];
  totals: { completed: number; cancelled: number; total: number; cancelRate: MtdPct };
  worstBucket: string | null;
};

/**
 * One cancel reason or comment theme, with its split across the days-open
 * bands.
 *
 * `byBucket` is indexed by `byDaysOpen.buckets` order, and it is the reason
 * clicking a days-open tile costs no second request: sum the selected bands'
 * entries and re-sort in the browser.
 */
export type MtdCancelEntry = {
  name: string;
  total: number;
  byBucket: number[];
};

/**
 * Sections 5, 6 and 7.
 *
 * `reasons` and `themes` arrive ALREADY SORTED, total descending then by name.
 * A cancelled job with no reason picked is the literal row '(No reason
 * picked)' — it is never dropped. `themeNames` is all fourteen themes in the
 * MIS engine's display order, for a stable legend and colour map.
 */
export type MtdWhyCancelled = {
  cancelled: number;
  buckets: Array<{ key: string; label: string }>;
  reasons: MtdCancelEntry[];
  themes: MtdCancelEntry[];
  themeNames: string[];
};

/**
 * Section 8. Sorted created desc, then completed desc, then name. `state` is
 * the MODAL state across that city's rows (city names repeat across states).
 * A job with no city is the row '(City not given)', pinned last.
 */
export type MtdCityRow = {
  city: string;
  state: string | null;
  created: number;
  completed: number;
};

/**
 * Sections 9 and 10: the status by days-open matrix.
 *
 * THESE SIX BANDS ARE NOT SECTION 3's FOUR. The owner asked for both splits
 * and the backend keeps them as two separate constants on purpose — nothing
 * here should share a list between them.
 *
 * rows[0..2].total === kpis.completed / cancelled / open, and `grand` ===
 * kpis.inHand. Open jobs age to NOW.
 */
export type MtdStatusAging = {
  buckets: Array<{ key: string; label: string; short: string }>;
  rows: Array<{
    status: MtdJobStatus;
    label: string;
    counts: number[];
    total: number;
  }>;
  columnTotals: number[];
  grand: number;
};

/** The three rows of that matrix, and the `status` param of /mtd/jobs. */
export type MtdJobStatus = 'completed' | 'cancelled' | 'open';

/**
 * The client document's tier matrix: OPEN orders by tier and days open.
 *
 * ⚠ THE SAME SIX BANDS AS `MtdStatusAging`, SPLIT ON THE SAME VALUE — the
 * export's Aging column — because the backend reuses one set of boundaries for
 * both. The two matrices sit together on the client report, and a job landing
 * in a different band in each would be visible on one screen.
 *
 * ⚠ OPEN JOBS ONLY, AND THAT IS THE SECTION'S WHOLE CLAIM. `grand` ===
 * `kpis.open` for EVERY filter combination — not `kpis.inHand` — which is what
 * lets the card say "same open jobs as the tiles at the top". A completed or
 * cancelled job leaking in turns `checks.tierAging` false rather than quietly
 * inflating a table nobody cross-foots.
 *
 * `rows` ARRIVES SORTED and must be rendered in order: real tiers by
 * natural-numeric collation, so 'Tier - 2' precedes 'Tier - 10', then the
 * blank-tier row LAST. A lexical re-sort in the UI would put 'Tier - 10' second
 * and silently disagree with the owner's .docx.
 */
export type MtdTierAging = {
  buckets: Array<{ key: string; label: string; short: string }>;
  rows: Array<{
    /**
     * The DISPLAY LABEL, ready to print: 'Tier - 1', … or '(Tier not given)'.
     * Never null, never '', never a bare number — nothing here reformats it.
     */
    tier: string;
    /**
     * Pin the blank-tier row with THIS, never by comparing `tier` to a label.
     * The label is wording the owner can change in an afternoon; the flag is
     * the contract. At most one row carries it.
     */
    blank: boolean;
    counts: number[];
    total: number;
  }>;
  columnTotals: number[];
  grand: number;
};

/**
 * One option of one picker, with the count it would contribute.
 *
 * `jobs` IS COUNTED WITH THAT PICKER'S OWN SELECTION IGNORED (the other two
 * applied), which is the MIS template's countsFor() behaviour: an unticked
 * option shows what ticking it would ADD rather than the zero it has today,
 * and that is why the counts do not collapse as a selection narrows. Counted
 * over jobs IN HAND (completed + cancelled + open), not over orders created.
 */
export type MtdFilterOption<Id extends number | string> = {
  id: Id;
  name: string;
  jobs: number;
};

/**
 * The three multi-select pickers' options.
 *
 * A vertical's `id` IS ITS NAME — the export carries verticals as names on job
 * rows, so there is no id to select on. '(Blank)' is the option for a job that
 * carries none; for clients the blank is the id 0, and for SPOCs the id 0 is
 * 'Unattributed' (the same label, for the same jobs, that the per-SPOC table
 * at the foot of the tab already uses).
 */
export type MtdFilterOptions = {
  clients: Array<MtdFilterOption<number>>;
  verticals: Array<MtdFilterOption<string>>;
  spocs: Array<MtdFilterOption<number>>;
};

/** How many job rows each loader read — the status line's honesty check. */
export type MtdJobsRead = {
  ticketCreated: number;
  open: number;
  completed: number;
  cancelled: number;
};

export type MtdMeta = {
  /** ISO instant the counts were read (the cache entry's build time, up to 60s old). */
  readAt: string;
  jobsRead: MtdJobsRead;
  ms: number;
};

/**
 * The server's own reconciliation, one flag per identity it checks.
 *
 * Typed as a record rather than a fixed shape: a check added on the backend
 * must show up in the banner without a frontend release, and the banner only
 * ever names the keys that are false.
 */
export type MtdChecks = Record<string, boolean>;

export type MtdReportResponse = {
  window: DateWindow;
  scope: MtdScope;
  asOf: MtdAsOf;
  kpis: MtdKpis;
  /** The per-set split behind `kpis.escalated`. The three always sum to it. */
  escalatedBySet: MtdEscalatedBySet;
  /** Completed on the App CheckIn Date — v2's basis, beside the closure basis. */
  completedOnCheckin: MtdCompletedOnCheckin;
  daily: MtdDaily;
  completionVsCancellation: MtdCompletionVsCancellation;
  byDaysOpen: MtdByDaysOpen;
  whyCancelled: MtdWhyCancelled;
  cities: MtdCityRow[];
  statusAging: MtdStatusAging;
  /** The client document's OPEN-only tier matrix. `grand` === `kpis.open`. */
  tierAging: MtdTierAging;
  filters: MtdFilterOptions;
  /** False means a section's parts no longer sum to its total and the server logged an error. */
  reconciled: boolean;
  checks: MtdChecks;
  /** Rows behind the matrix — the size section 11 pages through. */
  jobCount: number;
  meta: MtdMeta;
};

/* ── /mtd/jobs (section 11) ───────────────────────────────────────────────── */

export type MtdJobRow = {
  jobId: number;
  jobStatus: string;
  daysOpen: number;
  status: MtdJobStatus;
};

export type MtdJobsResponse = {
  window: DateWindow;
  scope: MtdScope;
  /**
   * The matrix cell this page came from. `total` IS THE SIZE OF THAT CELL and
   * must equal the number printed in statusAging for it — assert that when
   * wiring a click, because a mismatch means the list and the matrix are
   * describing different job sets.
   */
  cell: { status: MtdJobStatus | 'all'; bucket: string; total: number };
  /** The search box, trimmed, or null when it is empty. */
  query: string | null;
  sort: { sortBy: MtdJobSortKey; sortDir: 'asc' | 'desc' };
  /** The page of jobs. `total` below is the MATCHED set, which `q` narrows and `cell.total` does not. */
  data: MtdJobRow[];
  total: number;
  pageNumber: number;
  pageSize: number;
  totalPages: number;
  reconciled: boolean;
  meta: MtdMeta;
};

/* ── /mtd and /mtd/summary (the per-SPOC book-of-business table) ───────────── */

/**
 * The five counts, every one of them a job count.
 *
 * `open` and `inProgress` IGNORE the date window — they are a snapshot of what
 * is open RIGHT NOW (the backend reads them with no date filter at all), and
 * `inProgress` is a subset of `open`. The other three are counted inside the
 * window, on the date that defines them: ticket created, checkout, cancel.
 * Anywhere these are rendered, the two snapshot columns must say so, or a
 * reader who changes the dates will file a bug when they do not move.
 */
export type MtdCounts = {
  ticketCreated: number;
  inProgress: number;
  open: number;
  completed: number;
  cancelled: number;
};

/** One named person: the client's Primary SPOC, with their five counts. */
export type MtdPerson = MtdCounts & {
  userId: number;
  name: string;
};

/** The pinned footer line: everything that could not be attributed to a person. */
export type MtdUnattributed = MtdCounts & {
  userId: null;
  /** The backend's own label ('Unattributed') — rendered as sent, never re-worded here. */
  name: string;
};

export type MtdTableResponse = {
  window: DateWindow;
  /** null, never 0, when the filter is All. */
  scope: { verticalId: number | null; zonalManagerId: number | null };
  sort: { sortBy: MtdSortKey; sortDir: 'asc' | 'desc' };
  /** The PAGE of named people. */
  data: MtdPerson[];
  /** Named people in the whole filtered set — Unattributed is not one of them. */
  total: number;
  pageNumber: number;
  pageSize: number;
  totalPages: number;
  /* All three are over the WHOLE filtered set on every page, so the tiles need no second request. */
  totals: MtdCounts;
  attributed: MtdCounts;
  unattributed: MtdUnattributed;
  reconciled: boolean;
  meta: MtdMeta;
};
