'use client';

/*
 * ClickToCallTab — outbound CRM-initiated call history.
 *
 * Sibling tab to the existing Easyfixer-side view inside CallInfoModal.
 * Backed by GET /admin/calls (tbl_job_caller_info) — these are the rows
 * that the new CallButton flow inserts and the 4-hour Kaleyra report
 * cron fills in with duration/recording/status.
 *
 * Kept as a separate component so the parent modal doesn't balloon. The
 * date range is owned by the parent and threaded in via props so both
 * tabs share the operator's chosen window.
 *
 * PAGINATION (2026-07-30): this used to pull ONE window of up to 200 rows and
 * filter it in memory, so the endpoint's Joi cap was a functional ceiling — a
 * busy day past 200 calls was simply unreachable without shrinking the date
 * range. It now drives the endpoint's real server-side pagination (page +
 * limit, `total` off the response) through the shared <TablePagination>, the
 * same wiring Settings → Call Analytics uses against this very endpoint.
 *
 * Two consequences of that, both deliberate:
 *
 *  1. The fetch moved from a hand-rolled `useEffect` + `api.get` to the shared
 *     `useFetch` hook keyed on the query string (the mandatory pattern — see
 *     lib/hooks.ts). Paging keeps the previous rows mounted (`refreshing`, not
 *     `loading`), so stepping through pages doesn't flash a "Loading…" panel.
 *
 *  2. The free-text box is now explicitly a PAGE filter, not a search. GET
 *     /admin/calls has no free-text parameter to push it to: its filters are
 *     jobId / customerId / mobile / flow / callerId / hasAnalysis / minScore
 *     (validators/calls.validator.js → callListQuery), and `mobile` only
 *     matches a COMPLETE 10-digit number (the route drops anything shorter,
 *     silently) — which an operator can't even type here, because the Customer
 *     Mobile column is masked. Names, statuses and unique_ids — the things this
 *     box actually matches — are not searchable server-side at all. So it stays
 *     client-side and SAYS SO ("Filter This Page"): a box labelled "Search"
 *     that quietly covered only 1 page of N would be a lie. Reach for the range
 *     + page size to widen what's on screen, then filter it.
 *
 * CONFERENCES (2026-08-06): a call that gained people is still ONE row here and
 * counts as ONE call. Its extra legs appear as a detail row underneath, and
 * their names/roles are matched by the page filter, so filtering for a
 * technician finds the call they were conferenced into.
 */

import * as React from 'react';
import { Phone, Filter, PlayCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { InfoTooltip } from '@/components/ui/tooltip';
import { useFetch } from '@/lib/hooks';
import { maskMobile } from '@/lib/format';
import { callLegSearchText, groupCallRows, type CallLeg } from '@/lib/call-legs';
import { CallLegsRow, ConferenceBadge } from '@/components/calls/CallLegList';
import { TablePagination, PAGE_SIZE_OPTIONS, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';

type CallRow = {
  id: number;
  job_id: number | null;
  unique_id: string | null;
  caller: string | null;
  caller_id: number | null;
  caller_name: string | null;
  receiver: string | null;
  receiver_id: number | null;
  receiver_name: string | null;
  call_type: string | null;
  start_time: string | null;
  end_time: string | null;
  duration: number | null;
  caller_status: string | null;
  receiver_status: string | null;
  recording: string | null;
  location: string | null;
  provider: string | null;
  inserted_time: string | null;
  is_updated: number | null;
  transcription_status?: string | null;
  /** Conference legs — see lib/call-legs.ts. Absent on an ordinary 1:1 call. */
  conference_id?: number | null;
  legs?: CallLeg[] | null;
};

type ListResp = { total: number; page: number; limit: number; items: CallRow[] };

// The <thead> below. Used by the legs' full-width detail row, so a new column
// cannot leave the conference block short of the table's width.
const CALL_COLUMNS = [
  'Call Time', 'Agent', 'Customer', 'Customer Mobile',
  'Job #', 'Duration', 'Status', 'Recording', 'Transcript',
];

// BE Joi cap on GET /admin/calls `limit` is 200 (validators/calls.validator.js
// → callListQuery). It is handed to `pageSizeToLimit` as that helper's explicit
// `maxLimit` so the page-size selector's "All" option maps to 200 rather than
// the helper's 1000 default — 1000 on this endpoint is a hard 400 ("limit must
// be less than or equal to 200"), not a silent clamp. Raise this ONLY together
// with the Joi max.
const CALL_LIST_LIMIT_CAP = 200;

/*
 * Page sizes offered here — deliberately WITHOUT "All".
 *
 * "All" cannot tell the truth on this endpoint. It maps to limit=200 (the Joi
 * cap), but <TablePagination> renders 'all' as ONE page: the footer reads
 * "Showing 1–<total> of <total>" with every nav control disabled. On a range of
 * 5,000 calls that claims 5,000 rows are on screen when 200 are, contradicts the
 * cap notice, AND leaves rows 201+ unreachable — the operator has to change page
 * size to escape. 10/20/50 page through the whole range honestly, so "All" was
 * strictly worse than every other option. Never raise a size above
 * CALL_LIST_LIMIT_CAP: the BE returns a hard 400, not a silent clamp.
 */
const CALL_PAGE_SIZE_OPTIONS = PAGE_SIZE_OPTIONS.filter((o) => o.value !== 'all');

function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(+d)) return String(v);
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// maskMobile lives in '@/lib/format' — see import block above. The
// idempotency check in the shared helper means it composes safely with
// the /admin/* BE masking middleware (which already masked `receiver`
// on this endpoint before it reached us).

function fmtDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function ClickToCallTab({ from, to }: { from: string; to: string }) {
  // 0-indexed page + shared page-size sentinel, exactly as Settings → Call
  // Analytics drives this same endpoint. The backend list is 1-indexed, so the
  // query sends `page + 1`.
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  // Client-side filter over the CURRENT PAGE only — see the header comment for
  // why it can't be pushed to the server, and the label that says so.
  const [pageFilter, setPageFilter] = React.useState<string>('');

  // A changed date window is a different dataset: go back to page 1 and drop a
  // filter that was typed against the old rows. State-only effect — the fetch
  // itself is declarative (the `useFetch` key below), so nothing here fires a
  // request.
  React.useEffect(() => {
    setPage(0);
    setPageFilter('');
  }, [from, to]);

  const limit = pageSizeToLimit(pageSize, CALL_LIST_LIMIT_CAP);
  /*
   * The request key. `null` until the parent has a range, which keeps `useFetch`
   * idle rather than firing a rangeless query.
   *
   * The backend treats dateTo as an exclusive upper bound (< ?), so the picker's
   * end-of-day is pushed forward one day to make the range inclusive of `to`.
   */
  const listKey = React.useMemo(() => {
    if (!from || !to) return null;
    const toExclusive = new Date(to);
    toExclusive.setDate(toExclusive.getDate() + 1);
    const qs = new URLSearchParams({
      dateFrom: from,
      dateTo:   toExclusive.toISOString().slice(0, 10),
      page:     String(page + 1),
      limit:    String(limit),
    });
    return `/admin/calls?${qs.toString()}`;
  }, [from, to, page, limit]);

  const { data, loading, error } = useFetch<ListResp>(listKey);

  /*
   * `data == null` is "nothing loaded yet" (first paint / idle); once a response
   * lands, `items` is the CURRENT PAGE and `total` the whole range.
   *
   * Grouped before anything counts or renders them: the jci⋈pcl join behind this
   * endpoint is 1:N now, so an ungrouped page would list a 3-party conference
   * three times and the "N of M On This Page" figure beside the filter box would
   * count it three times too.
   *
   * `total` is NOT adjusted here and must not be — it is the server's count for
   * the whole RANGE, and the duplicates of a call may well sit on another page.
   * Only the endpoint can count that correctly; this is a rendering guard, not a
   * substitute for the fix.
   */
  const rows = React.useMemo(() => (data?.items ? groupCallRows(data.items) : null), [data?.items]);
  const total = data?.total ?? 0;

  const filteredRows = React.useMemo(() => {
    if (!rows) return null;
    const q = pageFilter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [
        fmtDateTime(r.inserted_time),
        r.caller_name, r.caller,
        r.receiver_name, r.receiver,
        r.job_id,
        r.caller_status, r.receiver_status,
        r.unique_id,
      ].map((x) => String(x ?? '').toLowerCase()).join(' ');
      // Everyone who was on the call, not just the party it was placed to —
      // otherwise a technician conferenced in is unfindable by name on a page
      // that is visibly showing them.
      return hay.includes(q) || callLegSearchText(r).includes(q);
    });
  }, [rows, pageFilter]);

  return (
    <>
      {/* Top band: page filter + counts, mirrors the existing tab's UX so the
          two tabs feel coherent to switch between. */}
      {(error || (rows !== null && rows.length > 0)) && (
        <div className="px-6 pt-2 pb-2 shrink-0">
          {error && (
            <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 mb-2">
              {error}
            </div>
          )}
          {rows !== null && rows.length > 0 && (
            <div className="flex items-center gap-2">
              {/* Filter (not search) icon + "Filter This Page" placeholder:
                  the control's scope is the rows on screen, and every part of
                  its chrome says the same thing. */}
              <div className="relative flex-1 max-w-sm">
                <Filter className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  type="search"
                  value={pageFilter}
                  onChange={(e) => setPageFilter(e.target.value)}
                  placeholder="Filter This Page"
                  aria-label="Filter This Page"
                  title="Filters only the calls listed on this page — it does not search the whole date range."
                  className="pl-7 h-8"
                />
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>
                  {pageFilter
                    ? `${filteredRows?.length ?? 0} of ${rows.length} On This Page`
                    : `${total.toLocaleString('en-IN')} Call${total === 1 ? '' : 's'} In Range`}
                </span>
                <InfoTooltip label="About This Filter">
                  <div className="space-y-2">
                    <div className="font-semibold text-slate-900">Filter This Page</div>
                    <div>
                      Narrows the calls <strong>currently on screen</strong> by any visible value —
                      it is not a search across the whole date range.
                    </div>
                    <div>
                      To cover more calls at once, raise <strong>Show</strong> at the bottom of the
                      table or step through the pages — every call in the range is reachable that way.
                    </div>
                  </div>
                </InfoTooltip>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Scrollable table region — same layout pattern as the parent. */}
      <div className="flex-1 min-h-0 overflow-auto px-6 pt-0 pb-4">
        {loading && rows === null && (
          <div className="text-sm text-muted-foreground py-8 text-center">Loading click-to-call history…</div>
        )}
        {rows !== null && rows.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground py-8 text-center inline-flex items-center justify-center gap-2 w-full">
            <Phone className="h-4 w-4" />
            {/* An empty page inside a non-empty range means the operator paged
                past the end (or rows moved under them) — that's a different
                problem from "no calls at all", so it gets its own wording. */}
            {total > 0
              ? 'No click-to-call calls on this page. Go back to an earlier page.'
              : 'No click-to-call calls in the selected range.'}
          </div>
        )}
        {rows !== null && rows.length > 0 && (
          <table className="w-full text-sm data-table">
            <thead>
              <tr className="text-xs">
                {CALL_COLUMNS.map((c) => (
                  <th
                    key={c}
                    scope="col"
                    className="sticky top-0 z-10 bg-slate-100 text-left px-3 py-2 font-medium border-b"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(filteredRows || []).map((r) => (
                <React.Fragment key={r.id}>
                <tr className="border-t hover:bg-muted/30">
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDateTime(r.inserted_time)}</td>
                  <td className="px-3 py-2">{r.caller_name || '—'}</td>
                  <td className="px-3 py-2">
                    {r.receiver_name || '—'}
                    {/* One call, N people — stated in the column a reader would
                        otherwise take as the call's only counterparty. */}
                    <ConferenceBadge row={r} className="ml-1.5" />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{maskMobile(r.receiver)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.job_id ?? '—'}</td>
                  <td className="px-3 py-2">{fmtDuration(r.duration)}</td>
                  <td className="px-3 py-2">
                    {/* Pending-sync flag: rows the cron hasn't enriched yet
                        show "Pending sync" so ops know the duration /
                        recording aren't available yet (it'll catch up
                        within 4 hours). */}
                    {r.is_updated === 1
                      ? (r.caller_status || r.receiver_status || '—')
                      : <span className="text-amber-700 text-xs">Pending sync</span>}
                  </td>
                  <td className="px-3 py-2">
                    {r.recording
                      ? <a href={r.recording} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-700 hover:underline text-xs">
                          <PlayCircle className="h-3.5 w-3.5" /> Play
                        </a>
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {(() => {
                      const s = (r.transcription_status || '').toLowerCase();
                      const b = s === 'completed' ? { t: 'Ready', c: 'bg-emerald-100 text-emerald-700' }
                        : s === 'not_available' ? { t: 'None', c: 'bg-slate-100 text-slate-500' }
                        : s === 'failed' ? { t: 'Failed', c: 'bg-rose-100 text-rose-700' }
                        : s ? { t: 'Pending', c: 'bg-amber-100 text-amber-700' }
                        : { t: '', c: '' };
                      return b.c
                        ? <span className={`inline-flex rounded-full px-2 py-0.5 font-medium ${b.c}`}>{b.t}</span>
                        : <span className="text-muted-foreground">—</span>;
                    })()}
                  </td>
                </tr>
                <CallLegsRow row={r} colSpan={CALL_COLUMNS.length} />
                </React.Fragment>
              ))}
              {filteredRows && filteredRows.length === 0 && (
                <tr>
                  <td colSpan={CALL_COLUMNS.length} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No calls on this page match &ldquo;{pageFilter}&rdquo;.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/*
        * Pager — outside the scroller (shrink-0) so it stays put while the table
        * scrolls, and above the modal's own Close footer. `total` is the server's
        * count for the whole range, so it drives the page count directly.
        * Rendered only once there is something to page, so the empty state and
        * the first load stay uncluttered.
        */}
      {total > 0 && (
        <div className="px-6 py-2 border-t bg-muted/20 shrink-0">
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            pageSizeOptions={CALL_PAGE_SIZE_OPTIONS}
          />
        </div>
      )}
    </>
  );
}
