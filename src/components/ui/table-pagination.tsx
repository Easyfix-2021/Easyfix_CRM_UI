'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { computePageView } from '@/lib/pagination';

/*
 * TablePagination — canonical footer for paginated tables.
 *
 * Layout (per design spec 2026-05-15):
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ Show: [10▾]              «  ‹  [ 3 ] / 12  ›  »            │
 *   └────────────────────────────────────────────────────────────┘
 *
 *   Left:  "Show:" + page-size dropdown {10 (default), 20, 50, All}
 *   Right: «  ‹  <editable page number>  /  <totalPages>  ›  »
 *
 * The page-size value 'all' is a sentinel string. Parents translate
 * it to whatever limit they need (we suggest a very high `limit` query
 * param like 100_000 rather than removing pagination entirely, so the
 * backend's LIMIT clause still caps a runaway query).
 *
 * Controlled component — the parent holds `page`, `pageSize`, and
 * `total`, so url-syncing, server fetching and reset-on-filter all
 * stay where they were and aren't duplicated inside this component.
 * (The only state here is the draft string in the page box, which is
 * transient editor state and never leaves.)
 *
 * ONE EXCEPTION, and it matters if you are relying on the callback:
 * `onPageChange` does NOT fire only from operator interaction. When the
 * parent hands us a `page` past the last page — what a filter that
 * shrinks the result set does — we fire it once, unprompted, with the
 * clamped index. See the effect below. A callback with a non-idempotent
 * side effect (an analytics event, an audit write) has to tolerate that.
 *
 * Page numbers are 0-INDEXED at the API boundary (offset = page *
 * pageSize) but DISPLAYED as 1-indexed inside the editable input,
 * matching what an operator expects to type.
 */

export type TablePageSize = 10 | 20 | 50 | 'all';
export const PAGE_SIZE_OPTIONS: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10,    label: '10' },
  { value: 20,    label: '20' },
  { value: 50,    label: '50' },
  { value: 'all', label: 'All' },
];

export function TablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
  className,
}: {
  /* 0-indexed page number (parent uses page * pageSize as offset). */
  page: number;
  pageSize: TablePageSize;
  total: number;
  onPageChange: (next: number) => void;
  /*
   * Page-size choices to offer. Defaults to all four. Narrow it when an option
   * cannot tell the truth on a given endpoint: 'all' renders as a single
   * un-navigable page whose range hint reads "Showing 1–<total> of <total>", so
   * on an endpoint whose `limit` caps BELOW the row count (e.g. /admin/calls
   * caps at 200) it both lies about what is on screen and strands the operator
   * with no way to reach later rows. Drop 'all' there.
   */
  pageSizeOptions?: ReadonlyArray<{ value: TablePageSize; label: string }>;
  /*
   * Fires with the new size. Parent is responsible for resetting
   * `page` to 0 — we don't reset here because some callers might
   * want to preserve position via offset-arithmetic on size change.
   * (The standard pattern is: `onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}`.)
   */
  onPageSizeChange: (next: TablePageSize) => void;
  className?: string;
}) {
  const isAll = pageSize === 'all';
  /*
   * `safePage` is `page` clamped into range. EVERYTHING below renders and
   * navigates from it, never from the raw prop — a page index past the last
   * page otherwise produces "Showing 21-1 of 1" and a box reading "3 / 1",
   * which is what a filter that shrinks the result set does to an operator
   * sitting on a later page. See lib/pagination.ts for the arithmetic.
   */
  const { totalPages, safePage, rangeStart, rangeEnd } = computePageView(page, pageSize, total);

  /*
   * Self-correct the PARENT when it hands us an out-of-range page.
   *
   * The clamp above only makes the footer coherent; the parent still holds the
   * stale index and still fetches with it, so the body stays empty under a
   * footer now confidently claiming "Showing 1-1 of 1" — a worse lie than the
   * obviously-broken "21-1". So we tell it once.
   *
   * In an effect, never in render: calling a parent's setState during render is
   * a side effect and re-enters. Here it cannot loop. The parent applies it,
   * `page` comes back equal to `safePage`, and the guard is false forever after.
   * A parent that IGNORES the callback doesn't loop either — nothing it renders
   * changed, so there is no second commit to run the effect again.
   *
   * The `total > 0` guard is load-bearing: a list mid-fetch reports total 0, and
   * clamping then would yank the operator off page 5 on every refresh. It does
   * mean the correction is NOT unconditional — on a genuine empty result the
   * parent keeps its stale index, uncorrected, until the next non-empty total.
   * That is the deliberate trade: there is nothing to render either way, and
   * guessing which zero is which would cost the common case.
   *
   * This is defence in depth, not the fix. Pages should still reset to page 0 in
   * the handler that changes the filter, so the stale fetch never fires at all.
   */
  React.useEffect(() => {
    if (total > 0 && page !== safePage) onPageChange(safePage);
  }, [page, safePage, total, onPageChange]);

  /*
   * Editable page number. We track a draft string while the operator
   * is typing so they can blank the field and re-type, then commit
   * on Enter or blur. Clamping happens at commit time — typing "99"
   * with totalPages=12 lands on page 12.
   */
  const [draft, setDraft] = React.useState<string>(String(safePage + 1));
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    /*
     * Not while the operator is typing in this box. Keyed on `safePage` rather
     * than `page`, this effect now also fires when `total` alone moves — a poll
     * or a sibling refetch shrinking the page count re-clamps and would replace
     * a half-typed "7" with "2" before Enter. Their draft wins until they
     * commit or blur, at which point commitDraft() clamps it anyway.
     */
    if (inputRef.current && document.activeElement === inputRef.current) return;
    setDraft(String(safePage + 1));
  }, [safePage]);

  function commitDraft() {
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(safePage + 1));
      return;
    }
    const oneIndexed = Math.max(1, Math.min(totalPages, Math.floor(n)));
    const zeroIndexed = oneIndexed - 1;
    if (zeroIndexed !== page) onPageChange(zeroIndexed);
    setDraft(String(oneIndexed));
  }

  const first = 0;
  const last = totalPages - 1;
  const prevDisabled = isAll || safePage <= first;
  const nextDisabled = isAll || safePage >= last;

  return (
    <div
      className={cn(
        'flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm',
        className,
      )}
    >
      {/* LEFT — page-size dropdown + range hint. Native <select> for
          density — a SearchSelect popover would be overkill for 4 fixed
          options. The hint ("Showing 11–20 of 234") is muted so the
          control is the visual primary. */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Show:</span>
          <select
            value={String(pageSize)}
            onChange={(e) => {
              const v = e.target.value;
              const next: TablePageSize = v === 'all' ? 'all' : (Number(v) as TablePageSize);
              onPageSizeChange(next);
            }}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus-visible:border-foreground/40"
          >
            {pageSizeOptions.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
            ))}
          </select>
        </label>
        {total > 0 && (
          <span className="text-xs text-muted-foreground">
            Showing {rangeStart.toLocaleString('en-IN')}–{rangeEnd.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}
          </span>
        )}
      </div>

      {/* RIGHT — page navigation. «  ‹  [N] / total  ›  »
          Disabled state uses opacity + cursor-not-allowed so the
          control still feels clickable when allowed and explicitly
          inactive when not. The page input is `inputMode="numeric"`
          so mobile keyboards default to digits. */}
      <div className="flex items-center gap-1">
        <NavBtn onClick={() => onPageChange(first)} disabled={prevDisabled} label="First page">
          <ChevronsLeft className="h-4 w-4" />
        </NavBtn>
        <NavBtn onClick={() => onPageChange(safePage - 1)} disabled={prevDisabled} label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </NavBtn>
        <div className="flex items-center gap-1 px-1 text-sm">
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDraft();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                setDraft(String(safePage + 1));
                (e.target as HTMLInputElement).blur();
              }
            }}
            disabled={isAll}
            aria-label="Page number"
            className="h-8 w-12 rounded-md border border-input bg-background px-2 text-center text-sm tabular-nums focus:outline-none focus-visible:border-foreground/40 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <span className="text-muted-foreground">/</span>
          <span className="tabular-nums">{totalPages.toLocaleString('en-IN')}</span>
        </div>
        <NavBtn onClick={() => onPageChange(safePage + 1)} disabled={nextDisabled} label="Next page">
          <ChevronRight className="h-4 w-4" />
        </NavBtn>
        <NavBtn onClick={() => onPageChange(last)} disabled={nextDisabled} label="Last page">
          <ChevronsRight className="h-4 w-4" />
        </NavBtn>
      </div>
    </div>
  );
}

/*
 * Internal nav button — kept compact and visually consistent with the
 * tightened action-button style used in row Actions cells. Plain
 * <button> instead of <Button> so we don't pick up the ghost variant's
 * px-3 + hover bg, which made the prev/next cluster look spread out.
 */
function NavBtn({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      /*
       * No persistent border/background — the cluster used to look
       * like five competing buttons. Plain icon now, hover reveals a
       * subtle muted bg + ring so the affordance is still discoverable
       * but the resting state reads as a single nav group.
       */
      className={cn(
        'h-8 w-8 inline-flex items-center justify-center rounded-md',
        'text-muted-foreground hover:text-foreground hover:bg-muted',
        'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground disabled:cursor-not-allowed',
        'transition-colors',
      )}
    >
      {children}
    </button>
  );
}

/*
 * Helper for parents that need to translate `pageSize` into a backend
 * `limit` query param.
 *
 * 'all' becomes `maxLimit` (default 1000) — the highest value most
 * admin list endpoints' Joi validators accept (`Joi.number().max(1000)`).
 * Passing 100_000 like the original implementation did would fail
 * validation across the board. Callers whose endpoint caps lower
 * (e.g. `/admin/jobs` caps at 500, `/admin/customers` at 500, the
 * generic auxiliary lookups at 5000) should pass their endpoint's
 * actual cap explicitly so the FE "All" maps to that endpoint's true
 * maximum without 400ing.
 *
 * Worth noting: "All" is a soft cap — for tables that have millions
 * of rows (jobs table at ~384k), even maxLimit=500 can't truly show
 * everything. The label still reads "All" because operators rarely
 * scroll past the first thousand rows in a table view; they filter
 * down to what they actually want.
 */
export function pageSizeToLimit(pageSize: TablePageSize, maxLimit = 1000): number {
  return pageSize === 'all' ? maxLimit : pageSize;
}
