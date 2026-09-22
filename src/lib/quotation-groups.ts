/*
 * Material request flow v2 amendment (2026-09-22, owner) — each technician
 * "Send for Approval" now creates a separate QUOTATION (lines sharing one
 * sent_on); the backend stamps `quotation_no` (1..n, null for drafts) on
 * every row of GET /admin/quotations?jobId=. Shared by JobModal's
 * JobQuotationsTab and MaterialReviewModal so the two surfaces group
 * identically — see feedback_crm_ui_fetch_hooks-style "one place" rule.
 *
 * Grouping rules:
 *   - Ascending by quotation_no.
 *   - null AND undefined (older backend, pre-migration rows with no
 *     `quotation_no` column at all) collapse into ONE trailing group —
 *     never crash, never split into two "no group" buckets.
 *   - Line order within a group is stable (insertion order preserved).
 */

export type QuotationGroup<T> = {
  /** null = the draft / ungrouped bucket, rendered last. */
  quotationNo: number | null;
  rows: T[];
};

export function groupByQuotationNo<T extends { quotation_no?: number | string | null }>(
  rows: readonly T[],
): QuotationGroup<T>[] {
  const numbered = new Map<number, T[]>();
  const ungrouped: T[] = [];

  for (const row of rows) {
    const raw = row.quotation_no;
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n)) {
      const existing = numbered.get(n);
      if (existing) existing.push(row);
      else numbered.set(n, [row]);
    } else {
      ungrouped.push(row);
    }
  }

  const groups: QuotationGroup<T>[] = [...numbered.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([quotationNo, groupRows]) => ({ quotationNo, rows: groupRows }));

  if (ungrouped.length > 0) groups.push({ quotationNo: null, rows: ungrouped });

  return groups;
}
