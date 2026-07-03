'use client';

/*
 * CallHistoryButton — a small info (ⓘ) icon shown after a customer mobile in
 * the My Orders tables. On click it opens a popup listing the call history for
 * THAT number on THAT job only. Scoping is done server-side
 * (GET /admin/calls?jobId=&mobile=): tbl_job_caller_info stamps job_id per call,
 * so calls on the same number for a DIFFERENT job are excluded by construction.
 */

import * as React from 'react';
import { Info, PhoneIncoming, PhoneOutgoing, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useFetch } from '@/lib/hooks';
import { cn } from '@/lib/utils';

type CallRow = {
  id: number;
  call_type: string | null;
  duration: number | null;
  caller_status: string | null;
  caller_name: string | null;
  provider: string | null;
  recording: string | null;
  start_time: string | null;
  inserted_time: string | null;
};
type CallHistoryResp = { total: number; items: CallRow[] };

// Display the stored IST wall-clock verbatim (strip the ISO 'T'/'Z' if present)
// — NO timezone math, per the app's IST wall-clock convention.
function fmtTime(dt: string | null): string {
  if (!dt) return '—';
  return String(dt).replace('T', ' ').replace('Z', '').slice(0, 16);
}
function fmtDuration(d: number | null): string {
  if (d == null) return '—';
  if (d <= 0) return '0s';
  return d >= 60 ? `${Math.floor(d / 60)}m ${d % 60}s` : `${d}s`;
}
function titleCase(s: string | null): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

export function CallHistoryButton({
  jobId,
  mobile,
  className,
}: {
  jobId: number;
  mobile: string | null | undefined;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const num = mobile && String(mobile).trim() !== '' ? String(mobile).trim() : null;

  // Fetch only once the popup is opened (key null → disabled until then).
  const key =
    open && jobId && num
      ? `/admin/calls?jobId=${jobId}&mobile=${encodeURIComponent(num)}&limit=100`
      : null;
  const { data, loading, error } = useFetch<CallHistoryResp>(key, { enabled: !!key });
  const items = data?.items ?? [];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="View call history for this number"
        aria-label="View call history for this number"
        className={cn(
          'inline-flex items-center align-middle text-muted-foreground hover:text-foreground',
          className,
        )}
      >
        <Info className="h-3.5 w-3.5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-base">
              Call History
              {num ? (
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  · {num} · Job #{jobId}
                </span>
              ) : null}
            </DialogTitle>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto">
            {loading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                <Loader2 className="mx-auto mb-1 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : error ? (
              <div className="py-10 text-center text-sm text-red-700">
                Failed to load call history.
              </div>
            ) : items.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No Calls Recorded For This Number On This Job.
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium whitespace-nowrap">Date &amp; Time</th>
                    <th className="py-1.5 pr-3 font-medium">Direction</th>
                    <th className="py-1.5 pr-3 font-medium whitespace-nowrap">Duration</th>
                    <th className="py-1.5 pr-3 font-medium">Status</th>
                    <th className="py-1.5 pr-3 font-medium">By</th>
                    <th className="py-1.5 font-medium">Recording</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => {
                    const out = String(r.call_type ?? '').toUpperCase() === 'OUT';
                    return (
                      <tr key={r.id} className="border-b border-border/60">
                        <td className="py-1.5 pr-3 whitespace-nowrap">
                          {fmtTime(r.inserted_time || r.start_time)}
                        </td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">
                            {out ? (
                              <PhoneOutgoing className="h-3 w-3 text-emerald-600" />
                            ) : (
                              <PhoneIncoming className="h-3 w-3 text-sky-600" />
                            )}
                            {out ? 'Outgoing' : 'Incoming'}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDuration(r.duration)}</td>
                        <td className="py-1.5 pr-3">{titleCase(r.caller_status)}</td>
                        <td className="py-1.5 pr-3">{r.caller_name || '—'}</td>
                        <td className="py-1.5">
                          {r.recording ? (
                            <a
                              href={r.recording}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-emerald-700 hover:underline"
                            >
                              Play
                            </a>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
