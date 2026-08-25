'use client';

/*
 * QuickSight — Call Tracking report.
 *
 * Who called, for which job, at which step of the job, to whom, and for how
 * long. Sourced from tbl_job_caller_info via
 * POST /admin/quicksight/call-tracking/summary.
 * Gated by ef-QuickSight (family) + isQuickSightCallTrackingView (per-report).
 *
 * TWO GRAINS behind gliding tabs, both riding on the ONE summary response so
 * switching tabs is instant (no refetch, no spinner):
 *
 *   By Job   one row per JOB — the calls made for it, who made them, to whom,
 *            and which lifecycle step each was made from.
 *   By User  a caller's call log, at one of TWO aggregation grains (sub-tabs):
 *              Date Wise  one row per (DAY × USER) — volume, how many distinct
 *                         jobs it touched, and the job status most of those
 *                         calls were made at.
 *              Combined   one row per USER for the WHOLE window, plus the
 *                         per-day efficiency averages.
 *            The sub-tabs appear ONLY when the window spans more than one day —
 *            on a single day the two grains are the same table, and a toggle
 *            between two identical views is just noise.
 *
 * ⚠ "PER DAY" MEANS PER **ACTIVE** DAY on the Combined grain — divided by the
 * days this user actually placed a call on, never by the days in the selected
 * range. Dividing by range days would rank people by attendance (weekends,
 * leave, a mid-month joiner) rather than by how hard they worked on the days
 * they worked. `Active Days` is therefore a COLUMN, sitting before the averages
 * it is the denominator of — 5 calls/day over 2 active days and over 20 are very
 * different claims, and the operator must be able to see which one they are
 * reading.
 *
 * ⚠ Job Status is TWO different facts in this report and they must not be
 * conflated:
 *   - the By Job row shows `currentJobStatus` — where the job is TODAY;
 *   - every per-call chip (drill-down) shows `jobStatusAtCall` — the SNAPSHOT
 *     taken when the call was placed, which is the whole point of "at which
 *     step". A job called at Unconfirmed and later Completed must still show
 *     Unconfirmed on that call.
 * Both go through statusLabel(code, { assigned }) with the matching `assigned`
 * flag for that same instant — status 0 is mislabelled without it.
 *
 * Filters: the shared client/vertical/service-category bar + the call-date
 * window (defaults to TODAY, IST) + "Called By" (the tbl_user who MADE the
 * call) + Provider + Party.
 *
 * ⚠ CONFERENCE CALLS COUNT AS ONE CALL, EVERYWHERE IN THIS REPORT.
 *
 * A conference is one call that gained people, and the summary reads
 * tbl_job_caller_info — which still holds exactly one row per call — so every
 * aggregate here (totals, By Job, By User, By Day, connect rate, talk time) is
 * already correct by construction. Nothing needed adding to make the counts
 * right, and nothing may be added that would inflate them: joining the per-leg
 * call log into the summary would both multiply the numbers and drop every
 * Kaleyra call, which has no log row at all.
 *
 * What the call aggregates cannot show is COMPOSITION. `Called To` is derived
 * from the number stamped on the call at click time, so it attributes a
 * conference wholly to whoever was dialled FIRST — a technician brought in
 * mid-call contributes nothing to that breakdown. That is why the extra people
 * are surfaced in the per-call DRILL-DOWN, which is the one place in this report
 * that shows individual calls rather than counts of them, and why the Called To
 * header says what it is counting.
 *
 * TWO TILES COUNT SOMETHING OTHER THAN CALLS, and they live in their own row for
 * exactly that reason (see "Reach And Conference Cost" below):
 *
 *   Parties Reached            the PEOPLE we got on the line. A conference
 *                              contributes everyone who joined; a call with no
 *                              legs contributes one when it connected. It is
 *                              therefore always >= Connected, and it is where an
 *                              operator goes when the Called To breakdown looks
 *                              like it is missing the people it is missing.
 *   Conference Billed Minutes  what the provider bills for those conferences —
 *                              and, beside it, how many of them have actually
 *                              reported. The billed seconds arrive on an
 *                              end-of-conference webhook, so the figure is
 *                              partial until they all land, and a cost number
 *                              without its coverage is worse than none at all.
 *
 * Neither is derived by joining the leg table into the summary. They arrive as
 * their own fields on `totals`, from separate aggregates over the same scope, so
 * every count above them is byte-for-byte the number it was before.
 */

import { useCallback, useMemo, useState } from 'react';
import { PhoneCall, Play, ChevronUp, ChevronDown, ChevronsUpDown, UsersRound, Receipt } from 'lucide-react';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { CallRecordingAudio } from '@/components/ui/call-recording-audio';
import { IconButton } from '@/components/ui/icon-button';

import { CallLegList, ConferenceBadge } from '@/components/calls/CallLegList';
import { groupCallRows, isConferenceCall, type CallLeg } from '@/lib/call-legs';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { usePostFetch } from '@/lib/hooks';
import { useLookup } from '@/lib/use-lookup';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QuickSightFilterBar } from '@/components/quicksight/QuickSightFilterBar';
import { QsKpiTile, QS_COLORS } from '@/components/quicksight/charts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { GlidingTabs } from '@/components/ui/gliding-tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { StatusChip } from '@/components/ui/StatusChip';
import { statusLabel, statusTone } from '@/lib/utils';
import { parseIstDateTime } from '@/lib/format';
import { JobRefLink } from '@/components/job/JobRefLink';
import { JobModalHost } from '@/components/job/JobModalHost';

import { CallTrackingCharts } from './CallTrackingCharts';
import { fmtSecs, fmtTalkTime } from './duration';

const ACTION_KEY = 'isQuickSightCallTrackingView';
const API_BASE = '/admin/quicksight/call-tracking';

/* ── Wire types (the /summary contract) ──────────────────────────────── */

/** WHO called — one entry per user who placed calls for this job. */
type CallerBreak = { userId: number | null; userName: string; calls: number };
/** TO WHOM — Customer / Alternate / Client SPOC / Technician / Other. */
type PartyBreak = { role: string; calls: number };
/** AT WHICH STEP — job status SNAPSHOT at the moment of the call. */
type StepBreak = { status: number; label: string; calls: number };

type JobRow = {
  jobId: number;
  clientName: string | null;
  /** Where the job is TODAY — NOT where it was when the calls were made. */
  currentJobStatus: number | null;
  /** Whether the job has a technician TODAY — drives the status-0 sub-label. */
  assigned: boolean;
  calls: number; connected: number; connectRate: number;
  totalDurationSecs: number; avgDurationSecs: number | null; maxDurationSecs: number | null;
  callers: CallerBreak[];
  parties: PartyBreak[];
  steps: StepBreak[];
  firstCallAt: string | null; lastCallAt: string | null;
};

type UserRow = {
  /** 'YYYY-MM-DD' — the grain is one row per (day, user), not per user. */
  day: string;
  userId: number | null; userName: string;
  calls: number; uniqueJobs: number;
  connected: number; connectRate: number;
  totalDurationSecs: number; avgDurationSecs: number | null;
  /*
   * "Majorly at which job status" — the modal job status across this row's
   * calls. `topStatusLabel` is computed SERVER-side and is authoritative: the
   * byUser grain carries no `assigned` flag, so statusLabel() here could not
   * resolve the status-0 sub-label (Pending for Scheduling vs Pending App Ack).
   * The label is rendered as-is; only the chip TONE is derived locally.
   */
  topStatus: number | null; topStatusLabel: string; topStatusCalls: number;
  steps: StepBreak[];
  parties: PartyBreak[];
  firstCallAt: string | null; lastCallAt: string | null;
};

/*
 * The COMBINED grain — one row per user for the WHOLE window.
 *
 * `activeDays` is the number of distinct days this user placed at least one call
 * on, counted SERVER-side with COUNT(DISTINCT day). It is the denominator of
 * both per-day averages below, and it is deliberately NOT derivable here: byUser
 * is row-capped, so counting a user's rows in that array would under-count the
 * days and inflate the averages the moment the cap bites.
 *
 * Both averages are `null` — never 0 — when there is nothing to divide by, the
 * same convention avgDurationSecs already uses. They render as an em-dash.
 */
type CombinedUserRow = {
  userId: number | null; userName: string;
  /** Days with at least one call. The denominator of the two per-day averages. */
  activeDays: number;
  calls: number; uniqueJobs: number;
  connected: number; connectRate: number;
  totalDurationSecs: number;
  /** Avg over CONNECTED calls only — a ring-out must not drag talk time down. */
  avgDurationSecs: number | null;
  /** calls / activeDays, 1dp. */
  avgCallsPerDay: number | null;
  /** totalDurationSecs / activeDays, whole seconds. */
  avgDurationPerDaySecs: number | null;
  topStatus: number | null; topStatusLabel: string; topStatusCalls: number;
  steps: StepBreak[];
  parties: PartyBreak[];
  firstCallAt: string | null; lastCallAt: string | null;
};

type DayRow = { day: string; calls: number; connected: number; uniqueJobs: number };

type Totals = {
  calls: number; uniqueJobs: number; uniqueCallers: number;
  connected: number; connectRate: number;
  totalDurationSecs: number; avgDurationSecs: number | null;

  /*
   * ── The conference-aware four ────────────────────────────────────────
   *
   * Computed by SEPARATE aggregates on the backend, keyed off the same scope
   * as every field above rather than by joining the per-leg call log into it —
   * that join would multiply the counts above and drop Kaleyra entirely. So
   * nothing above moved when these arrived.
   *
   * All four are plain numbers and are NEVER null. That is deliberate and it
   * differs from avgDurationSecs on purpose: null in this report means "no
   * basis to compute" and renders as an em-dash, whereas 0 here honestly means
   * "none of this happened in this window". A backend that predates the
   * conference tables fails soft to 0 as well, which reads the same way —
   * absent, not broken.
   */

  /**
   * PEOPLE we got on the line, not calls. A conference contributes every leg
   * that reached the room (the ops operator excluded); a call with no legs
   * (Kaleyra, or a Plivo call placed before conferencing) contributes 1 when it
   * connected, 0 when it didn't. That fallback is what makes this ALWAYS >=
   * `connected` — a 1:1 call has exactly one non-operator leg and so ties.
   */
  partiesReached: number;
  /**
   * Scoped calls that were MULTI-party — more than one non-operator leg reached
   * the room. Every ops call is technically an MPC, so a 1:1 call is explicitly
   * NOT counted as a conference here — that would report the plumbing rather
   * than what ops did.
   *
   * ⚠ This is NOT the denominator of the billed-minutes coverage. See
   * `conferenceRooms`.
   */
  conferenceCalls: number;
  /** Σ billed leg seconds over every scoped ROOM. Partial until every end-of-call webhook has landed — never read without conferenceBilledCalls. */
  conferenceBilledSecs: number;
  /** How many of `conferenceRooms` actually contributed billed seconds. The coverage numerator that stops conferenceBilledSecs reading as a complete cost. */
  conferenceBilledCalls: number;
  /**
   * Every room in scope, billed or not — and a room is minted for EVERY Plivo
   * ops call, since a 1:1 call is a one-participant MPC. This, not
   * `conferenceCalls`, is the population conferenceBilledSecs is summed over,
   * and therefore the only honest denominator for its coverage.
   */
  conferenceRooms: number;
};

type CallTrackingData = {
  totals: Totals;
  byJob: JobRow[];
  byUser: UserRow[];
  byUserCombined: CombinedUserRow[];
  byDay: DayRow[];
};

/* ── Filters ─────────────────────────────────────────────────────────── */

type Provider = '' | 'plivo' | 'kaleyra';
type PartyRole = '' | 'Customer' | 'Alternate' | 'Client SPOC' | 'Technician' | 'Other';

type FilterBody = {
  clientId: number[]; verticalId: number[]; serviceCategoryId: number[];
  /** tbl_user ids — who MADE the call. */
  callerId: number[];
  dateFrom?: string; dateTo?: string;
  provider?: Exclude<Provider, ''>;
  partyRole?: Exclude<PartyRole, ''>;
};

const PARTY_ROLES: Array<Exclude<PartyRole, ''>> = ['Customer', 'Alternate', 'Client SPOC', 'Technician', 'Other'];

const emptyFilter: FilterBody = { clientId: [], verticalId: [], serviceCategoryId: [], callerId: [] };

function toNums(v: Array<string | number>): number[] {
  return v.map((x) => (typeof x === 'number' ? x : Number(x))).filter((n) => Number.isFinite(n));
}

/*
 * Timestamp as TWO non-breaking lines: date on the first, time on the second.
 * A single string in a narrow column wraps wherever it likes ("29 Jul / 2026, /
 * 02:58 / pm" — four lines and unreadable). Splitting it makes the break point
 * OURS, and `whitespace-nowrap` on each half guarantees neither is ever broken
 * mid-value; the table scrolls horizontally instead. Same idiom as the Offer
 * Acceptance report.
 */
function DateTimeCell({ value, seconds }: { value: string | null; seconds?: boolean }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  /*
   * parseIstDateTime, not `new Date(...replace(' ', 'T'))`.
   *
   * The replace only swaps the separator; the string stays ZONE-LESS, so it was
   * parsed as browser-local and then rendered with timeZone:'Asia/Kolkata'
   * below. Those two errors COMPOUND rather than cancel: under
   * TZ=America/New_York a 16:56 IST call rendered as 26 Aug 02:26 — wrong time
   * and wrong day. In IST the output is unchanged, which is why nobody saw it.
   */
  const d = parseIstDateTime(String(value));
  if (Number.isNaN(d.getTime())) return <span className="whitespace-nowrap">{String(value)}</span>;
  const opts = { timeZone: 'Asia/Kolkata' } as const;
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', ...opts });
  const time = d.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), ...opts,
  });
  return (
    <span className="inline-block">
      <span className="block whitespace-nowrap">{date}</span>
      <span className="block whitespace-nowrap text-muted-foreground">{time}</span>
    </span>
  );
}

/* 'YYYY-MM-DD' → "03 Jul 2026" on one line (the By User row's Date column). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-');
  const mi = Number(m) - 1;
  return MONTHS[mi] ? `${d} ${MONTHS[mi]} ${y}` : iso;
}

/* A plain count, grouped Indian-style — the same rendering the KPI tiles in
   CallTrackingCharts already use, so the two tile rows read as one set. */
const fmtCount = (n: number) => n.toLocaleString('en-IN');

/*
 * A `label (n)` breakdown rendered ONE ENTRY PER LINE. A comma-joined string
 * wraps mid-name ("Priyanka / Agarwal (4), / Harkirpa / Kaur (1)"), so each
 * entry gets its own nowrap block instead.
 */
function BreakdownCell({ items }: { items: Array<{ key: string; text: string }> }) {
  if (items.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <>
      {items.map((i) => (
        <span key={i.key} className="block whitespace-nowrap">{i.text}</span>
      ))}
    </>
  );
}

/* Which grain the table below the charts is showing. Purely client-side. */
type Grain = 'job' | 'user';
/* Which aggregation the By User tab is showing. Also purely client-side —
   BOTH sub-views ride on the one summary response, so switching never refetches. */
type UserGrain = 'date' | 'combined';

/*
 * ── Combined-grain sorting ────────────────────────────────────────────────
 *
 * CLIENT-side on purpose, unlike the job LIST pages which sort server-side.
 * The whole combined grain arrives in the one summary response and is rendered
 * unpaginated, so sorting in memory reorders EVERY row the operator can see —
 * the objection to client-side sorting (it silently sorts only the current
 * page) does not apply here. It also keeps sorting instant and refetch-free,
 * which is the point of both grains riding one response.
 *
 * The grain exists to RANK callers, so every numeric column is sortable and the
 * default is the most useful ranking rather than insertion order.
 */
type CombinedSortKey =
  | 'userName' | 'activeDays' | 'calls' | 'uniqueJobs' | 'connected' | 'connectRate'
  | 'avgCallsPerDay' | 'totalDurationSecs' | 'avgDurationSecs' | 'avgDurationPerDaySecs';

/*
 * Nulls ALWAYS sort last, in both directions.
 *
 * A null here means "no basis to compute" (nothing connected, no active days) —
 * NOT "zero". Letting it collate as 0 would park those users at the top of an
 * ascending "worst first" sort and read as though they were the poorest
 * performers, when the honest answer is that they have no score at all.
 */
function cmpCombined(a: CombinedUserRow, b: CombinedUserRow, key: CombinedSortKey, dir: 'asc' | 'desc'): number {
  if (key === 'userName') {
    const r = (a.userName || '').localeCompare(b.userName || '', undefined, { sensitivity: 'base' });
    return dir === 'asc' ? r : -r;
  }
  const av = a[key] as number | null;
  const bv = b[key] as number | null;
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return dir === 'asc' ? av - bv : bv - av;
}

/* A sortable column header — click to sort, click again to flip direction. */
function SortTh({
  label, col, sort, onSort, className, title,
}: {
  label: string;
  col: CombinedSortKey;
  sort: { key: CombinedSortKey; dir: 'asc' | 'desc' };
  onSort: (k: CombinedSortKey) => void;
  className?: string;
  title?: string;
}) {
  const active = sort.key === col;
  const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <th className={className} title={title}>
      <button
        type="button"
        onClick={() => onSort(col)}
        aria-label={`Sort By ${label}`}
        className={`inline-flex items-center gap-1 hover:text-primary ${active ? 'text-primary' : ''}`}
      >
        {label}
        <Icon size={12} className={active ? 'opacity-90' : 'opacity-40'} />
      </button>
    </th>
  );
}

/*
 * The denominator caveat, spelled out wherever a per-day average is shown. The
 * per-cell titles below append this row's OWN active-day count, so the operator
 * never has to infer what a given average was divided by.
 */
const PER_DAY_HELP = 'Averaged over the days on which this user placed at least one call — NOT over the number of days in the selected range.';

/*
 * ── The two conference tiles' help text ───────────────────────────────────
 *
 * Both are long on purpose. These are the only two numbers on the page that do
 * NOT count calls, and the whole risk with them is that they are read as though
 * they did — Parties Reached mistaken for a second call count, Conference Billed
 * Minutes mistaken for a settled invoice.
 */
const PARTIES_REACHED_HELP =
  'Every person we actually got on the line, counted individually. A conference contributes everyone who joined it, while Total Calls counts that same conference once — so this is always at least Connected, and higher whenever a call gained people. A call with no conference legs counts as one party when it connected.';
const CONF_BILLED_HELP =
  'Billed talk time across every Plivo call in this window, summed per leg. It covers all of them, not only multi-party ones: each ops call runs as a one-participant conference room, which is what lets a call gain a third person at all — and those seconds are billed too. Kaleyra calls are not included. A room only reports its billed seconds when the provider’s end-of-call webhook lands, so any still waiting contribute nothing — the line under the figure says how many have reported. Read a partial figure as a floor, never as the full cost.';
const CONF_CALLS_HELP =
  'Calls that actually gained people — more than one party reached the room. Every ops call runs as a conference room technically, so this deliberately counts only the ones where somebody was added, which is what "we conferenced someone in" means. Not the denominator of the billed-minutes coverage beside it: that is read over every room.';

/*
 * Tile accents. Both are hues no other tile or chart series on this page uses,
 * so neither can be mistaken for the metric it sits next to. Amber for billed
 * minutes doubles as a nudge: it is the one tile that can be incomplete.
 */
const C_PARTIES = QS_COLORS[8];      // pink
const C_CONF_CALLS = QS_COLORS[5];
const C_CONF_BILLED = QS_COLORS[2];  // amber

export default function CallTrackingPage() {
  const { me } = useMe();
  const canView = actionFlags(me, [ACTION_KEY])[ACTION_KEY];
  const lookup = useLookup();
  /*
   * "Called By" picker superset = internal admin users (the people who place
   * click-to-call calls from the CRM), reusing the existing auth-gated
   * /shared/lookup/users list — no new BE lookup introduced.
   */
  const callerOpts = lookup.toOpts.adminUsers;

  /*
   * Default the call-date filter to TODAY (IST). en-CA in Asia/Kolkata yields
   * 'YYYY-MM-DD', matching the filter's date format + the BE's IST day compare.
   */
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

  // Draft (user edits) vs applied (live query).
  const [clientId, setClientId] = useState<number[]>([]);
  const [verticalId, setVerticalId] = useState<number[]>([]);
  const [serviceCategoryId, setServiceCategoryId] = useState<number[]>([]);
  const [callerId, setCallerId] = useState<number[]>([]);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [provider, setProvider] = useState<Provider>('');
  const [partyRole, setPartyRole] = useState<PartyRole>('');
  // Seed the live query with today's range so the report loads scoped to TODAY
  // by default (not the entire call history).
  const [applied, setApplied] = useState<FilterBody>({ ...emptyFilter, dateFrom: today, dateTo: today });

  const buildDraft = useCallback((): FilterBody => {
    const body: FilterBody = { clientId, verticalId, serviceCategoryId, callerId };
    if (dateFrom) body.dateFrom = dateFrom;
    if (dateTo) body.dateTo = dateTo;
    if (provider) body.provider = provider;
    if (partyRole) body.partyRole = partyRole;
    return body;
  }, [clientId, verticalId, serviceCategoryId, callerId, dateFrom, dateTo, provider, partyRole]);

  const summary = usePostFetch<CallTrackingData>(
    canView ? `${API_BASE}/summary` : null,
    applied,
    { enabled: canView },
  );

  const data = summary.data;
  const byJob = data?.byJob ?? [];
  const byUser = data?.byUser ?? [];
  const byUserCombinedRaw = data?.byUserCombined ?? [];

  /*
   * Default sort: Avg Calls / Day descending — the metric this grain exists to
   * expose. The server returns calls DESC, which just re-ranks by raw volume and
   * would hide exactly the finding the per-day averages were added for (a caller
   * with fewer total calls over far fewer active days can be the more intense).
   */
  const [combinedSort, setCombinedSort] = useState<{ key: CombinedSortKey; dir: 'asc' | 'desc' }>(
    { key: 'avgCallsPerDay', dir: 'desc' },
  );
  const onCombinedSort = useCallback((key: CombinedSortKey) => {
    // Same column → flip direction; new column → start descending, since every
    // sortable column here is a "most first" ranking question.
    setCombinedSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  }, []);
  const byUserCombined = useMemo(
    // Copy before sorting — Array.prototype.sort mutates, and this array is the
    // fetch cache's own object.
    () => [...byUserCombinedRaw].sort((a, b) => cmpCombined(a, b, combinedSort.key, combinedSort.dir)),
    [byUserCombinedRaw, combinedSort],
  );
  /*
   * ── User search (2026-08-19) ──────────────────────────────────────────
   *
   * A window can hold 1,300+ (day × user) rows, and following ONE caller across
   * dates meant browser-find plus scrolling: the operator's own rows are spread
   * down the table, one per day, ranked by volume rather than grouped by person.
   *
   * Filtered in the BROWSER, not the server: every row is already here. The
   * server caps this grain at ROW_CAP = 5,000 and a typical window returns far
   * fewer, so there is nothing to fetch and the filter is instant as you type.
   * (If a window ever DID hit that cap the search would only see the rows that
   * arrived — the same limitation the table already has, not one this adds.)
   *
   * Matches on NAME or ID because the table shows both and the operator may
   * have either: an id typed in full or in part matches by prefix, anything
   * else is a case-insensitive substring of the name. `User #0` — the
   * no-caller-recorded bucket — is reachable by typing 0.
   */
  const [userQuery, setUserQuery] = useState('');
  const userMatch = useCallback((row: { userId: number | null; userName: string }) => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return true;
    if (String(row.userId ?? '').startsWith(q)) return true;
    return (row.userName || '').toLowerCase().includes(q);
  }, [userQuery]);

  // Both grains filter through the SAME predicate, so switching sub-tab keeps
  // the operator on the person they were following.
  const byUserShown = useMemo(() => byUser.filter(userMatch), [byUser, userMatch]);
  const byUserCombinedShown = useMemo(() => byUserCombined.filter(userMatch), [byUserCombined, userMatch]);

  const byDay = data?.byDay ?? [];
  const totals = data?.totals;

  const [tab, setTab] = useState<Grain>('job');
  const [userGrain, setUserGrain] = useState<UserGrain>('date');
  /*
   * Does the window span more than one day? Read off byDay — the server's own
   * gap-filled day axis for the window it actually queried — rather than
   * re-deriving it from the filter state. The filter dates are independently
   * optional (either can be blank, and the BE then defaults it), so comparing
   * them here would re-implement the backend's windowOf() and could disagree
   * with the data on screen. byDay always carries at least one entry.
   */
  const multiDay = byDay.length > 1;
  // On a single-day window the two grains are identical, so no toggle is shown
  // and the Date Wise table renders regardless of the remembered sub-tab.
  const effectiveUserGrain: UserGrain = multiDay ? userGrain : 'date';
  /*
   * "01 Apr 2026 – 30 Apr 2026" for the Combined drill-down's title, so the
   * dialog says which span its rows cover. Taken from byDay (the server's own
   * axis) rather than the filter inputs — the trend is clamped to a maximum
   * span, and the title must describe the data actually on screen.
   */
  const windowLabel = byDay.length > 0
    ? `${fmtDay(byDay[0].day)} – ${fmtDay(byDay[byDay.length - 1].day)}`
    : '';
  // Count drill-down: which CELL was clicked (a job, or a user's day).
  const [drill, setDrill] = useState<Drill | null>(null);

  const accessDenied = canView === false || summary.status === 403;
  const isEmpty = !summary.loading && !summary.error && byJob.length === 0 && byUser.length === 0;

  /*
   * Table footers are summed from the ROWS ON SCREEN, not taken from `totals`.
   * They differ on purpose:
   *   - By Job excludes calls with no job attached, so totals.calls ≥ Σ rows;
   *   - By User is a (day × user) grain, so Σ uniqueJobs double-counts a job
   *     that two users called on two days — the distinct figure can only come
   *     from totals.uniqueJobs.
   * Percentages are recomputed from the summed counts, never averaged.
   */
  const jobFoot = useMemo(() => {
    const calls = byJob.reduce((a, r) => a + r.calls, 0);
    const connected = byJob.reduce((a, r) => a + r.connected, 0);
    const secs = byJob.reduce((a, r) => a + r.totalDurationSecs, 0);
    return { calls, connected, secs, rate: calls > 0 ? Math.round((connected / calls) * 100) : 0 };
  }, [byJob]);

  const userFoot = useMemo(() => {
    const calls = byUser.reduce((a, r) => a + r.calls, 0);
    const connected = byUser.reduce((a, r) => a + r.connected, 0);
    const secs = byUser.reduce((a, r) => a + r.totalDurationSecs, 0);
    return { calls, connected, secs, rate: calls > 0 ? Math.round((connected / calls) * 100) : 0 };
  }, [byUser]);

  /*
   * Combined-grain footer. The two per-day figures are Σcalls / ΣactiveDays and
   * Σtalk / ΣactiveDays — a WEIGHTED average across every user-day worked, never
   * the mean of the column above it. Averaging the per-user averages would give
   * a caller who worked 1 day the same weight as one who worked 22.
   */
  const combinedFoot = useMemo(() => {
    // Reads the UNSORTED source: a total is order-independent, so depending on
    // the sorted array would only recompute every one of these on each sort
    // click without ever changing a number.
    const calls = byUserCombinedRaw.reduce((a, r) => a + r.calls, 0);
    const connected = byUserCombinedRaw.reduce((a, r) => a + r.connected, 0);
    const secs = byUserCombinedRaw.reduce((a, r) => a + r.totalDurationSecs, 0);
    const days = byUserCombinedRaw.reduce((a, r) => a + r.activeDays, 0);
    return {
      calls, connected, secs, days,
      rate: calls > 0 ? Math.round((connected / calls) * 100) : 0,
      // null, not 0 — nothing to divide by is not "zero calls a day".
      callsPerDay: days > 0 ? Math.round((calls / days) * 10) / 10 : null,
      secsPerDay: days > 0 ? secs / days : null,
    };
  }, [byUserCombinedRaw]);

  /*
   * Coverage for the billed-minutes tile: how many of this window's conferences
   * have actually reported billed seconds.
   *
   * This is rendered ON the tile, not tucked into its tooltip, because a bare
   * total would read as the complete cost of the window while the webhooks for
   * the newest rooms are still outstanding. Zero rooms is a THIRD state and is
   * not the same as an incomplete one — "nothing in this range" and "this range
   * cost nothing" are different facts, so the value falls back to an em-dash
   * rather than to 0:00.
   *
   * ⚠ THE DENOMINATOR IS `conferenceRooms`, NOT `conferenceCalls`.
   *
   * A room is minted for EVERY Plivo ops call — a 1:1 call is a one-participant
   * MPC, which is the only reason a call can gain a third person at all. So the
   * billed SUM is taken over ALL rooms (their seconds are real money), while
   * `conferenceCalls` counts only the calls that actually GAINED people, which
   * is a strictly smaller and differently-scoped number. Reading the coverage
   * against it prints impossible ratios like "3 of 2". Coverage must always be
   * read over the same population its sum was taken over.
   */
  const confRooms = totals?.conferenceRooms ?? 0;
  const confBilledCalls = totals?.conferenceBilledCalls ?? 0;
  const confPartial = confRooms > 0 && confBilledCalls < confRooms;
  const confCoverage = confRooms === 0
    ? 'No Calls In This Range'
    : confPartial
      ? `Partial · ${fmtCount(confBilledCalls)} Of ${fmtCount(confRooms)} Rooms Reported`
      : `All ${fmtCount(confRooms)} Rooms Reported`;

  const [downloading, setDownloading] = useState(false);
  const onDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const base = process.env.NEXT_PUBLIC_API_URL || '/api';
      const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
      const resp = await fetch(`${base}${API_BASE}/summary`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ ...applied, format: 'xlsx' }),
        cache: 'no-store',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'call-tracking.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch {
      /* busy state simply clears; keep the page chrome quiet */
    } finally {
      setDownloading(false);
    }
  }, [applied]);

  function reset() {
    setClientId([]); setVerticalId([]); setServiceCategoryId([]); setCallerId([]);
    // Reset returns the call-date filter to its default (today), not blank.
    setDateFrom(today); setDateTo(today); setProvider(''); setPartyRole('');
    setApplied({ ...emptyFilter, dateFrom: today, dateTo: today });
  }

  return (
    <ReportPageScaffold
      title="Call Tracking"
      subtitle="Every call placed from the CRM — who called, for which job, at which step, to whom, and for how long."
      icon={PhoneCall}
      loading={summary.loading}
      error={summary.status === 403 ? null : summary.error}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={onDownload}
      downloading={downloading}
      filters={
        <div className="space-y-3">
          <QuickSightFilterBar
            show={{ clients: true, verticals: true, serviceCategories: true }}
            clients={clientId}
            onClientsChange={(v) => setClientId(toNums(v))}
            verticals={verticalId}
            onVerticalsChange={(v) => setVerticalId(toNums(v))}
            serviceCategories={serviceCategoryId}
            onServiceCategoriesChange={(v) => setServiceCategoryId(toNums(v))}
            disabled={summary.loading}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Called By</label>
              <SearchMultiSelect
                value={callerId}
                onChange={(v) => setCallerId(toNums(v))}
                options={callerOpts}
                placeholder="All Users"
                selectedLabel="users"
                disabled={summary.loading}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Called From</label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} disabled={summary.loading} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Called To</label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} disabled={summary.loading} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as Provider)}
                disabled={summary.loading}
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">All Providers</option>
                <option value="plivo">Plivo</option>
                <option value="kaleyra">Kaleyra</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Party (To Whom)</label>
              <select
                value={partyRole}
                onChange={(e) => setPartyRole(e.target.value as PartyRole)}
                disabled={summary.loading}
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">All Parties</option>
                {PARTY_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setApplied(buildDraft())} disabled={summary.loading}>Filter</Button>
            <Button variant="outline" onClick={reset} disabled={summary.loading}>Reset</Button>
          </div>
        </div>
      }
    >
      {/* KPI tiles + charts (Graphical View). */}
      <CallTrackingCharts totals={totals} byDay={byDay} byUser={byUser} />

      {/*
        * ── Reach And Conference Cost ──────────────────────────────────────
        *
        * A SECOND tile row rather than two more tiles in the Graphical View row
        * above, because the grain is different: every tile up there counts
        * CALLS, and both tiles here count something that is not a call — the
        * people who were on the line, and the seconds the provider bills for
        * putting them there. Sitting them in the same row as Total Calls is
        * precisely how Parties Reached gets read as a second call count.
        *
        * Neither number changes anything above it. They arrive as their own
        * fields on `totals`, computed from separate aggregates over the same
        * scope, so the call counts, connect rate and talk time on this page are
        * the same numbers they were before conferencing existed.
        */}
      {totals && (
        <section className="mt-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink-900">Reach And Call Cost</h2>
            <span className="text-xs text-muted-foreground">Counts people and billed seconds — everything above counts calls.</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div title={PARTIES_REACHED_HELP}>
              <QsKpiTile
                label="Parties Reached"
                value={fmtCount(totals.partiesReached)}
                accent={C_PARTIES}
                icon={<UsersRound size={18} />}
              />
            </div>
            <div title={CONF_CALLS_HELP}>
              <QsKpiTile
                label="Conference Calls"
                value={fmtCount(totals.conferenceCalls)}
                accent={C_CONF_CALLS}
                icon={<UsersRound size={18} />}
              />
            </div>
            <div title={CONF_BILLED_HELP}>
              <QsKpiTile
                /*
                  * "Plivo", not "Conference". The sum is taken over every room,
                  * and a room is minted for every ops call — so labelling it
                  * "Conference Billed" would imply it covers only the
                  * multi-party ones and make it look wrong beside the far
                  * smaller Conference Calls tile next to it.
                  */
                label="Plivo Billed Minutes"
                accent={C_CONF_BILLED}
                icon={<Receipt size={18} />}
                /*
                  * The coverage line ships WITH the figure, inside the tile. It
                  * turns amber the moment it is a fraction, so an incomplete
                  * cost announces itself rather than reading as a footnote
                  * somebody was supposed to hover for.
                  */
                value={(
                  <span className="block">
                    <span className="block">
                      {confRooms === 0
                        ? <span className="text-muted-foreground">—</span>
                        : fmtTalkTime(totals.conferenceBilledSecs)}
                    </span>
                    <span className={`block text-xs font-medium ${confPartial ? 'text-warning-strong' : 'text-muted-foreground'}`}>
                      {confCoverage}
                    </span>
                  </span>
                )}
              />
            </div>
          </div>
        </section>
      )}

      {/*
        * Grain tabs — the SAME call set sliced two ways. One response feeds
        * both, so switching is instant. Chip counts are ROW counts (jobs /
        * user-days), not call counts.
        */}
      <div className="mt-4">
        <GlidingTabs
          ariaLabel="Call Tracking Breakdown"
          value={tab}
          onChange={(v) => setTab(v as Grain)}
          tabs={[
            { value: 'job',  label: 'By Job',  count: byJob.length },
            { value: 'user', label: 'By User', count: byUser.length },
          ]}
        />
      </div>

      {/* ── Tab 1: By Job ─────────────────────────────────────────────── */}
      {tab === 'job' && (
        <div className="overflow-x-auto rounded-md border border-border mt-4">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-left">Job #</th>
                <th className="!text-left">Client</th>
                {/* "Job Status", not "Status" — this row also carries per-call
                    step snapshots, so a bare "Status" would read ambiguously. */}
                <th className="!text-center" title="Where the JOB is now — distinct from the At Which Step column, which is the status when each call was made">Job Status</th>
                <th className="!text-center">Calls</th>
                <th className="!text-center" title="Calls that actually connected, and that share of all calls">Connected</th>
                <th className="!text-center">Total Duration</th>
                <th className="!text-center">Avg Duration</th>
                <th className="!text-left" title="Who placed the calls, and how many each">Called By</th>
                {/* Counts CALLS, not people: each call is attributed to the
                    party it was placed to, so a conference lands wholly under
                    the first party dialled. Anyone added mid-call is listed in
                    the drill-down, not here — see the file header.
                    This is the ONE place that names the way out of that
                    under-attribution (the Parties Reached tile). The other two
                    To Whom headers stay as they are: repeating it on all three
                    would read as three separate caveats rather than one. */}
                <th className="!text-left" title="Who the call was placed to — Customer, Alternate, Client SPOC, Technician or Other. Counts calls, so a conference is attributed to the party dialled first; open the call list to see everyone who joined. For the people rather than the calls, see the Parties Reached tile above, which counts everyone on the line.">To Whom</th>
                <th className="!text-left" title="The job status SNAPSHOT at the moment of each call — where in the lifecycle the calls were made from">At Which Step</th>
                <th className="!text-center">First Call</th>
                <th className="!text-center">Last Call</th>
              </tr>
            </thead>
            <tbody>
              {byJob.map((j) => (
                <tr key={j.jobId}>
                  <td className="!text-left font-medium">
                    {/* Opens the JobModal in place (JobModalHost below) — closing
                        returns here, not to Manage Jobs. Link stays shareable. */}
                    <JobRefLink jobId={j.jobId} />
                  </td>
                  <td className="!text-left whitespace-nowrap" title={j.clientName ?? ''}>
                    {j.clientName ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-center">
                    {j.currentJobStatus == null
                      ? <span className="text-muted-foreground">—</span>
                      : (
                        <StatusChip tone={statusTone(j.currentJobStatus)}>
                          {statusLabel(j.currentJobStatus, { assigned: j.assigned })}
                        </StatusChip>
                      )}
                  </td>
                  <td className="!text-center">
                    <CountLink
                      n={j.calls}
                      title="Show the individual calls behind this number"
                      onClick={() => setDrill({ jobId: j.jobId, label: `Job #${j.jobId}` })}
                    />
                  </td>
                  <td className="!text-center">
                    <span className="text-success-strong">{j.connected}</span>
                    <span className="ml-1 text-xs text-muted-foreground">({j.connectRate}%)</span>
                  </td>
                  <td className="!text-center tabular-nums">{fmtTalkTime(j.totalDurationSecs)}</td>
                  <td
                    className="!text-center tabular-nums"
                    title={`Longest Call: ${fmtSecs(j.maxDurationSecs)}`}
                  >
                    {fmtSecs(j.avgDurationSecs)}
                  </td>
                  <td className="!text-left text-xs">
                    <BreakdownCell
                      items={j.callers.map((c) => ({
                        key: String(c.userId ?? c.userName),
                        text: `${c.userName} (${c.calls})`,
                      }))}
                    />
                  </td>
                  <td className="!text-left text-xs">
                    <BreakdownCell items={j.parties.map((p) => ({ key: p.role, text: `${p.role} (${p.calls})` }))} />
                  </td>
                  <td className="!text-left text-xs">
                    {/*
                      * Keyed on the LABEL, not the status code: the BE folds
                      * steps by label while keeping the code, so status 0
                      * legitimately yields TWO entries (Pending for Scheduling
                      * and Pending App Ack) that both carry status 0. The label
                      * is the value that fold makes unique.
                      */}
                    <BreakdownCell items={j.steps.map((s) => ({ key: s.label, text: `${s.label} (${s.calls})` }))} />
                  </td>
                  <td className="!text-center text-xs"><DateTimeCell value={j.firstCallAt} /></td>
                  <td className="!text-center text-xs"><DateTimeCell value={j.lastCallAt} /></td>
                </tr>
              ))}
              {byJob.length === 0 && (
                <tr><td colSpan={12} className="!text-center text-muted-foreground py-6">No Calls In This Window.</td></tr>
              )}
            </tbody>
            {byJob.length > 0 && (
              <tfoot>
                <tr className="bg-muted/60 font-semibold">
                  <td className="!text-left" colSpan={3}>Total</td>
                  <td
                    className="!text-center"
                    title={
                      totals && totals.calls !== jobFoot.calls
                        ? `${totals.calls} calls in this window — ${totals.calls - jobFoot.calls} of them are not linked to a job, so they have no row here.`
                        : undefined
                    }
                  >
                    {jobFoot.calls}
                  </td>
                  <td className="!text-center">
                    {jobFoot.connected}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">({jobFoot.rate}%)</span>
                  </td>
                  <td className="!text-center tabular-nums">{fmtTalkTime(jobFoot.secs)}</td>
                  {/*
                    * Averaged over CONNECTED calls, matching the rows above —
                    * the BE's avgDurationSecs is AVG(duration) over duration > 0
                    * only. Dividing by ALL calls reported a different metric
                    * under the same header, and printed 0:00 for a window where
                    * nothing connected (every row shows '—' there).
                    */}
                  <td className="!text-center tabular-nums">
                    {fmtSecs(jobFoot.connected > 0 ? jobFoot.secs / jobFoot.connected : null)}
                  </td>
                  <td colSpan={5} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* ── Tab 2: By User — the SAME calls at two aggregation grains ─── */}
      {tab === 'user' && (
        <>
          {/*
            * Sub-tabs ONLY on a multi-day window. Over a single day the two
            * grains produce the identical table, and a toggle between two
            * identical views is a control that teaches the operator nothing.
            * Same shared GlidingTabs as the main grain tabs, and the same
            * response feeds both — switching never refetches.
            */}
          {multiDay && (
            <div className="mt-4">
              <GlidingTabs
                ariaLabel="By User Aggregation"
                value={userGrain}
                onChange={(v) => setUserGrain(v as UserGrain)}
                tabs={[
                  { value: 'date', label: 'Date Wise', count: byUser.length },
                  { value: 'combined', label: 'Combined', count: byUserCombined.length },
                ]}
              />
            </div>
          )}

      {/*
        * Deliberately OUTSIDE the multiDay guard above: the sub-tab strip only
        * renders for a multi-day window, but a single day can still carry
        * hundreds of callers, and that is exactly when someone is hunting one.
        */}
      <div className="mt-4 flex items-center gap-2">
        <Input
          value={userQuery}
          onChange={(e) => setUserQuery(e.target.value)}
          placeholder="Search user by name or ID…"
          aria-label="Search user by name or ID"
          className="h-8 max-w-xs text-sm"
        />
        {userQuery.trim() && (
          <>
            <span className="text-xs text-muted-foreground">
              {effectiveUserGrain === 'combined'
                ? `${byUserCombinedShown.length} of ${byUserCombined.length}`
                : `${byUserShown.length} of ${byUser.length}`} rows
            </span>
            <button
              type="button"
              onClick={() => setUserQuery('')}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Clear
            </button>
          </>
        )}
      </div>

      {/* ── Sub-tab 1: Date Wise (one row per day × user) ─────────────── */}
      {effectiveUserGrain === 'date' && (
        <div className="overflow-x-auto rounded-md border border-border mt-4">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-left">Date</th>
                <th className="!text-left">User</th>
                <th className="!text-center">Calls</th>
                <th className="!text-center" title="Distinct jobs this user called about on this day">Unique Jobs</th>
                <th className="!text-center">Connected</th>
                <th className="!text-center">Connect %</th>
                <th className="!text-center">Total Duration</th>
                <th className="!text-center">Avg Duration</th>
                <th className="!text-center" title="The job status most of this day's calls were made at — hover the cell for the full step breakdown">Majority Job Status</th>
                {/* Counts CALLS, not people: each call is attributed to the
                    party it was placed to, so a conference lands wholly under
                    the first party dialled. Anyone added mid-call is listed in
                    the drill-down, not here — see the file header. */}
                <th className="!text-left" title="Who the call was placed to — Customer, Alternate, Client SPOC, Technician or Other. Counts calls, so a conference is attributed to the party dialled first; open the call list to see everyone who joined.">To Whom</th>
                <th className="!text-center">First Call</th>
                <th className="!text-center">Last Call</th>
              </tr>
            </thead>
            <tbody>
              {byUserShown.map((r) => (
                <tr key={`${r.day}-${r.userId ?? r.userName}`}>
                  {/* Date on ONE line — it is an identifier, not prose. */}
                  <td className="!text-left whitespace-nowrap">{fmtDay(r.day)}</td>
                  <td className="!text-left font-medium whitespace-nowrap">
                    {r.userName}
                    {r.userId != null && <span className="ml-1 text-xs text-muted-foreground">#{r.userId}</span>}
                  </td>
                  <td className="!text-center">
                    {/*
                      * Drill needs BOTH halves of the grain (day + caller). A row
                      * with no resolvable caller can't be selected by id, and
                      * drilling on the day alone would return every user's calls —
                      * a number that wouldn't match the cell. So it stays plain.
                      */}
                    {r.userId == null ? (
                      <span title="These calls have no caller recorded, so they can't be isolated in a drill-down.">{r.calls}</span>
                    ) : (
                      <CountLink
                        n={r.calls}
                        title="Show the individual calls behind this number"
                        onClick={() => setDrill({
                          day: r.day,
                          callerId: r.userId ?? undefined,
                          label: `${r.userName} · ${fmtDay(r.day)}`,
                        })}
                      />
                    )}
                  </td>
                  <td className="!text-center">{r.uniqueJobs}</td>
                  <td className="!text-center text-success-strong">{r.connected}</td>
                  <td className="!text-center font-medium">{r.connectRate}%</td>
                  <td className="!text-center tabular-nums">{fmtTalkTime(r.totalDurationSecs)}</td>
                  <td className="!text-center tabular-nums">{fmtSecs(r.avgDurationSecs)}</td>
                  <td
                    className="!text-center"
                    /* Full step breakdown in the tooltip — the majority status is
                       a summary of it, and a second column would bloat the row. */
                    title={r.steps.map((s) => `${s.label} (${s.calls})`).join(', ')}
                  >
                    {/*
                      * Gated on the LABEL, which is the server-authoritative
                      * value (see the UserRow note above). topStatus is null
                      * whenever the majority bucket's at-call snapshot was NULL
                      * — the BE still labels that bucket 'Unknown', so gating on
                      * the code threw away an answer the report does have (and
                      * its call count with it). Tone falls back to slate.
                      */}
                    {!r.topStatusLabel ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        <StatusChip tone={r.topStatus == null ? 'slate' : statusTone(r.topStatus)}>
                          {r.topStatusLabel}
                        </StatusChip>
                        <span className="ml-1 text-xs text-muted-foreground">({r.topStatusCalls})</span>
                      </>
                    )}
                  </td>
                  <td className="!text-left text-xs">
                    <BreakdownCell items={r.parties.map((p) => ({ key: p.role, text: `${p.role} (${p.calls})` }))} />
                  </td>
                  <td className="!text-center text-xs"><DateTimeCell value={r.firstCallAt} /></td>
                  <td className="!text-center text-xs"><DateTimeCell value={r.lastCallAt} /></td>
                </tr>
              ))}
              {byUserShown.length === 0 && (
                <tr><td colSpan={12} className="!text-center text-muted-foreground py-6">No Calls In This Window.</td></tr>
              )}
            </tbody>
            {byUserShown.length > 0 && (
              <tfoot>
                <tr className="bg-muted/60 font-semibold">
                  <td className="!text-left" colSpan={2}>Total</td>
                  <td className="!text-center">{userFoot.calls}</td>
                  {/* NOT the column sum — a job called by two users on two days
                      appears in both rows. Only totals.uniqueJobs is distinct. */}
                  <td
                    className="!text-center"
                    title="Distinct jobs across the whole window — deliberately not the sum of the column, which double-counts a job called by more than one user or on more than one day."
                  >
                    {totals?.uniqueJobs ?? '—'}
                  </td>
                  <td className="!text-center">{userFoot.connected}</td>
                  <td className="!text-center">{userFoot.rate}%</td>
                  <td className="!text-center tabular-nums">{fmtTalkTime(userFoot.secs)}</td>
                  {/* Connected-only denominator — same reason as the By Job footer. */}
                  <td className="!text-center tabular-nums">
                    {fmtSecs(userFoot.connected > 0 ? userFoot.secs / userFoot.connected : null)}
                  </td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* ── Sub-tab 2: Combined (one row per user, whole window) ──────── */}
      {effectiveUserGrain === 'combined' && (
        <div className="overflow-x-auto rounded-md border border-border mt-4">
          <table className="data-table">
            <thead>
              <tr>
                <SortTh label="User" col="userName" sort={combinedSort} onSort={onCombinedSort} className="!text-left" />
                {/*
                  * The DENOMINATOR, shown before the averages that use it. An
                  * average per day is unreadable without it — 5 calls/day over
                  * 2 active days is a very different claim from 5 over 20.
                  */}
                <SortTh
                  label="Active Days" col="activeDays" sort={combinedSort} onSort={onCombinedSort}
                  className="!text-right"
                  title="Days on which this user placed at least one call. This is the denominator of both per-day averages — not the number of days in the selected range."
                />
                <SortTh label="Calls" col="calls" sort={combinedSort} onSort={onCombinedSort} className="!text-right" />
                <SortTh label="Unique Jobs" col="uniqueJobs" sort={combinedSort} onSort={onCombinedSort} className="!text-right" title="Distinct jobs this user called about across the whole window" />
                <SortTh label="Connected" col="connected" sort={combinedSort} onSort={onCombinedSort} className="!text-right" />
                <SortTh label="Connect %" col="connectRate" sort={combinedSort} onSort={onCombinedSort} className="!text-right" />
                <SortTh label="Avg Calls / Day" col="avgCallsPerDay" sort={combinedSort} onSort={onCombinedSort} className="!text-right" title={PER_DAY_HELP} />
                <SortTh label="Total Duration" col="totalDurationSecs" sort={combinedSort} onSort={onCombinedSort} className="!text-right" />
                <SortTh label="Avg Duration / Call" col="avgDurationSecs" sort={combinedSort} onSort={onCombinedSort} className="!text-right" title="Averaged over CONNECTED calls only — a call that never connected is not talk time" />
                <SortTh label="Avg Duration / Day" col="avgDurationPerDaySecs" sort={combinedSort} onSort={onCombinedSort} className="!text-right" title={PER_DAY_HELP} />
                <th className="!text-center" title="The job status most of this user's calls were made at — hover the cell for the full step breakdown">Majority Job Status</th>
                {/* Counts CALLS, not people: each call is attributed to the
                    party it was placed to, so a conference lands wholly under
                    the first party dialled. Anyone added mid-call is listed in
                    the drill-down, not here — see the file header. */}
                <th className="!text-left" title="Who the call was placed to — Customer, Alternate, Client SPOC, Technician or Other. Counts calls, so a conference is attributed to the party dialled first; open the call list to see everyone who joined.">To Whom</th>
              </tr>
            </thead>
            <tbody>
              {byUserCombinedShown.map((r) => {
                // Spelled out per row so the number on screen carries its own
                // denominator, not just the column header's general caveat.
                const perDayTitle = `${PER_DAY_HELP} This user placed calls on ${r.activeDays} of the ${byDay.length} days in the range.`;
                return (
                  <tr key={r.userId ?? r.userName}>
                    <td className="!text-left font-medium whitespace-nowrap">
                      {r.userName}
                      {r.userId != null && <span className="ml-1 text-xs text-muted-foreground">#{r.userId}</span>}
                    </td>
                    <td className="!text-right tabular-nums whitespace-nowrap" title={perDayTitle}>{r.activeDays}</td>
                    <td className="!text-right tabular-nums whitespace-nowrap">
                      {/*
                        * Drills on the caller ALONE — no day — so the dialog
                        * spans the whole window, exactly the set this row
                        * counts. The endpoint applies each selection key only
                        * when present, so caller-without-day already worked.
                        */}
                      {r.userId == null ? (
                        <span title="These calls have no caller recorded, so they can't be isolated in a drill-down.">{r.calls}</span>
                      ) : (
                        <CountLink
                          n={r.calls}
                          title="Show the individual calls behind this number — every call this user placed in the window"
                          onClick={() => setDrill({
                            callerId: r.userId ?? undefined,
                            label: `${r.userName}${windowLabel ? ` · ${windowLabel}` : ''}`,
                          })}
                        />
                      )}
                    </td>
                    <td className="!text-right tabular-nums whitespace-nowrap">{r.uniqueJobs}</td>
                    <td className="!text-right tabular-nums whitespace-nowrap text-success-strong">{r.connected}</td>
                    <td className="!text-right tabular-nums whitespace-nowrap font-medium">{r.connectRate}%</td>
                    {/* null renders as an em-dash — "cannot divide", never "0". */}
                    <td className="!text-right tabular-nums whitespace-nowrap font-medium" title={perDayTitle}>
                      {r.avgCallsPerDay == null ? <span className="text-muted-foreground">—</span> : r.avgCallsPerDay}
                    </td>
                    <td className="!text-right tabular-nums whitespace-nowrap">{fmtTalkTime(r.totalDurationSecs)}</td>
                    <td className="!text-right tabular-nums whitespace-nowrap">{fmtSecs(r.avgDurationSecs)}</td>
                    <td className="!text-right tabular-nums whitespace-nowrap" title={perDayTitle}>
                      {fmtTalkTime(r.avgDurationPerDaySecs)}
                    </td>
                    <td
                      className="!text-center"
                      title={r.steps.map((s) => `${s.label} (${s.calls})`).join(', ')}
                    >
                      {/* Server-authoritative label, same reasoning as the Date
                          Wise table — only the chip TONE is derived locally. */}
                      {!r.topStatusLabel ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <>
                          <StatusChip tone={r.topStatus == null ? 'slate' : statusTone(r.topStatus)}>
                            {r.topStatusLabel}
                          </StatusChip>
                          <span className="ml-1 text-xs text-muted-foreground">({r.topStatusCalls})</span>
                        </>
                      )}
                    </td>
                    <td className="!text-left text-xs">
                      <BreakdownCell items={r.parties.map((p) => ({ key: p.role, text: `${p.role} (${p.calls})` }))} />
                    </td>
                  </tr>
                );
              })}
              {byUserCombinedShown.length === 0 && (
                <tr><td colSpan={12} className="!text-center text-muted-foreground py-6">No Calls In This Window.</td></tr>
              )}
            </tbody>
            {byUserCombinedShown.length > 0 && (
              <tfoot>
                <tr className="bg-muted/60 font-semibold">
                  <td className="!text-left">Total</td>
                  <td
                    className="!text-right tabular-nums"
                    title="Total user-days on which at least one call was placed — the denominator of the two averages in this row."
                  >
                    {combinedFoot.days}
                  </td>
                  <td className="!text-right tabular-nums">{combinedFoot.calls}</td>
                  {/* NOT the column sum — a job called by two users appears in
                      both rows. Only totals.uniqueJobs is distinct. */}
                  <td
                    className="!text-right tabular-nums"
                    title="Distinct jobs across the whole window — deliberately not the sum of the column, which double-counts a job called by more than one user."
                  >
                    {totals?.uniqueJobs ?? '—'}
                  </td>
                  <td className="!text-right tabular-nums">{combinedFoot.connected}</td>
                  <td className="!text-right tabular-nums">{combinedFoot.rate}%</td>
                  {/*
                    * Σcalls / Σactive-days — WEIGHTED across every user-day
                    * worked, not the mean of the column above (which would give
                    * a one-day caller the same say as a 22-day one).
                    */}
                  <td
                    className="!text-right tabular-nums"
                    title="All calls divided by all active user-days — a weighted average, not the mean of the column above."
                  >
                    {combinedFoot.callsPerDay == null ? <span className="text-muted-foreground">—</span> : combinedFoot.callsPerDay}
                  </td>
                  <td className="!text-right tabular-nums">{fmtTalkTime(combinedFoot.secs)}</td>
                  {/* Connected-only denominator — same reason as the By Job footer. */}
                  <td className="!text-right tabular-nums">
                    {fmtSecs(combinedFoot.connected > 0 ? combinedFoot.secs / combinedFoot.connected : null)}
                  </td>
                  <td
                    className="!text-right tabular-nums"
                    title="All talk time divided by all active user-days — a weighted average, not the mean of the column above."
                  >
                    {fmtTalkTime(combinedFoot.secsPerDay)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
        </>
      )}

      <CallDrilldownDialog drill={drill} filters={applied} onClose={() => setDrill(null)} />

      {/* Hosts the in-place job workspace for every <JobRefLink> on this page. */}
      <JobModalHost />
    </ReportPageScaffold>
  );
}

/*
 * A count rendered as a button when there is something to show. Zero stays
 * plain text — a clickable 0 that opens an empty list is a dead end.
 */
function CountLink({ n, tone, title, onClick }: { n: number; tone?: string; title?: string; onClick: () => void }) {
  if (!n) return <span className={tone}>{n}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`underline decoration-dotted underline-offset-2 hover:decoration-solid ${tone ?? ''}`}
      title={title}
    >
      {n}
    </button>
  );
}

/* ── Drill-down: the individual calls behind a clicked count ─────────── */

/*
 * Posts to the report's own /calls endpoint with the SAME filters as the summary
 * plus the clicked selection, so the rows returned are exactly the ones that
 * produced the number. That filter fidelity is why this does NOT reuse the job's
 * generic call-history endpoint — that answers "every call on this job, ever",
 * which would show rows outside the report's window and make the count look wrong.
 *
 * Fetch-on-click rather than inlining details in the summary: the report can
 * return thousands of rows, and shipping every row's call list would multiply the
 * payload for data almost none of which is opened.
 */
type Drill = {
  jobId?: number;
  /** tbl_user id of the caller (By User tab). */
  callerId?: number;
  /** 'YYYY-MM-DD' — pairs with callerId to pin the (day × user) grain. */
  day?: string;
  /** Row identity for the dialog title — "Job #N" or "Name · 03 Jul 2026". */
  label: string;
};

type CallDetail = {
  /** tbl_job_caller_info.job_caller_info */
  id: number;
  jobId: number | null;
  callAt: string | null;
  callerUserId: number | null; callerName: string;
  // Which table resolved the caller — see CALLER_NAME in the BE service.
  callerKind?: 'user' | 'technician' | 'unresolved';
  receiverName: string | null; partyRole: string;
  /** The SNAPSHOT — job status when the call was placed, not today's status. */
  jobStatusAtCall: number | null; assignedAtCall: boolean;
  durationSecs: number | null; connected: boolean;
  /** Never null — see PROVIDER_RULE in quicksight-call-tracking.service.js. */
  provider: string; providerAssumed?: boolean; providerRaw?: string | null;
  callerStatus: string | null;
  recordingAvailable: boolean;
  /*
   * Everyone who was on the call, if it was a conference — the ops agent
   * included. These are NESTED under the call rather than returned as extra
   * top-level rows, deliberately: this drill-down's contract is that its row
   * count reconciles with the summary number that was clicked, and flattening
   * legs into rows would break that the moment anyone counted them.
   */
  legs?: CallLeg[] | null;
};

/*
 * Inline recording playback for a drill-down row — the SAME lazy pattern the
 * Call Analytics list uses (settings/call-analytics/page.tsx ListenButton), not
 * a second implementation.
 *
 * Lazy on purpose: GET /admin/calls/:id/recording pulls the file from the
 * provider and caches it to S3 on first request, so pre-fetching a URL for every
 * visible row would hammer Plivo/Kaleyra for recordings nobody plays. A ▶ button
 * until clicked, then an inline player.
 *
 * ⚠ Uses <CallRecordingAudio>, never a bare <audio>: Plivo recordings are
 * 2-channel BY DESIGN (agent left, customer right), so a plain player makes the
 * customer audible on one side only. That component downmixes to mono and falls
 * back to plain stereo if the browser refuses.
 *
 * `callId` is tbl_job_caller_info.job_caller_info — exactly the id that route
 * takes, which is why this needed no backend change.
 */
function ListenButton({ callId }: { callId: number }) {
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  if (url) return <CallRecordingAudio src={url} autoPlay className="h-7 w-44" />;

  async function play() {
    setLoading(true);
    try {
      const r = await api.get<{ url: string }>(`/admin/calls/${callId}/recording`);
      if (r?.url) setUrl(r.url);
      else showToast({ variant: 'error', message: 'No recording available for this call.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Could not load the recording.' });
    } finally {
      setLoading(false);
    }
  }

  return <IconButton icon={Play} label="Listen Recording" busy={loading} onClick={() => void play()} />;
}

/** The clicked selection's identity — the remount key for the body below. */
function drillKey(d: Drill): string {
  return `${d.jobId ?? ''}|${d.callerId ?? ''}|${d.day ?? ''}`;
}

function CallDrilldownDialog({ drill, filters, onClose }: {
  drill: Drill | null;
  filters: FilterBody;
  onClose: () => void;
}) {
  /*
   * Read-only dialog → isDirty:false so the shared guard closes immediately
   * instead of asking "discard changes?" on a panel with no input. Routed
   * through the guard anyway — that is the project-wide <Dialog> contract.
   */
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  return (
    <Dialog open={drill != null} onOpenChange={guardedOpenChange}>
      {/* Wider than the default report dialog: this table carries 9 columns and
          now an inline audio player, so 5xl forced the Recording column to wrap. */}
      <DialogContent className="max-w-6xl">
        <DialogHeader>
          <DialogTitle>{drill ? `Calls · ${drill.label}` : ''}</DialogTitle>
        </DialogHeader>
        {/*
          * The fetch lives in a child that is MOUNTED PER SELECTION and keyed by
          * it, so its hook state can never outlive the cell it belongs to.
          * usePostFetch deliberately KEEPS the previous response's rows when its
          * key changes (and reports loading:false because data != null) — with
          * one long-lived hook here, re-opening on another cell rendered the
          * PREVIOUS cell's calls, and its "most recent calls only" banner, under
          * the new cell's title until the new POST resolved. A fresh mount starts
          * at data:null, so the Loading… line always belongs to what was clicked.
          */}
        {drill && (
          <CallDrilldownBody key={drillKey(drill)} drill={drill} filters={filters} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CallDrilldownBody({ drill, filters, onClose }: {
  drill: Drill;
  filters: FilterBody;
  onClose: () => void;
}) {
  /*
   * The POST body IS the cache key for usePostFetch, so it must be stable —
   * an inline object literal would refetch on every render.
   */
  const body = useMemo(() => ({
    ...filters,
    jobId: drill.jobId,
    selectedCallerId: drill.callerId,
    day: drill.day,
  }), [drill, filters]);

  const detail = usePostFetch<{ items: CallDetail[]; capped: boolean }>(
    `${API_BASE}/calls`,
    body,
  );
  /*
   * Grouped before rendering, for the same reason as every other call surface:
   * one row per CALL. It matters more here than anywhere else, because this
   * table's row count is what an operator reconciles against the summary figure
   * they clicked — a conference listed as three rows under a cell that said "1"
   * reads as a broken report.
   */
  const items = useMemo(
    () => (detail.data?.items ? groupCallRows(detail.data.items) : null),
    [detail.data?.items],
  );

  return (
    <>
      {detail.error && <p className="text-sm text-urgent-strong">{String(detail.error)}</p>}
      {!detail.error && items === null && (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      )}
      {!detail.error && items !== null && (
        <>
          {detail.data?.capped && (
            <p className="mb-2 text-xs text-warning-strong">
              Showing the most recent calls only — narrow the filters to see the rest.
            </p>
          )}
          <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="!text-center">Called At</th>
                  <th className="!text-left">Job #</th>
                  <th className="!text-left">Called By</th>
                  {/* On a conference this cell lists EVERY person on the call,
                      each with their role — the one place in this report where
                      per-leg detail exists. */}
                  <th className="!text-left" title="Who was on the call. A conference lists everyone who joined it, with their role.">To Whom</th>
                  {/* The SNAPSHOT status, which is the reason this drill-down
                      exists — see the page header note. */}
                  <th className="!text-center" title="The job status at the MOMENT of this call — the job may have moved on since">Job Status At Call</th>
                  <th className="!text-center">Duration</th>
                  <th className="!text-center">Outcome</th>
                  <th className="!text-left">Provider</th>
                  <th className="!text-center" title="Whether a call recording was captured for this call">Recording</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td className="!text-center text-xs"><DateTimeCell value={c.callAt} seconds /></td>
                    <td className="!text-left font-medium">
                      {/* Close this drill-down first, then open the job in
                          place — one modal at a time (beforeOpen). */}
                      {c.jobId == null
                        ? <span className="text-muted-foreground">—</span>
                        : <JobRefLink jobId={c.jobId} beforeOpen={onClose} />}
                    </td>
                    <td className="!text-left whitespace-nowrap">
                      {c.callerName}
                      {/*
                        * The id renders ONLY when the backend resolved it to a
                        * real CRM user. caller_id holds a tbl_user id on rows
                        * this backend writes and an efr_id on rows the legacy
                        * CRM writes, so an unqualified "#352882" beside a name
                        * asserted a CRM user that does not exist — which is how
                        * "Called By" and "To Whom" ended up reading as the same
                        * person on job 529116.
                        */}
                      {c.callerUserId != null && c.callerKind === 'user' && (
                        <span className="ml-1 text-xs text-muted-foreground">#{c.callerUserId}</span>
                      )}
                      {c.callerKind === 'technician' && (
                        <span className="ml-1 text-xs text-muted-foreground">Technician</span>
                      )}
                    </td>
                    {/*
                      * A conference replaces the single-counterparty summary
                      * with the full roster rather than sitting beside it: the
                      * summary line is derived from the number dialled FIRST, so
                      * on a 3-party call it is not a summary, it is one of the
                      * three — and printing it above the same person's leg would
                      * read as four people on a three-person call.
                      */}
                    <td className="!text-left">
                      {isConferenceCall(c) ? (
                        <>
                          <ConferenceBadge row={c} />
                          <CallLegList legs={c.legs} className="mt-1" dense />
                        </>
                      ) : (
                        <>
                          <span className="block whitespace-nowrap">
                            {c.receiverName || <span className="text-muted-foreground">—</span>}
                          </span>
                          <span className="block whitespace-nowrap text-xs text-muted-foreground">{c.partyRole}</span>
                        </>
                      )}
                    </td>
                    <td className="!text-center">
                      {c.jobStatusAtCall == null
                        ? <span className="text-muted-foreground">—</span>
                        : (
                          <StatusChip tone={statusTone(c.jobStatusAtCall)}>
                            {statusLabel(c.jobStatusAtCall, { assigned: c.assignedAtCall })}
                          </StatusChip>
                        )}
                    </td>
                    <td className="!text-center tabular-nums">{fmtSecs(c.durationSecs)}</td>
                    <td className="!text-center">
                      <StatusChip tone={c.connected ? 'emerald' : 'slate'} size="sm" title={c.callerStatus ?? undefined}>
                        {c.connected ? 'Connected' : 'Not Connected'}
                      </StatusChip>
                    </td>
                    {/*
                      * Never blank: the backend labels every call with the vendor its own
                      * provider FILTER would place it under, so the cell always names the
                      * tab the row appears in. `providerAssumed` marks rows where the
                      * column named no vendor and "only two vendors have ever existed" was
                      * used instead. The tooltip carries whatever WAS stored, including
                      * 2021 telecom-carrier values like 'JIO', which must never be printed
                      * here as though they were the vendor.
                      */}
                    <td
                      className="!text-left whitespace-nowrap"
                      title={c.providerRaw ? `Stored value: ${c.providerRaw}` : undefined}
                    >
                      {c.provider}
                      {c.providerAssumed && (
                        <span className="ml-1 text-xs text-muted-foreground">(assumed)</span>
                      )}
                    </td>
                    <td className="!text-center text-xs">
                      {c.recordingAvailable
                        ? <ListenButton callId={c.id} />
                        : <span className="text-muted-foreground">No</span>}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">No Calls In This Selection.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
