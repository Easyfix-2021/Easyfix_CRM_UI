/*
 * QuickSight — MTD Client Report: the per-client document's derivations.
 *
 * Every figure the one-client report shows is derived HERE, from the report
 * response the tab already holds, so the rendering file beside this one is
 * layout and nothing else. Nothing in this module fetches and nothing in it
 * holds state.
 *
 * WHAT THIS IS A PORT OF. The owner's MIS automation v2 builds a one-client
 * Word document in the browser (engine/template.html, `buildReport`). That
 * document — not the MIS dashboard above it — is what this folder rebuilds:
 * a title block, a KPI row of SEVEN, up to three ticked highlights, two
 * day-wise blocks (a bar chart with a trend line, and the same figures as a
 * table with a Total), the status-by-aging matrix cut down to two rows, and
 * the open-orders-by-tier matrix.
 *
 * THE SEVEN KPIs ARE NOT THE TAB'S SIX. The tab's tiles are Orders Created,
 * Completed, Cancelled, Completion %, TAT % and Cancelled %. The client
 * document drops Cancelled % and adds ESCALATED and SDA % — so it is
 * Orders Created, Completed, Cancelled, Escalated, Completion %, TAT %,
 * SDA %. ALL SEVEN ARE LIVE: /mtd/report now reads Is Escalated and SDA Status
 * from the same export columns the MIS does.
 *
 * ⚠ ESCALATED IS DIVIDED BY JOBS IN HAND, NOT BY COMPLETED JOBS. In both of
 * the template's KPI passes the count sits OUTSIDE the `s === "C"` branch —
 *
 *     if (C.esc[i] === 1) esc++;            // completed, cancelled AND open
 *     if (s === "C"){ c++; if (C.tat[i] === 1) t++; if (C.sda[i] === 1) sd++; }
 *     es.append(el("b", null, pct1(esc, total)), " of jobs in hand");
 *
 * — so its denominator is completed + cancelled + open, and TAT % and SDA %
 * are the two that divide by completed. An escalation is a complaint about a
 * job and the jobs people escalate hardest are the ones still OPEN, so reading
 * this over closures would both hide those rows and overstate the rate several
 * times over. The wording is pinned in ESCALATED_DENOMINATOR below rather than
 * typed out at a call site, so it cannot drift into "of completed jobs".
 *
 * ⚠ COMPLETED HAS TWO DATE BASES AND THE DOCUMENT SHOWS BOTH.
 *
 *   CLOSURE DATE     `kpis.completed`, the Audit & Checkout day. What the tab
 *                    has always shipped, and the only basis the rest of the
 *                    KPI row is consistent with: `tatPct.den`, `sdaPct.den`
 *                    and `completionPct` all count THIS set of closures.
 *   APP CHECKIN DATE `completedOnCheckin.count`, the day the technician
 *                    arrived. The basis the owner's MIS v2 moved to (prep.py,
 *                    27 Sep), and therefore the number to compare against
 *                    their Word file.
 *
 *   The tile keeps the CLOSURE basis, so the seven KPIs cannot contradict one
 *   another, and the check-in figure is shown beside it under its own label
 *   rather than buried — see completedBases(). It is never presented as
 *   v2's figure when `completedOnCheckin.complete` is false: a window ending in
 *   the past can only yield a floor, because a job that checked in inside it
 *   but was audited after it was never read by this report at all.
 *
 * ⚠ EVERY FIGURE ON THIS DOCUMENT IS NOW A MEASUREMENT. Nothing here is a
 * placeholder any more and there is no `UNWIRED` map: Escalated, SDA % and —
 * last of the three — the tier matrix are all read from /mtd/report. The rule
 * that map existed to enforce still governs whatever is added next: a figure
 * nobody has measured is rendered as an explicit "not wired yet" state naming
 * the missing field, and NEVER as 0, as an en dash, or as a number borrowed
 * from a neighbouring metric. A zero there would be a claim nobody has
 * measured, and it is the kind of number that survives a screenshot into a
 * client's inbox.
 *
 * ⚠ THE AGING BANDS ARE THE MATRIX'S SIX, READ FROM THE RESPONSE. 0–3 / 4–5 /
 * 6–9 / 10–15 / 16–30 / over 30. They are NOT the four bands of the tab's
 * By Days Open card (0–2 / 3–5 / 6–9 / over 9), and no constant in this file
 * writes either list down — `statusAging.buckets` and `tierAging.buckets` are
 * the only sources, exactly as StatusAgingSection does it.
 *
 * ⚠ THE TIER MATRIX NEEDS NO DERIVATION AND HAS NONE HERE. Its rows arrive
 * already split, already totalled and ALREADY SORTED into the template's order
 * (real tiers by natural-numeric collation, blank tier last), so the renderer
 * walks them in order. A sort or a re-total in this file would be a second
 * opinion about numbers the .docx and the screen must agree on.
 */

import type {
  MtdCityRow,
  MtdCompletedOnCheckin,
  MtdDaily,
  MtdEscalatedBySet,
  MtdFilterOption,
  MtdPct,
  MtdReportResponse,
  MtdStatusAging,
} from '../../types';

/* ── the two basis rules the copy must never get wrong ────────────────────── */

/**
 * The words that follow the Escalated percentage, written down ONCE.
 *
 * `kpis.escalatedPct` divides by jobs in hand, so this is the only phrase that
 * describes it truthfully. Saying "of completed jobs" beside the same number
 * would overstate the rate by roughly the ratio of jobs in hand to closures —
 * three to one is ordinary on this report — and it is the kind of sentence
 * that ends up quoted back in a client meeting.
 */
export const ESCALATED_DENOMINATOR = 'of jobs in hand';

/** The two names the document uses for the two dates a closure can be counted on. */
export const BASIS_LABEL = {
  closure: 'Closure Date',
  checkin: 'App CheckIn Date',
} as const;

/* ── escalated: where the escalations are ─────────────────────────────────── */

/** One set's share of `kpis.escalated`, ready to render as a row. */
export type EscalatedPart = { key: keyof MtdEscalatedBySet; label: string; count: number };

/**
 * The Escalated count split across the three sets it is counted over.
 *
 * Shown because the split is the argument for the denominator: on a normal
 * month most of the escalations sit on OPEN jobs, and a reader who can see
 * that will not ask why the tile is not divided by completed. The three always
 * sum to `kpis.escalated` — the server checks that identity itself and reports
 * it as `checks.escalated`.
 *
 * The order is the KPI row's own — completed, cancelled, open — not sorted by
 * size, so the three counts do not swap places between two windows.
 */
export function escalatedParts(bySet: MtdEscalatedBySet): EscalatedPart[] {
  return [
    { key: 'completed', label: 'Completed', count: bySet.completed },
    { key: 'cancelled', label: 'Cancelled', count: bySet.cancelled },
    { key: 'open', label: 'Open', count: bySet.open },
  ];
}

/* ── completed: the two date bases, side by side ──────────────────────────── */

/**
 * One closure the check-in basis could not place inside the window, and why.
 *
 * These are not lost jobs: every one of them is counted in `kpis.completed`,
 * on its closure day. They are the arithmetic that explains the gap between
 * the two figures, which is the first thing anybody asks when the document
 * disagrees with the owner’s file by a handful.
 */
export type HeldClosure = { key: string; label: string; count: number };

/** Both ways of counting the same closures, with everything needed to explain the gap. */
export type CompletedBases = {
  /** `kpis.completed` — the tile's figure, counted on the Audit & Checkout day. */
  closure: number;
  /** `completedOnCheckin.count` — v2's figure, counted on the App CheckIn day. */
  checkin: number;
  /** checkin − closure. Negative when jobs checked in before the window opened. */
  delta: number;
  /**
   * TRUE WHEN `checkin` IS ONLY A FLOOR. The window ends in the past, so a job
   * that checked in inside it and was audited after it never reached this
   * report — it is not in the completed set to be re-dated. The figure must be
   * presented as "at least", never as v2's.
   */
  floor: boolean;
  /** The closures the check-in basis put outside the window, by reason. Non-zero rows only. */
  held: HeldClosure[];
  /** Closures whose check-in cell was blank, so both bases used the closure day. */
  fellBack: number;
};

/**
 * The Completed figure on both bases, from the response and nothing else.
 *
 * WHY BOTH ARE KEPT. v2 derives a single basis column and filters its whole
 * file through it, so moving Completed onto the check-in date there also moves
 * which jobs are in the month for TAT %, SDA %, the city split and the aging
 * bands. /mtd/report deliberately did not follow it that far: `kpis.completed`
 * stays on the closure date, and the check-in count ships beside it. Showing
 * only the check-in number here would leave the tile disagreeing with
 * `tatPct.den` and `sdaPct.den` in the same row, which is a worse lie than the
 * one it would fix.
 *
 * `held` is filtered to the non-zero reasons: a list of three zeroes explains
 * nothing and reads as though something is wrong.
 */
export function completedBases(
  completed: number,
  onCheckin: MtdCompletedOnCheckin,
): CompletedBases {
  const held: HeldClosure[] = [
    { key: 'beforeWindow', label: 'Checked in before this window', count: onCheckin.beforeWindow },
    { key: 'afterWindow', label: 'Checked in after this window', count: onCheckin.afterWindow },
    { key: 'unknownDate', label: 'No usable date on either basis', count: onCheckin.unknownDate },
  ];
  return {
    closure: completed,
    checkin: onCheckin.count,
    delta: onCheckin.count - completed,
    floor: !onCheckin.complete,
    held: held.filter((h) => h.count > 0),
    fellBack: onCheckin.noCheckinDate,
  };
}

/* ── small shared helpers ─────────────────────────────────────────────────── */

/**
 * Builds a percentage in the backend's own {num, den, pct} shape, so it can go
 * through `pct1` with every other figure on the tab.
 *
 * `pct` IS NULL WHEN `den` IS 0, matching the server's `pct()`: a zero
 * denominator is "there was nothing to measure", which `pct1` prints as an en
 * dash rather than as 0%.
 */
export function makePct(num: number, den: number): MtdPct {
  return { num, den, pct: den > 0 ? Math.round((num / den) * 1000) / 10 : null };
}

/* ── which client the document is for ─────────────────────────────────────── */

/**
 * What the Client filter currently scopes the document to.
 *
 * The MIS page scopes its Word report the same way — one client ticked in the
 * filter bar is what makes it a client report — so this layout follows the
 * existing filter rather than adding a picker of its own. Anything other than
 * exactly one client is a state the section explains, not one it guesses at.
 */
export type ClientScope =
  | { kind: 'one'; clientId: number; clientName: string }
  | { kind: 'none' }
  | { kind: 'many'; count: number };

/**
 * Resolves the Client multi-select to a scope.
 *
 * The NAME comes from the report's own picker options, which carry every
 * client the window holds with its own selection ignored — so the ticked
 * client is always among them. A ticked id the options do not describe (a
 * client whose last job left the window between two builds) falls back to its
 * id rather than rendering a blank heading.
 */
export function resolveClientScope(
  clientIds: readonly number[],
  options: ReadonlyArray<MtdFilterOption<number>>,
): ClientScope {
  if (clientIds.length === 0) return { kind: 'none' };
  if (clientIds.length > 1) return { kind: 'many', count: clientIds.length };
  const id = clientIds[0];
  const found = options.find((c) => c.id === id);
  return { kind: 'one', clientId: id, clientName: found?.name ?? `Client ${id}` };
}

/* ── the title block's meta line ──────────────────────────────────────────── */

/**
 * The parts of the document's meta line, in v2's order: what the document is,
 * then whichever of the two other multi-selects are narrowing it, then when
 * the data was read. The caller joins them and adds the "as of" stamp.
 *
 * The export-predicate filters (Vertical Id, Zonal Manager) are deliberately
 * NOT here: v2's meta line names its filter bar's three multi-selects, and
 * those two are a different family — they narrow which rows are read at all,
 * and the tab's own status line already reports them.
 */
export function metaParts(
  report: MtdReportResponse,
  spocOptions: ReadonlyArray<MtdFilterOption<number>>,
): string[] {
  const parts = ['Month-To-Date Client Report'];

  const verticals = report.scope.verticals;
  if (verticals && verticals.length > 0) parts.push(`Vertical: ${nameList(verticals)}`);

  const spocIds = report.scope.spocUserIds;
  if (spocIds && spocIds.length > 0) {
    const names = spocIds.map((id) => spocOptions.find((s) => s.id === id)?.name ?? `SPOC ${id}`);
    parts.push(`Primary SPOC: ${nameList(names)}`);
  }

  return parts;
}

/**
 * v2's `selLabel`: up to three names in full, and past that a count with the
 * first three named. A meta line that runs to forty SPOCs is not a meta line.
 */
function nameList(names: readonly string[]): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (sorted.length <= 3) return sorted.join(', ');
  return `${sorted.length} selected (${sorted.slice(0, 3).join(', ')}, …)`;
}

/* ── key highlights ───────────────────────────────────────────────────────── */

/**
 * One ticked line of "Key highlights": a bold lead figure and the sentence
 * that follows it.
 *
 * `id` is stable per rule, not per position, so React keeps a line's identity
 * when a filter change drops the rule above it.
 */
export type Highlight = { id: string; lead: string; rest: string };

/**
 * v2's `positiveHighlights`, rule for rule and threshold for threshold.
 *
 * THESE ARE CLIENT-FACING LINES AND EVERY ONE OF THEM IS OPTIONAL. Each rule
 * is included only when its number reads well — 70% of finished jobs
 * completed, 70% closed within TAT, 35% closed in the first band — so a bad
 * month produces a SHORTER list rather than a list of bad news. That is the
 * owner's decision, not a rounding of ours, and it is why the block can show
 * one line or none at all.
 *
 * At most three survive, because the Word file is meant to stay on one page.
 *
 * WHAT THIS DOES NOT DO: invent a rule the MIS does not have, or soften one it
 * does. A rule whose input is unwired (there is none today) would be dropped,
 * never filled with a neighbouring figure.
 */
export function buildHighlights(report: MtdReportResponse): Highlight[] {
  const out: Highlight[] = [];
  const k = report.kpis;
  const cvc = report.completionVsCancellation;

  /* 1. the headline count, and the cities it spread across. */
  if (k.completed > 0) {
    const cities = citiesWithCompletions(report.cities);
    const where = cities > 1 ? ` across ${formatCount(cities)} cities` : '';
    out.push({
      id: 'completed',
      lead: formatCount(k.completed),
      rest: ` jobs completed${where} in this period.`,
    });
  }

  /* 2. finished jobs only — completed over completed + cancelled. */
  if (cvc.finished > 0 && cvc.completed / cvc.finished >= 0.7) {
    out.push({
      id: 'finished',
      lead: pctText(cvc.completionRate),
      rest: ' of finished jobs completed successfully.',
    });
  }

  /* 3. turnaround, over completed jobs. */
  if (k.completed > 0 && k.tatPct.num / k.completed >= 0.7) {
    out.push({ id: 'tat', lead: pctText(k.tatPct), rest: ' of completed jobs closed within TAT.' });
  }

  /*
   * 4. the fastest band. This reads the FIRST band of By Days Open (0–2 days),
   * which is the four-band split, NOT the matrix's six — v2's rule is written
   * against that card and the threshold is calibrated to it. The band's own
   * label is quoted rather than typed, so the sentence follows the backend if
   * the split ever moves.
   */
  const fastest = report.byDaysOpen.buckets[0];
  const doneTotal = report.byDaysOpen.totals.completed;
  if (fastest && doneTotal > 0 && fastest.completed / doneTotal >= 0.35) {
    out.push({
      id: 'fastest',
      lead: pctText(makePct(fastest.completed, doneTotal)),
      rest: ` of completed jobs closed within ${fastest.label.toLowerCase()}.`,
    });
  }

  /*
   * 5. the best bucket. Only ever a COMPLETE bucket: today is still filling,
   * so crowning a part day as the best day would be a claim that tomorrow can
   * take away.
   */
  const complete = report.daily.buckets.filter((b) => !b.partial);
  if (complete.length > 1) {
    const best = complete.reduce((a, b) => (b.completed > a.completed ? b : a));
    if (best.completed > 0) {
      const weekly = report.daily.granularity === 'week';
      out.push({
        id: 'best',
        lead: `${formatCount(best.completed)} jobs completed`,
        rest: weekly ? ` in the week of ${dayLabel(best.from)}.` : ` on ${weekdayLabel(best.from)}.`,
      });
    }
  }

  return out.slice(0, 3);
}

/* mtd-report.service.js BLANK_CITY — the label for jobs that carry no city, as ../CityWiseSection names it. */
const BLANK_CITY = '(City not given)';

/**
 * How many NAMED cities finished at least one job.
 *
 * The '(City not given)' row is excluded, and that is v2's own rule: its city
 * set only takes a job whose city column resolved to something. "Completed
 * across 143 cities" is a sentence that goes to a client, and counting the
 * jobs whose city nobody recorded as a 144th city is the kind of small
 * overstatement that is very hard to explain afterwards.
 */
function citiesWithCompletions(cities: readonly MtdCityRow[]): number {
  return cities.filter((c) => c.completed > 0 && c.city !== BLANK_CITY).length;
}

/* Local formatters: derive.ts is pure and must not import the render kit. */
const EN_IN = new Intl.NumberFormat('en-IN');
const formatCount = (n: number) => EN_IN.format(n);
const pctText = (p: MtdPct) => (p.pct === null ? '–' : `${p.pct.toFixed(1)}%`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 'YYYY-MM-DD' → '22 Sep 2026'. Split, never parsed: no browser timezone can move the day. */
export function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/**
 * 'YYYY-MM-DD' → 'Monday, 22 Sep 2026', which is how v2 names its best day.
 *
 * Built through Date.UTC rather than `new Date(ymd)` so the weekday is the
 * one that calendar date has, not the one the viewer's offset drags it to.
 */
function weekdayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[day]}, ${dayLabel(ymd)}`;
}

/* ── the two day-wise blocks ──────────────────────────────────────────────── */

/**
 * One bucket of a day-wise block: the chart's row and the table's column at
 * once, so the two can never disagree about which days are in view.
 *
 * `trend` is the value again, or NULL on a part day. v2 draws its trend line
 * through the COMPLETE buckets only and lets it span the gap, which is why the
 * line is a second series rather than a stroke over the bars: a part day's bar
 * is honest about being short, and a trend line dipping to meet it would not
 * be.
 */
export type DayCell = {
  /** The bucket's first day, 'YYYY-MM-DD'. Unique, so it is the category key. */
  key: string;
  from: string;
  to: string;
  value: number;
  /**
   * The same bucket on the SECOND basis, or null when the block has only one.
   *
   * Only the completed block has one: those closures placed on their App
   * CheckIn day instead of their closure day. `value` and `alt` count the same
   * jobs on different days, so they do NOT have to agree bucket by bucket, and
   * their totals do not have to agree either.
   */
  alt: number | null;
  trend: number | null;
  partial: boolean;
};

export type DayBlock = {
  cells: DayCell[];
  total: number;
  /** The second basis's total over the same cells, or null when there is none. */
  altTotal: number | null;
};

/**
 * The cells of one day-wise block.
 *
 * v2 drops a part bucket that carries NO figure — a day that has begun but
 * holds nothing yet is a trailing empty column on a table and an empty band on
 * an axis, and it is not a day anyone is reporting on. A part bucket that does
 * carry work stays, marked, because those jobs are real.
 *
 * THE DROP TEST READS ALL THREE COUNTS, including the check-in one, and the
 * same test is applied whichever metric is asked for. Both of those follow v2,
 * whose `dailyRow` computes one bucket list and prints Created and Completed
 * over it — and they are also what keeps this block's own arithmetic honest: a
 * part day with a check-in completion but no closure would otherwise be
 * dropped, and the block's `altTotal` would then quietly fall short of
 * `completedOnCheckin.count`.
 *
 * The forecast is NOT here. It is the tab's own dashed extrapolation for the
 * chart above; the client document reports what happened, and a predicted day
 * has no place in a table of days that did.
 */
export function dayBlock(daily: MtdDaily, metric: 'created' | 'completed'): DayBlock {
  const empty = (b: MtdDaily['buckets'][number]) =>
    b.created === 0 && b.completed === 0 && b.completedCheckin === 0;

  const cells = daily.buckets
    .filter((b) => !(b.partial && empty(b)))
    .map<DayCell>((b) => {
      const value = metric === 'created' ? b.created : b.completed;
      return {
        key: b.from,
        from: b.from,
        to: b.to,
        value,
        alt: metric === 'completed' ? b.completedCheckin : null,
        trend: b.partial ? null : value,
        partial: b.partial,
      };
    });

  const total = cells.reduce((sum, c) => sum + c.value, 0);
  const altTotal = metric === 'completed'
    ? cells.reduce((sum, c) => sum + (c.alt ?? 0), 0)
    : null;
  return { cells, total, altTotal };
}

/* ── jobs by status and aging, the client document's cut ──────────────────── */

/**
 * The matrix rows the client document shows: COMPLETED AND OPEN, in that
 * order, and never Cancelled.
 *
 * v2 picks rows 0 and 2 of the same three-row matrix. The cancelled row is on
 * the MIS dashboard and in the Cancelled KPI; it is left out of the document
 * the client reads, which is the owner's editorial call and not something to
 * "fix" by restoring it here.
 *
 * Returns the rows the response actually carries, so a backend that stopped
 * sending one of them yields a shorter matrix rather than a row of undefined.
 */
export function clientAgingRows(statusAging: MtdStatusAging) {
  const wanted: ReadonlyArray<'completed' | 'open'> = ['completed', 'open'];
  return wanted
    .map((status) => statusAging.rows.find((r) => r.status === status))
    .filter((r): r is MtdStatusAging['rows'][number] => r != null);
}
