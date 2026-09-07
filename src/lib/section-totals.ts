/*
 * reconcileSectionTotals — do the per-section counts add up to the tab's total?
 *
 * WHY THIS EXISTS, TWICE OVER.
 *
 * 1. The sections once grouped only the page of rows the browser had already
 *    fetched. Five headings read 0 / 0 / 2 / 8 / 0 under a title saying "84
 *    matching orders": they summed to TEN, the page size. Plausible small
 *    numbers under a big total look exactly like real small numbers.
 *
 * 2. Then the CRM shipped to production ahead of the backend that implements
 *    `section=`. The backend validates with `stripUnknown: true`, so it DROPPED
 *    the unknown parameter instead of rejecting it, and every section ran the
 *    same unfiltered query. All five headings read 84 — against a total of 84.
 *    Nothing errored. Nothing logged.
 *
 * Both are invisible to any check of one section, and both are obvious the
 * instant you add the headings up. So the addition is done here, in one place,
 * and the answer is put on screen rather than in a console nobody reads.
 *
 * The second case has a SIGNATURE worth naming: when every section reports the
 * same number and that number is the tab total, the filter is not being applied
 * at all. That is a deployment problem, not a data problem, and saying so turns
 * a baffling screen into a one-line diagnosis.
 */

export type SectionTotals = {
  /** One entry per section; null means "not answered yet". */
  totals: Array<number | null>;
  /** The tab's own total, from an independent query. null while loading. */
  pageTotal: number | null;
};

export type Reconciliation =
  | { status: 'pending' }
  | { status: 'ok'; sum: number; pageTotal: number }
  | { status: 'mismatch'; sum: number; pageTotal: number; filterIgnored: boolean; message: string };

export function reconcileSectionTotals({ totals, pageTotal }: SectionTotals): Reconciliation {
  // Nothing to say until every section AND the independent total have answered.
  // Comparing early would flag a mismatch on every page load, and a warning that
  // cries wolf during loading is a warning people learn to ignore.
  if (pageTotal == null || !totals.length || totals.some((t) => t == null)) {
    return { status: 'pending' };
  }

  const nums = totals as number[];
  const sum = nums.reduce((a, b) => a + b, 0);
  if (sum === pageTotal) return { status: 'ok', sum, pageTotal };

  /*
   * Every section returning the identical tab total is the fingerprint of a
   * dropped filter — the same query ran N times. Requires more than one section
   * (with one, "all sections equal the total" is just a correct partition) and
   * a non-zero total (all-zero is an empty tab, not a skew).
   */
  const filterIgnored = nums.length > 1
    && pageTotal > 0
    && nums.every((t) => t === pageTotal);

  return {
    status: 'mismatch',
    sum,
    pageTotal,
    filterIgnored,
    message: filterIgnored
      ? `Every section is reporting the tab's full count (${pageTotal}), which means the `
        + 'server is ignoring the section filter — usually this page running ahead of a '
        + 'backend that does not implement it yet. The groupings below are not real.'
      : `Section counts add up to ${sum}, but this tab has ${pageTotal} matching orders. `
        + 'Some jobs are in no section, or in more than one.',
  };
}
