/*
 * QuickSight — Employee Performance: response types for the native Employee tab.
 *
 * Every type below mirrors, field for field, what the backend returns.
 *
 * Reads — aggregate.js over the LIVE dashboard object (live.service.js
 * buildLiveD: jobs and CRM counts from the database, the other sheets from the
 * Excel uploads):
 *
 *   buildOptions(D) + meta          → LiveOptionsResponse  GET …/live/options
 *   buildSummary(D, filters) + meta → LiveSummaryResponse  GET …/live/summary
 *   pageOpenJobs(D, filters, paging)→ OpenJobsPage         GET …/live/open-jobs
 *   pageTechnicians(D, filters, p)  → TechniciansPage      GET …/live/technicians
 *   memberDetail(D, filters, name)  → MemberDetail         GET …/live/member (null → 404)
 *
 * Upload — uploads.service.js:
 *
 *   previewUpload(buffer)           → UploadPreview        POST …/live/upload?dryRun=true
 *   commitUpload(buffer, …)         → UploadCommitResult   POST …/live/upload?dryRun=false
 *
 * Numbers are raw (unrounded); format them with ./format.ts. Where the backend
 * passes a value through untouched (open-job rows, member productivity/revenue
 * rows) the type is as loose as the data.
 *
 * `null` from buildOptions / summary.dates means "no date in range".
 */

/* ── filter state (the body's; serialised by api.ts filtersQuery) ─────────── */

/*
 * Empty list = Select All. zm: '' or 'ALL' = All. from / to: 'YYYY-MM-DD', or
 * '' for the default bound — the current IST month's 1st / today. api.ts
 * resolveWindow turns '' into the explicit dates every request carries.
 *
 * There is no `month` here any more: the Month select was folded into the Date
 * Range picker (DateRangeFilter), which resolves every choice — its Last Month
 * preset included — to a from / to pair. The server still accepts a `month`
 * query param; the tab simply never sends one.
 */
export type Filters = {
  verticals: string[];
  zm: string;
  employees: string[];
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

/*
 * Section 1 — Revenue Performance (date-ascending).
 *
 * THE THREE CLOSED-JOB COLUMNS. The current dashboard splits a day's closed
 * jobs by vertical beside the revenue, so every row carries three counts next
 * to `completed` (aggregate.js buildSummary sums them across the selected
 * SPOCs; compose.js CLOSED_SPLIT_FIELD decides which one a closed job lands
 * in):
 *
 *   compOem  vertical 'Furniture' or 'Sports'
 *   compRet  vertical 'Retail Maintenance'
 *   compRel  vertical 'Relocation'
 *
 * They do NOT partition `completed`. A closed job in any other vertical
 * (Easyfix, Amazon, Admin, IT, HR, oprations …) counts in `completed` and in
 * none of the three, so completed >= compOem + compRet + compRel and the gap
 * is real work. Nothing reading these may present them as a breakdown of a
 * total, or invent an "Other" column by subtracting them from `completed`.
 *
 * `completed` stays on the row although the table no longer prints it: it is
 * the day's closed-job count whatever the vertical, the backend sends it
 * either way, and the KPI tiles are computed from the same figure.
 */
export type DailyRevenueRow = {
  date: string;
  target: number;
  revenue: number;
  completed: number;
  /** Closed jobs in the OEM verticals — 'Furniture' and 'Sports'. */
  compOem: number;
  /** Closed jobs in 'Retail Maintenance'. */
  compRet: number;
  /** Closed jobs in 'Relocation'. */
  compRel: number;
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

/* ── live meta — live.service.js composeLive (on /live/options and /live/summary) ── */

/** A daily upload source (TimeChamp, IVR): what is stored across ALL uploads. */
export type LiveDailyCoverage = {
  from: string | null;
  to: string | null;
  days: number;
  rows: number;
};

/** A monthly upload source (emp detail, target lists): stored months, ascending. */
export type LiveMonthlyCoverage = {
  /** 'YYYY-MM' */
  months: string[];
  rows: number;
};

export type LiveUploadCoverage = {
  timechamp: LiveDailyCoverage;
  ivr: LiveDailyCoverage;
  empDetail: LiveMonthlyCoverage;
  primaryTargets: LiveMonthlyCoverage;
  secondaryTargets: LiveMonthlyCoverage;
};

export type LiveUploader = { userId: number | null; name: string | null };

export type LiveUploadBatch = {
  batchId: number;
  fileName: string;
  sheets: string[];
  dateFrom: string | null;
  dateTo: string | null;
  monthFrom: string | null;
  monthTo: string | null;
  /** ISO instant. */
  uploadedAt: string | null;
  uploadedBy: LiveUploader;
};

/** Stored upload rows nobody on that month's emp detail takes (hidden on the dashboard). */
export type LiveHiddenRows = { rows: number; names: string[] };

/**
 * sources.service.js resolvePeople reasons, in the order it tests them:
 * no-user, outside-window, roster-not-uploaded, unknown-user, not-internal,
 * not-on-roster, not-on-every-roster (the multi-month intersection — the
 * commonest of the seven, since it fires for everybody the moment the window
 * spans months). EmployeePerformanceBody reasonLabel() spells each one out and
 * degrades an unlisted one to words rather than printing the slug.
 */
export type UnattributedReason = string;

export type UnattributedUser = {
  userId: number | null;
  name: string | null;
  reasons: UnattributedReason[];
  /** 'YYYY-MM' */
  months: string[];
  closedJobs: number;
  revenue: number;
  openJobs: number;
  acoJobs: number;
  acoRevenue: number;
  crmRows: number;
};

/** Jobs / A&CO / CRM rows whose user matches no employee — reported, never dropped. */
export type LiveUnattributed = {
  label: string;
  closedJobs: number;
  revenue: number;
  openJobs: number;
  acoJobs: number;
  acoRevenue: number;
  crm: { rows: number; booked: number; scheduled: number; audit: number; closed: number; cancelled: number };
  users: UnattributedUser[];
};

export type LiveMonth = {
  /** 'YYYY-MM' */
  month: string;
  /** An emp detail sheet exists for this month. false = NO name is shown for it at all. */
  rosterUploaded: boolean;
  /** Names visible for this month — 0 when no emp detail was uploaded. */
  employees: number;
  /**
   * Names this month's emp detail actually LISTS (0 when none was uploaded), so
   * rosterSize − employees is what the window's own rules hide. Optional for
   * the same reason as `visibility` below — a backend build from before these
   * rules sends neither — and ./visibility.ts reads it as 0 when absent.
   */
  rosterSize?: number;
};

/**
 * Who the selected window can name at all, i.e. the owner's rules as the
 * backend applied them:
 *
 *   - a person appears for a month ONLY if that month's uploaded emp detail
 *     lists them (a month without one shows no names, not invented ones);
 *   - a window over several months lists only the people on EVERY one of those
 *     months' sheets — mode 'intersection';
 *   - everyone else's jobs, revenue and CRM rows are never dropped: they are
 *     reported under meta.unattributed, and the Total Revenue, Jobs Completed,
 *     Jobs Open and Total Jobs KPIs count that bucket too (Target Achieved and
 *     Team Members cannot — the uploaded target and team behind them belong to
 *     the listed people; ./visibility.ts COUNTING_TILES says so on screen).
 *
 * Optional on purpose: a backend build from before these rules sends meta
 * without it, and ./visibility.ts derives the same answer from meta.months.
 */
export type LiveVisibility = {
  /** 'intersection' when the window spans more than one month. */
  mode: 'single' | 'intersection';
  /** People dropped because they were not on EVERY month's emp detail. */
  hidden: number;
  /** The 'YYYY-MM' months of the window with no emp detail uploaded. */
  missingMonths: string[];
};

export type LiveMeta = {
  /** The EFFECTIVE window the numbers cover ('YYYY-MM-DD'). */
  from: string;
  to: string;
  /** ISO instants. jobsAsOf = when jobs and CRM counts were read. */
  generatedAt: string;
  jobsAsOf: string;
  /** Every calendar month of the window, ascending. */
  months: LiveMonth[];
  /** Read it through ./visibility.ts rosterGap(), never directly: it can be absent. */
  visibility?: LiveVisibility;
  uploads: {
    /** 'missing' until the backend migration has run. */
    storage: 'ready' | 'missing';
    lastBatch: LiveUploadBatch | null;
    uploadedBy: LiveUploader | null;
    uploadedAt: string | null;
    /** null when storage is missing. */
    coverage: LiveUploadCoverage | null;
    rosterMonthsInWindow: string[];
    hidden: {
      timechamp: LiveHiddenRows;
      ivr: LiveHiddenRows;
      primaryTargets: LiveHiddenRows;
      secondaryTargets: LiveHiddenRows;
    };
  };
  totals: { closedJobs: number; revenue: number; openJobs: number; crmRows: number };
  attributed: { closedJobs: number; revenue: number; openJobs: number };
  reconciled: boolean;
  unattributed: LiveUnattributed;
};

export type LiveOptionsResponse = FilterOptions & { meta: LiveMeta };
export type LiveSummaryResponse = SummaryResponse & { meta: LiveMeta };

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

/* ── /live/upload — uploads.service.js previewUpload / commitUpload ───────── */

/** row / column are null for a sheet-level issue. At most 1000 listed per sheet per kind. */
export type UploadIssue = {
  row: number | null;
  column: string | null;
  message: string;
};

export type UploadSheetReport = {
  /** The MIS sheet name, e.g. 'emp detail'. */
  name: string;
  present: boolean;
  /** Non-blank data rows read. */
  rows: number;
  /** Exact counts; the lists below may be capped. */
  errorCount: number;
  warningCount: number;
  errors: UploadIssue[];
  warnings: UploadIssue[];
};

/** A stored TimeChamp / IVR date this file replaces. */
export type UploadOverwrite = {
  source: 'timechamp' | 'ivr';
  date: string;
  storedRows: number;
  fileRows: number;
};

export type UploadMonthSummary = {
  /** 'YYYY-MM' */
  month: string;
  empDetail: { stored: number; inFile: number; added: number; updated: number; after: number };
  primaryTargets: { inFile: number; updated: number; replaced: number };
  secondaryTargets: { inFile: number; updated: number; replaced: number };
  /** Rows (stored + file) nobody on that month's emp detail takes once saved. */
  hiddenAfterUpload: { timechamp: number; ivr: number; primaryTargets: number; secondaryTargets: number };
};

export type UploadPreview = {
  fileSha256: string;
  /** true = at least one error: the save is refused. */
  blocking: boolean;
  /** File-level (not tied to a sheet). */
  errors: string[];
  warnings: string[];
  sheets: UploadSheetReport[];
  overwrites: UploadOverwrite[];
  months: UploadMonthSummary[];
};

export type UploadCommitResult = {
  batchId: number;
  saved: { empDetail: number; primaryTargets: number; secondaryTargets: number; timechamp: number; ivr: number };
  sheets: string[];
  preview: UploadPreview;
};

/* ── format.ts ────────────────────────────────────────────────────────────── */

export type ProductivityTone = 'good' | 'warn' | 'bad';
