'use client';

/*
 * CallInfoModal — date-ranged call history viewer.
 *
 * Triggered from the navbar's "Call Info" button on the Dashboard /
 * Manage Jobs pages (RBAC-gated by `isCallInfo`). UX behaviour
 * (2026-05-14 ops update):
 *
 *   1. Opens with both From/To = today and IMMEDIATELY fetches that
 *      day's call history so the operator sees data on first paint.
 *   2. Date controls are merged into a single DateRangePopover
 *      (calendar with range selection, future dates locked).
 *   3. Mobile filter is gone from the form. Instead, once a result
 *      table is on screen, a free-text search input above the table
 *      filters rows by ANY column value (caseless substring) —
 *      simpler than picking which column to search.
 *
 * Backed by `tbl_exotel_call_log`. EXOTEL_ENABLED is 'false' in
 * production so the table is usually empty for fresh data; historical
 * rows still render, and the empty-state is friendly.
 */

import * as React from 'react';
import { Phone, Search, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DownloadButton } from '@/components/ui/download-button';
import { Label } from '@/components/ui/label';
import { DateRangePopover } from '@/components/ui/date-range-popover';
import { JobModal } from '@/components/job/JobModal';
import { api, ApiError } from '@/lib/api';
import { statusLabel, statusColorClass } from '@/lib/utils';

/*
 * Row shape mirrors `tbl_easyfixer_call_record` plus joined display
 * columns from tbl_easyfixer, tbl_job, tbl_customer. The DB row may
 * carry additional columns (we SELECT cr.* on the backend) — extras
 * are ignored here. `[key: string]: unknown` makes the index-access
 * lookup in the search-filter type-safe without enumerating every
 * possible column.
 */
type CallRow = {
  efr_id?: number | null;
  job_id?: number | null;
  insert_date_time?: string | null;
  // Joined-in display fields:
  efr_name?: string | null;
  efr_no?: string | null;
  job_status?: number | string | null;
  job_type?: string | null;
  job_customer_name?: string | null;
  customer_name?: string | null;
  customer_mob_no?: string | null;
  [key: string]: unknown;
};

type CallResp = { items: CallRow[]; total: number; note?: string };

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatCallTime(v: string | null | undefined): string {
  if (!v) return '—';
  try {
    const d = new Date(v);
    if (Number.isNaN(+d)) return String(v);
    return d.toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return String(v); }
}

export function CallInfoModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const today = todayIso();
  const [from, setFrom] = React.useState<string>(today);
  const [to, setTo]     = React.useState<string>(today);
  const [rows, setRows] = React.useState<CallRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr]   = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  // Table-level search — filters the in-memory `rows` after the API
  // fetch. Cleared on every new fetch so a stale query doesn't carry
  // across date-range refreshes.
  const [search, setSearch] = React.useState<string>('');
  // Download spinner state — independent of `loading` so the operator
  // can trigger an export while staring at a previously-fetched table.
  const [downloading, setDownloading] = React.useState(false);
  /*
   * Inline job-view state. Clicking a Job ID row opens a stacked
   * JobModal in 'view' mode on top of this Call Info modal — same
   * pattern as CustomerHistoryDialog. Operator can peek at a job's
   * details and come back to the call history without leaving the
   * page. Native Radix Dialog z-index handles the stacking.
   */
  const [viewJobId, setViewJobId] = React.useState<number | null>(null);
  /*
   * Sort state for the call-history table.
   *
   * Default: most-recent calls first (matches the backend's
   * `ORDER BY cr.insert_date_time DESC`). Clicking a column header
   * sets it as the sort key — re-clicking the SAME header flips the
   * direction; clicking a DIFFERENT header switches the key and
   * resets direction to ascending. The header chrome shows three
   * states (active-asc / active-desc / inactive) via lucide icons.
   *
   * Sort is purely client-side over `filteredRows` so it composes
   * cleanly with the search box.
   */
  type SortKey =
    | 'insert_date_time' | 'efr_name' | 'efr_no' | 'job_id'
    | 'customer' | 'customer_mob_no' | 'job_type' | 'job_status';
  type SortDir = 'asc' | 'desc';
  const [sortBy, setSortBy] = React.useState<SortKey>('insert_date_time');
  const [sortDir, setSortDir] = React.useState<SortDir>('desc');
  function toggleSort(key: SortKey) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
  }

  // Auto-fetch on open. Always reset to today's range so a re-open
  // after an old fetch starts from a clean default.
  React.useEffect(() => {
    if (!open) return;
    const t = todayIso();
    setFrom(t);
    setTo(t);
    setSearch('');
    // Kick off the today's-calls fetch right away — the operator
    // shouldn't have to click "Fetch" to see today's call log.
    void doFetch(t, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function doFetch(fromDate: string, toDate: string) {
    setLoading(true); setErr(null); setNote(null); setSearch('');
    try {
      const resp = await api.get<CallResp>('/admin/call-info', {
        fromDate, toDate,
      });
      setRows(Array.isArray(resp.items) ? resp.items : []);
      setNote(resp.note || null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load call history');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void doFetch(from, to);
  }

  /*
   * Download the current range as a styled XLSX. We can't use the
   * standard `api.get` helper (which JSON-parses every response), so
   * we do a focused fetch + blob conversion + programmatic anchor
   * click. Honours the same Bearer-token + credentials handling so
   * the export endpoint sees an authenticated request.
   *
   * Filter note: the download contains every row in the requested
   * RANGE, not only rows currently visible after the in-table
   * search. The search box is a presentational filter; exports
   * should reflect the dataset the operator asked the backend for.
   */
  async function downloadXlsx() {
    if (downloading) return;
    setDownloading(true);
    setErr(null);
    try {
      const base = process.env.NEXT_PUBLIC_API_URL || '/api';
      const qs = new URLSearchParams({ fromDate: from, toDate: to });
      const url = `${base}/admin/call-info/export.xlsx?${qs.toString()}`;
      const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
      const resp = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
      if (!resp.ok) {
        // Try to surface a meaningful error message from a JSON error
        // payload; fall back to the HTTP status.
        let msg = `HTTP ${resp.status}`;
        try {
          const j = await resp.json();
          if (j?.error) msg = String(j.error);
        } catch { /* not JSON, ignore */ }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `call-history_${from}_to_${to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Release the blob URL after a brief tick so the click can
      // resolve into a download in all browsers.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
    } catch (e) {
      setErr(e instanceof Error ? `Download failed: ${e.message}` : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  // Caseless substring match across every displayed column. Cheap
  // for our 500-row cap. Customer & technician fields are stringified
  // alongside the formatted call time so searches like "9310" or
  // "lenskart" or "13 May" all just work.
  const filteredRows = React.useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      // Include the HUMAN status label in the searchable haystack
      // (not just the raw integer) so typing "completed" / "unconfirmed"
      // narrows correctly to the matching status rows.
      const statusText = r.job_status != null && r.job_status !== ''
        ? statusLabel(Number(r.job_status))
        : '';
      const hay = [
        formatCallTime(r.insert_date_time),
        r.efr_name, r.efr_no,
        r.job_id,
        r.customer_name || r.job_customer_name,
        r.customer_mob_no,
        r.job_type, statusText,
      ].map((x) => String(x ?? '').toLowerCase()).join(' ');
      return hay.includes(q);
    });
  }, [rows, search]);

  /*
   * Sort the filtered list. Comparator strategy varies by column
   * type so dates, numbers and strings each sort the way the
   * operator expects rather than via a single string-LC fallback:
   *   - insert_date_time → epoch ms (chronological).
   *   - job_id           → numeric (numeric IDs).
   *   - customer         → falls back to job_customer_name when
   *                        tbl_customer didn't join (matches what
   *                        the UI actually displays).
   *   - job_status       → human label via statusLabel(), so the
   *                        sort order matches the visible pill text.
   *   - everything else  → case-insensitive locale string compare.
   */
  const sortedRows = React.useMemo(() => {
    if (!filteredRows) return null;
    const copy = filteredRows.slice();
    const dir = sortDir === 'asc' ? 1 : -1;
    copy.sort((a, b) => {
      let va: string | number | null = null;
      let vb: string | number | null = null;
      switch (sortBy) {
        case 'insert_date_time': {
          va = a.insert_date_time ? new Date(String(a.insert_date_time)).getTime() : 0;
          vb = b.insert_date_time ? new Date(String(b.insert_date_time)).getTime() : 0;
          return ((va as number) - (vb as number)) * dir;
        }
        case 'job_id': {
          va = Number(a.job_id) || 0;
          vb = Number(b.job_id) || 0;
          return ((va as number) - (vb as number)) * dir;
        }
        case 'customer':
          va = String(a.customer_name || a.job_customer_name || '').toLowerCase();
          vb = String(b.customer_name || b.job_customer_name || '').toLowerCase();
          break;
        case 'job_status':
          va = a.job_status != null && a.job_status !== '' ? statusLabel(Number(a.job_status)).toLowerCase() : '';
          vb = b.job_status != null && b.job_status !== '' ? statusLabel(Number(b.job_status)).toLowerCase() : '';
          break;
        default:
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          va = String((a as any)[sortBy] ?? '').toLowerCase();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          vb = String((b as any)[sortBy] ?? '').toLowerCase();
      }
      if (va < vb) return -1 * dir;
      if (va > vb) return  1 * dir;
      return 0;
    });
    return copy;
  }, [filteredRows, sortBy, sortDir]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* `overflow-hidden` intentionally OMITTED on DialogContent so
          the DateRangePopover (an absolute child inside the form) can
          extend visually past the modal's bottom edge without
          clipping. The inner table section retains its own
          `overflow-y-auto` so the call-history table still scrolls
          inside the modal. Keeping the popover in the modal's DOM
          tree (no portal) means Radix's outside-click detector
          correctly treats popover clicks as "inside the modal" —
          previous portalled approach broke this and required brittle
          onPointerDownOutside overrides. */}
      {/* `gap-0` cancels the shared DialogContent's built-in `gap-4`
          (a 16 px flex/grid gap baked into the primitive). Without
          this override, every direct child of DialogContent — header,
          form, scrollable body, footer — gets an extra 16 px breathing
          room injected between it and the next, which produced the
          mysterious empty band above the Date Range label and below
          the form. Our own padding on each section owns the spacing. */}
      <DialogContent className="!max-w-[1000px] w-[95vw] max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="!mx-0 !mt-0 px-6 pt-6 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" />
            Call Info
            <span className="text-sm font-normal text-muted-foreground">
              · Date-Ranged Call History
            </span>
          </DialogTitle>
        </DialogHeader>

        {/* Tight top padding (`pt-2`) — earlier `pt-4` left a visibly
            empty band between the header border and the Date Range
            label. Header itself already has pb-3, which gives
            enough breathing room. */}
        <form onSubmit={onSubmit} className="px-6 pt-2 pb-3 border-b bg-muted/20">
          {/* Single merged range picker (replaces the previous two
              date inputs + mobile box). Defaults to today/today;
              `maxDate` defaults to today inside the popover so future
              dates are unreachable. Fetch + Download share the right
              column — Download streams a styled XLSX for the current
              range from /admin/call-info/export.xlsx. */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3 items-end">
            <div>
              <Label className="text-xs">Date Range *</Label>
              <DateRangePopover
                from={from}
                to={to}
                onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }}
              />
            </div>
            <div>
              <Button type="submit" disabled={loading} className="md:w-auto w-full h-9">
                {loading ? 'Fetching…' : 'Fetch Calls'}
              </Button>
            </div>
            <div>
              {/*
                * Download disabled when there's nothing to export.
                * `rows === null` covers the pre-first-fetch state; an
                * empty array covers a successful fetch that returned
                * zero calls. Either way clicking download would
                * produce an empty workbook, which is busywork. The
                * title attribute explains the disabled state on hover.
                */}
              {(() => {
                const hasRows = !!rows && rows.length > 0;
                /*
                 * DownloadButton internally disables while
                 * `downloading` is true, so we only need to pass
                 * `disabled` for the business-state reasons (no rows
                 * yet, or a fetch is already in flight blocking the
                 * action). The component handles the loading state.
                 */
                return (
                  <DownloadButton
                    onClick={() => { void downloadXlsx(); }}
                    disabled={loading || !hasRows}
                    downloading={downloading}
                    title={
                      !hasRows
                        ? 'No calls in the selected range to download'
                        : 'Download the current range as a styled Excel sheet'
                    }
                  />
                );
              })()}
            </div>
          </div>
        </form>

        {/*
          * Search band — sits OUTSIDE the scrollable container so it
          * stays visible while the operator scrolls the table. Holds
          * the inline error / dev-note banners plus the search input
          * (whichever apply). Renders nothing when there's nothing
          * meaningful to show, so it doesn't take up space during
          * loading / empty-result states.
          */}
        {(err || note || (rows !== null && rows.length > 0)) && (
          <div className="px-6 pt-2 pb-2 shrink-0">
            {err && (
              <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 mb-2">
                {err}
              </div>
            )}
            {note && (
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">
                {note}
              </div>
            )}
            {rows !== null && rows.length > 0 && (
              /* Search input — filters the table below by caseless
                 substring across every displayed column. Only renders
                 when there are rows to search. */
              <div className="flex items-center gap-2">
                <div className="relative flex-1 max-w-sm">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search"
                    className="pl-7 h-8"
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  {search
                    ? `${sortedRows?.length ?? 0} of ${rows.length}`
                    : `${rows.length} call${rows.length === 1 ? '' : 's'}`}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Scrollable table region. The search/error band above is
            anchored in place; only the table content scrolls inside
            this container.
            `min-h-0` is mandatory on a flex-1 child that contains an
            overflow-auto, otherwise the child sizes to its natural
            content height and the scrollbar never appears.
            `overflow-auto` handles BOTH vertical (table is long) and
            horizontal (table is wider than modal) scrolling — merged
            into THIS container so the sticky <th> cells anchor
            against the actual vertical scroller rather than an inner
            overflow-x wrapper.
            `pt-0` is deliberate: `position: sticky; top: 0` pins
            relative to the content box (inside the padding). Any
            padding-top here becomes a strip rows scroll THROUGH
            before they hit the header — visible as a sliver of data
            peeking out above the sticky header. The search band
            above already provides the visual gap via `pb-2`. */}
        <div className="flex-1 min-h-0 overflow-auto px-6 pt-0 pb-4">
          {loading && rows === null && (
            <div className="text-sm text-muted-foreground py-8 text-center">Loading today&apos;s calls…</div>
          )}

          {rows !== null && rows.length === 0 && !loading && (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No calls found for the selected range.
            </div>
          )}

          {rows !== null && rows.length > 0 && (
            /* No inner overflow-x-auto wrapper here — the outer
               `overflow-auto` on the parent owns both axes so sticky
               <th> anchors against the actual vertical scroller. */
            <table className="w-full text-sm data-table">
                  <thead>
                    {/* `sticky top-0` keeps the header row pinned
                        inside the scrollable container as rows scroll
                        underneath. Cells (not just `<thead>`) carry
                        the sticky + bg classes because not every
                        browser respects sticky on `<thead>`. Solid
                        `bg-slate-100` so the rows don't show through
                        (semi-transparent `bg-muted/50` would let the
                        white row underneath bleed). z-10 keeps
                        headers above the row content during scroll. */}
                    <tr className="text-xs">
                      {([
                        { key: 'insert_date_time', label: 'Call Time' },
                        { key: 'efr_name',         label: 'Easyfixer' },
                        { key: 'efr_no',           label: 'Easyfixer Mobile' },
                        { key: 'job_id',           label: 'Job ID' },
                        { key: 'customer',         label: 'Customer' },
                        { key: 'customer_mob_no',  label: 'Customer Mobile' },
                        { key: 'job_type',         label: 'Job Type' },
                        { key: 'job_status',       label: 'Job Status' },
                      ] as Array<{ key: SortKey; label: string }>).map((c) => {
                        const isActive = sortBy === c.key;
                        return (
                          <th
                            key={c.key}
                            scope="col"
                            className="sticky top-0 z-10 bg-slate-100 text-left px-3 py-2 font-medium border-b"
                          >
                            {/* Whole header is a button so the entire
                                cell area is the click target — easier
                                to hit than a tiny chevron. Cursor +
                                hover tint signal interactivity. */}
                            <button
                              type="button"
                              onClick={() => toggleSort(c.key)}
                              className="w-full flex items-center gap-1 hover:text-foreground select-none cursor-pointer"
                              title={`Sort by ${c.label}`}
                            >
                              <span>{c.label}</span>
                              {isActive ? (
                                sortDir === 'asc'
                                  ? <ChevronUp className="h-3 w-3 text-sky-700" />
                                  : <ChevronDown className="h-3 w-3 text-sky-700" />
                              ) : (
                                <ChevronsUpDown className="h-3 w-3 opacity-30" />
                              )}
                            </button>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {(sortedRows || []).map((r, i) => {
                      const customerName = r.customer_name || r.job_customer_name || '';
                      return (
                        <tr key={`${r.job_id ?? ''}-${r.efr_id ?? ''}-${i}`} className="border-t hover:bg-muted/30">
                          <td className="px-3 py-2 whitespace-nowrap">{formatCallTime(r.insert_date_time)}</td>
                          <td className="px-3 py-2">{r.efr_name || '—'}</td>
                          <td className="px-3 py-2 font-mono text-xs">{r.efr_no || '—'}</td>
                          <td className="px-3 py-2 font-mono text-xs">
                            {r.job_id ? (
                              /* Inline view: open a stacked JobModal
                                 in view mode on the same page rather
                                 than navigating away. Plain button
                                 (not <a>) so middle-click / cmd-click
                                 don't carry the operator off to a new
                                 tab — the link is purely a same-modal
                                 drilldown. */
                              <button
                                type="button"
                                onClick={() => setViewJobId(Number(r.job_id))}
                                className="text-sky-700 hover:underline"
                                title="View job details"
                              >
                                {String(r.job_id)}
                              </button>
                            ) : '—'}
                          </td>
                          <td className="px-3 py-2">{customerName || '—'}</td>
                          <td className="px-3 py-2 font-mono text-xs">{r.customer_mob_no || '—'}</td>
                          <td className="px-3 py-2">{r.job_type || '—'}</td>
                          <td className="px-3 py-2">
                            {/* Status renders as a coloured pill — same
                                visual treatment as /jobs and dashboard
                                so operators recognise the buckets at a
                                glance. Empty when job_status isn't set
                                on the joined row. */}
                            {r.job_status != null && r.job_status !== '' ? (
                              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColorClass(Number(r.job_status))}`}>
                                {statusLabel(Number(r.job_status))}
                              </span>
                            ) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                    {sortedRows && sortedRows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-3 py-6 text-center text-sm text-muted-foreground">
                          No rows match &ldquo;{search}&rdquo;.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
          )}
        </div>

        {/* Plain <div> footer instead of the shared <DialogFooter>.
            DialogFooter ships with default `-mx-6 -mb-6` negative
            margins so its top border can run edge-to-edge of a
            standard p-6 DialogContent. Since this modal uses p-0
            (the inner sections handle their own padding), those
            negatives would push the footer OUTSIDE the modal box —
            same workaround EscalatedJobsModal already uses. */}
        <div className="px-6 py-3 border-t bg-muted/30 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
      {/* Stacked job-view modal — opens when the operator clicks a
          Job ID in the call-history table. Closing it returns to the
          Call Info modal without disturbing the date range or table
          state behind. Same pattern as CustomerHistoryDialog inside
          JobModal. */}
      <JobModal
        open={viewJobId != null}
        mode="view"
        jobId={viewJobId ?? undefined}
        onClose={() => setViewJobId(null)}
      />
    </Dialog>
  );
}
