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
 */

import * as React from 'react';
import { Phone, Search, PlayCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { maskMobile } from '@/lib/format';

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
};

type ListResp = { total: number; page: number; limit: number; items: CallRow[] };

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
  const [rows, setRows] = React.useState<CallRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState<string>('');

  React.useEffect(() => {
    if (!from || !to) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null); setSearch('');
      try {
        // The backend treats dateTo as an exclusive upper bound (< ?),
        // so push the picker's end-of-day forward by one day to make
        // the range inclusive of `to`.
        const toExclusive = new Date(to);
        toExclusive.setDate(toExclusive.getDate() + 1);
        const toStr = toExclusive.toISOString().slice(0, 10);
        const resp = await api.get<ListResp>('/admin/calls', {
          dateFrom: from,
          dateTo:   toStr,
          limit:    500,
        });
        if (cancelled) return;
        setRows(resp.items || []);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof ApiError ? e.message : 'Failed to load click-to-call history');
        setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [from, to]);

  const filteredRows = React.useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
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
      return hay.includes(q);
    });
  }, [rows, search]);

  return (
    <>
      {/* Top band: search + count, mirrors the existing tab's UX so the
          two tabs feel coherent to switch between. */}
      {(err || (rows !== null && rows.length > 0)) && (
        <div className="px-6 pt-2 pb-2 shrink-0">
          {err && (
            <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 mb-2">
              {err}
            </div>
          )}
          {rows !== null && rows.length > 0 && (
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
                  ? `${filteredRows?.length ?? 0} of ${rows.length}`
                  : `${rows.length} call${rows.length === 1 ? '' : 's'}`}
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
            <Phone className="h-4 w-4" /> No click-to-call calls in the selected range.
          </div>
        )}
        {rows !== null && rows.length > 0 && (
          <table className="w-full text-sm data-table">
            <thead>
              <tr className="text-xs">
                {[
                  'Call Time', 'Agent', 'Customer', 'Customer Mobile',
                  'Job #', 'Duration', 'Status', 'Recording', 'Transcript',
                ].map((c) => (
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
                <tr key={r.id} className="border-t hover:bg-muted/30">
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDateTime(r.inserted_time)}</td>
                  <td className="px-3 py-2">{r.caller_name || '—'}</td>
                  <td className="px-3 py-2">{r.receiver_name || '—'}</td>
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
              ))}
              {filteredRows && filteredRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No rows match &ldquo;{search}&rdquo;.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
