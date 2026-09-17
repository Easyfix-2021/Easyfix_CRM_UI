/*
 * QuickSight — Employee Performance: response types for the native Employee tab.
 *
 * Every type below mirrors, field for field, what the backend's pure
 * aggregation returns — EasyFix_Backend
 * services/quicksight/employee-performance/aggregate.js:
 *
 *   buildOptions(D)                 → FilterOptions     GET …/options
 *   buildSummary(D, filters)        → SummaryResponse   GET …/summary
 *   pageOpenJobs(D, filters, paging)→ OpenJobsPage      GET …/open-jobs
 *   pageTechnicians(D, filters, p)  → TechniciansPage   GET …/technicians
 *   memberDetail(D, filters, name)  → MemberDetail      GET …/member (null → 404)
 *
 * Derived by reading that file and by running it on the synthetic fixture and
 * on the stored snapshot. Numbers are raw (unrounded); format them with
 * ./format.ts. Where the snapshot passes a value through untouched (open-job
 * rows, member productivity/revenue rows) the type is as loose as the data.
 *
 * `null` from buildOptions / summary.dates means "no date in range".
 */

/* ── /meta ────────────────────────────────────────────────────────────────── */

export type SnapshotMeta = {
  dateFrom: string;
  dateTo: string;
  employeeCount: number;
  spocCount: number;
  /** ISO instant. Also the cache-buster `v` in every data key. */
  uploadedAt: string;
  uploadedBy: { userId: number | null; name: string | null };
  originalName: string | null;
  sizeBytes: number;
};

/* ── filter state (the body's; serialised by api.ts filtersQuery) ─────────── */

/*
 * Empty list = Select All. zm / month: '' or 'ALL' = All. from / to:
 * 'YYYY-MM-DD' or '' for the snapshot bound.
 */
export type Filters = {
  verticals: string[];
  zm: string;
  employees: string[];
  month: string;
  from: string;
  to: string;
};

/* ── /options — buildOptions ──────────────────────────────────────────────── */

export type MonthOption = {
  /** 'YYYY-MM' */
  value: string;
  /** 'August 2026' (en-US long month, as the dashboard's Month select). */
  label: string;
  /** First / last snapshot date in that month. */
  from: string | null;
  to: string | null;
};

export type EmployeeOption = {
  /** Raw CRM name — the value sent as `employee=`. */
  value: string;
  /** displayName, or 'Display Name (CRM NAME)' when the two differ. */
  label: string;
  displayName: string;
  /** Narrow the Employee list by the selected verticals on this. */
  vertical: string | null;
};

export type FilterOptions = {
  dateFrom: string | null;
  dateTo: string | null;
  verticals: string[];
  zonalManagers: string[];
  months: MonthOption[];
  /** Primary SPOCs present in employees, sorted by CRM name. */
  employees: EmployeeOption[];
};

/* ── /summary — buildSummary ──────────────────────────────────────────────── */

export type SummaryKpis = {
  revenue: number;
  /** Full-month target base (daily target × 26 per month in view). */
  target: number;
  completed: number;
  open: number;
  total: number;
  /** 0–100 */
  completionRate: number;
  /** 0–100+ (not capped) */
  targetAchieved: number;
  teamSize: number;
};

export type TeamMemberChip = {
  /** CRM name — pass to memberKey(). */
  key: string;
  label: string;
};

export type TeamPanel = {
  /** The single team's name, or 'All Teams'. */
  name: string;
  teams: string[];
  members: TeamMemberChip[];
};

/** Section 1 — Revenue Performance (date-ascending). */
export type DailyRevenueRow = {
  date: string;
  target: number;
  revenue: number;
  completed: number;
  /** 0–100+ */
  pct: number;
  due: number;
};

/** Section 7 — Productivity Date Wise, summed over the selected SPOCs (date-ascending). */
export type ProductivityRow = {
  date: string;
  working: number;
  productive: number;
  away: number;
  closed: number;
  cancelled: number;
  positive: number;
  openJobs: number;
  incoming: number;
  outgoing: number;
  missed: number;
  /** productive / 9 × 100 — can exceed 100. */
  pct: number;
  avgEng: number;
  /** 0–100 */
  missedPct: number;
};

/** Section 2 tiles — Open Job Record aging (0-2 / 3-5 / 6-9 / >9). */
export type OpenAging = {
  total: number;
  d0_2: number;
  d3_5: number;
  d6_9: number;
  d10p: number;
};

/** Section 3 left — Client Wise Open Job Report (buckets 0-2 / 3-5 / 6-8 / 9+). */
export type ClientRow = {
  client: string;
  total: number;
  completed: number;
  open: number;
  a02: number;
  a35: number;
  a68: number;
  a9: number;
  avg_age: number;
};

/** Section 3 right — Pending Reasons (total descending). */
export type PendingReasonRow = {
  dueTo: string;
  reason: string;
  a02: number;
  a35: number;
  a68: number;
  a9: number;
  total: number;
};

/** Section 4 — City-wise Open Job Report. */
export type CityRow = {
  city: string;
  open: number;
  a02: number;
  a35: number;
  a68: number;
  a9: number;
  avg_age: number;
};

/** Section 5 — Client-wise TAT & SDA (both 0–100, render with pct1). */
export type TatSdaRow = {
  client: string;
  tat: number;
  sda: number;
};

/** Section 6 left — Zonal Manager Breakdown (revenue descending). */
export type ZonalRow = {
  zonalManager: string;
  open: number;
  closed: number;
  revenue: number;
};

export type ZonalBreakdown = {
  /** 'all verticals' or the selected verticals joined by ', '. */
  scope: string;
  rows: ZonalRow[];
};

/** Section 8 — Performance. */
export type PerformanceBlock = {
  totalJobs: number;
  completed: number;
  open: number;
  revenue: number;
  target: number;
  /** min(100, targetAchieved) — the revenue bar width. */
  revenueBarPct: number;
};

/** Section 9 — Short Summary. */
export type ShortSummary = {
  completed: number;
  open: number;
  revenue: number;
  target: number;
  /** Client 9+ day open jobs. */
  aged: number;
  /** Days with revenue / target below 85%. */
  lowDays: number;
};

export type SuggestionKey = 'ageing' | 'revenue' | 'filters';
/** crit = critical, att = needs attention, pos = positive. */
export type SuggestionTone = 'crit' | 'att' | 'pos';

/** Section 10 — Suggestions / Action Points. */
export type Suggestion = {
  key: SuggestionKey;
  title: string;
  tone: SuggestionTone;
  text: string;
};

export type SummaryResponse = {
  dates: { from: string | null; to: string | null; count: number };
  kpis: SummaryKpis;
  team: TeamPanel;
  daily: DailyRevenueRow[];
  productivity: ProductivityRow[];
  openAging: OpenAging;
  clients: ClientRow[];
  pendingReasons: PendingReasonRow[];
  cityWise: CityRow[];
  tatSda: TatSdaRow[];
  zonal: ZonalBreakdown;
  /** Section 6 note — jobs of the selected SPOCs with no current TX. */
  unassigned: number;
  performance: PerformanceBlock;
  shortSummary: ShortSummary;
  suggestions: Suggestion[];
};

/* ── server-paged tables — pageOpenJobs / pageTechnicians ─────────────────── */

export type SortDir = 'asc' | 'desc';

/** aggregate.js OPEN_JOB_SORT_KEYS */
export type OpenJobSortKey =
  | 'jobId' | 'vertical' | 'state' | 'city' | 'client'
  | 'aging' | 'pendingDueTo' | 'pendingReason' | 'pmoc';

/** aggregate.js TECHNICIAN_SORT_KEYS */
export type TechnicianSortKey = 'txId' | 'txName' | 'total' | 'closed' | 'open' | 'avgAging';

/** Paging request; page is 1-based (TablePagination is 0-based — add 1). */
export type Paging<K extends string> = {
  page: number;
  /** ≤ MAX_PAGE_SIZE (200) server-side. */
  pageSize: number;
  sortBy?: K | null;
  sortDir?: SortDir | null;
};

export type PagedRows<Row, K extends string> = {
  rows: Row[];
  total: number;
  /** 1-based, as echoed by the server. */
  page: number;
  pageSize: number;
  totalPages: number;
  /** null = default order (and sortDir null with it). */
  sortBy: K | null;
  sortDir: SortDir | null;
};

/* Passed through from the snapshot. Render aging as `Number(aging) || 0`, as the dashboard does. */
export type OpenJobRow = {
  /** A string in the uploaded snapshot; numeric in the synthetic fixture. */
  jobId: string | number;
  vertical: string;
  state: string;
  city: string;
  client: string;
  aging: number | string | null;
  pendingDueTo: string;
  pendingReason: string;
  pmoc: string;
};

/** Section 6 right — Current TX Performance (default order: first seen). */
export type TechnicianRow = {
  /** May be '' — render '—'. */
  txId: string;
  /** May be '' — render '—'. */
  txName: string;
  spoc: string;
  vertical: string;
  total: number;
  closed: number;
  open: number;
  /** 0 when open is 0. */
  avgAging: number;
};

export type OpenJobsPage = PagedRows<OpenJobRow, OpenJobSortKey>;
export type TechniciansPage = PagedRows<TechnicianRow, TechnicianSortKey>;

/* ── /member — memberDetail (only month / from / to apply) ────────────────── */

/* The member's own snapshot rows, date-filtered, openJobs and missedPct filled in. */
export type MemberProductivityRow = {
  date: string;
  working: number;
  productive: number;
  away: number;
  pct: number;
  /** build_data.py's 'green' | 'orange' | 'red'; use productivityTone(productive) instead. */
  status?: string;
  closed: number;
  cancelled: number;
  positive: number;
  openJobs: number;
  incoming: number;
  outgoing: number;
  missed: number;
  missedPct: number;
  avgEng: number;
};

export type MemberRevenueRow = {
  date: string;
  target: number;
  /** Team revenue for a lead; personal A&CO achieved for a member. */
  achieved: number;
  pct: number;
  due: number;
};

export type MemberRevenueTotals = {
  target: number;
  achieved: number;
  pct: number;
  shortfall: number;
};

export type MemberView = 'team' | 'member';

export type MemberDetail = {
  /** CRM name — compare with the open member before rendering the body. */
  key: string;
  displayName: string;
  view: MemberView;
  productivity: MemberProductivityRow[];
  revenue: {
    rows: MemberRevenueRow[];
    totals: MemberRevenueTotals;
  };
};

/* ── format.ts ────────────────────────────────────────────────────────────── */

export type ProductivityTone = 'good' | 'warn' | 'bad';
