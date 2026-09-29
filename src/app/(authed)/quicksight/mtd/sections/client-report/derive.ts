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
 * SDA %. Two of those seven have no backend at all; see UNWIRED below.
 *
 * ⚠ THREE FIGURES THIS LAYOUT CANNOT HONESTLY FILL IN YET, and the rule that
 * governs them:
 *
 *   ESCALATED        v2 counts jobs with `Is Escalated = 1` in the export.
 *                    /mtd/report carries no such field.
 *   SDA %            v2 counts completed jobs with `SDA Status = 1`, over
 *                    completed — the same shape as TAT %. No such field.
 *   COMPLETED (DATE) v2 moved Completed onto the App CheckIn Date;
 *                    /mtd/report still counts it on the closure date. The
 *                    COUNT is real, the BASIS is the older one.
 *   TIER             "Open orders by tier and days open" needs the export's
 *                    Tier column, which /mtd/report does not read.
 *
 *   A missing figure is rendered as an explicit "Not wired yet" state and is
 *   NEVER rendered as 0, as an en dash, or as a number borrowed from a
 *   neighbouring metric. A zero here would be a claim that no job was
 *   escalated, which nobody has measured. The one figure that IS real but
 *   counted on the wrong date (Completed) keeps its number and carries a
 *   visible basis note instead — deleting a true count would be its own kind
 *   of lie.
 *
 * ⚠ THE AGING BANDS ARE THE MATRIX'S SIX, READ FROM THE RESPONSE. 0–3 / 4–5 /
 * 6–9 / 10–15 / 16–30 / over 30. They are NOT the four bands of the tab's
 * By Days Open card (0–2 / 3–5 / 6–9 / over 9), and no constant in this file
 * writes either list down — `statusAging.buckets` is the only source, exactly
 * as StatusAgingSection does it.
 */

import type {
  MtdCityRow,
  MtdDaily,
  MtdFilterOption,
  MtdPct,
  MtdReportResponse,
  MtdStatusAging,
} from '../../types';

/* ── the figures with no backend ──────────────────────────────────────────── */

/**
 * Why each unwired figure is unwired, in the words shown to the reader.
 *
 * Held as one map rather than scattered through the markup so that wiring one
 * of them is a deletion here plus a real value at the call site, and so the
 * gap list in a handover is this object.
 */
export const UNWIRED = {
  escalated:
    'Escalated has no backend field yet — the MIS reads Is Escalated from the export and /mtd/report does not carry it.',
  sdaPct:
    'SDA % has no backend field yet — the MIS reads SDA Status from the export and /mtd/report does not carry it.',
  tierAging:
    'Tier has no backend field yet — the MIS reads the export’s Tier column and /mtd/report does not carry it, so these open jobs cannot be split by tier here.',
} as const;

/**
 * The basis mismatch on Completed. Not an unwired figure — the count is real —
 * but the date it is counted on is not the one v2 asks for, and a reader
 * comparing this against the owner's Word file must be told that before they
 * file the difference as a bug.
 */
export const COMPLETED_BASIS_NOTE =
  'Counted on the closure date. The MIS v2 counts completed jobs on their App CheckIn Date, which /mtd/report does not read, so this figure and its chart can differ from the owner’s Word file by the jobs that checked in and closed on different days.';

/** The same caveat, said again beside the Jobs Completed chart without repeating the whole paragraph. */
export const COMPLETED_BASIS_SHORT =
  'These bars are jobs closed on each day. The MIS v2 plots them on their App CheckIn Date instead, so a job that checked in on one day and closed on the next sits in a different bar there.';

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
  trend: number | null;
  partial: boolean;
};

export type DayBlock = { cells: DayCell[]; total: number };

/**
 * The cells of one day-wise block.
 *
 * v2 drops a part bucket that has NEITHER figure — a day that has begun but
 * carries nothing yet is a trailing empty column on a table and an empty band
 * on an axis, and it is not a day anyone is reporting on. A part bucket that
 * does carry work stays, marked, because those jobs are real.
 *
 * The forecast is NOT here. It is the tab's own dashed extrapolation for the
 * chart above; the client document reports what happened, and a predicted day
 * has no place in a table of days that did.
 */
export function dayBlock(daily: MtdDaily, metric: 'created' | 'completed'): DayBlock {
  const cells = daily.buckets
    .filter((b) => !(b.partial && b.created === 0 && b.completed === 0))
    .map<DayCell>((b) => {
      const value = metric === 'created' ? b.created : b.completed;
      return {
        key: b.from,
        from: b.from,
        to: b.to,
        value,
        trend: b.partial ? null : value,
        partial: b.partial,
      };
    });
  return { cells, total: cells.reduce((sum, c) => sum + c.value, 0) };
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
