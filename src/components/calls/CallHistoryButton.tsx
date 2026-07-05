'use client';

/*
 * CallHistoryButton — a small info (ⓘ) icon shown next to the Job # in the
 * job-list tables (and the job-detail modal). On click it opens a popup listing
 * ALL calls recorded for THAT job — to whoever: customer, client SPOC,
 * technician, alternate number. Scoping is job-only (GET /admin/calls?jobId=):
 * tbl_job_caller_info stamps job_id per call, and the backend classifies each
 * row's counterparty against the job's known numbers so the "With" column can
 * show WHO the call was with rather than a bare (masked) number.
 *
 * It sits on the Job # (not the customer number) precisely because a job's
 * calls span multiple parties — pinning it to one number would misrepresent it.
 */

import * as React from 'react';
import { Info, PhoneIncoming, PhoneOutgoing, Loader2, Play } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

export type CallRow = {
  id: number;
  call_type: string | null;
  duration: number | null;
  caller_status: string | null;
  caller_name: string | null;
  receiver_name: string | null;
  provider: string | null;
  recording: string | null;
  start_time: string | null;
  inserted_time: string | null;
  // Counterparty classification added by the backend when scoped to a job.
  party_role: string | null;
  party_name: string | null;
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
// Colour the party pill by role so ops can scan "who" at a glance.
function partyTone(role: string | null): string {
  switch ((role || '').toLowerCase()) {
    case 'customer':    return 'bg-sky-100 text-sky-700';
    case 'client spoc': return 'bg-violet-100 text-violet-700';
    case 'technician':  return 'bg-emerald-100 text-emerald-700';
    case 'alternate':   return 'bg-amber-100 text-amber-700';
    default:            return 'bg-slate-100 text-slate-600';
  }
}

/*
 * RecordingCell — lazy call-recording play. On first play we hit
 * GET /admin/calls/:id/recording, which fetches the audio from Plivo, caches it
 * to our S3 once, and returns a short-lived URL; every later play is a cheap S3
 * cache hit. Rendered as a ▶ button until a URL resolves, then an inline
 * <audio> scrubber. Shows a dash when the row can't have a recording.
 */
function RecordingCell({ row }: { row: CallRow }) {
  const [loading, setLoading] = React.useState(false);
  const [url, setUrl] = React.useState<string | null>(null);

  // Kaleyra rows carry an https recording URL; Plivo rows only *might* have one
  // (recorded + connected) — the endpoint 404s cleanly when there's none.
  const isPlivo = String(row.provider ?? '').toLowerCase() === 'plivo';
  const canPlay = !!row.recording || (isPlivo && (row.duration ?? 0) > 0);
  if (!canPlay) return <span className="text-muted-foreground">—</span>;

  if (url) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio src={url} controls autoPlay className="h-7 w-40" />;
  }

  async function play() {
    setLoading(true);
    try {
      const r = await api.get<{ url: string }>(`/admin/calls/${row.id}/recording`);
      if (r?.url) setUrl(r.url);
      else showToast({ variant: 'error', message: 'No recording available for this call.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'No recording available for this call.' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={play}
      disabled={loading}
      title="Play call recording"
      className="inline-flex items-center gap-1 text-emerald-700 hover:underline disabled:opacity-50"
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
      Play
    </button>
  );
}

/*
 * CallHistoryTable — the job-scoped call log (loading / error / empty / table),
 * with the party-aware "With" column. Shared by the ⓘ popup below and the
 * job-detail modal's inline "Calling History" section so the two never drift.
 */
export function CallHistoryTable({
  items,
  loading,
  error,
}: {
  items: CallRow[];
  loading?: boolean;
  error?: unknown;
}) {
  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        <Loader2 className="mx-auto mb-1 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="py-10 text-center text-sm text-red-700">
        Failed to load call history.
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No Calls Recorded For This Job.
      </div>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="py-1.5 pr-3 font-medium whitespace-nowrap">Date &amp; Time</th>
          <th className="py-1.5 pr-3 font-medium">With</th>
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
                <span
                  className={cn(
                    'inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
                    partyTone(r.party_role),
                  )}
                >
                  {r.party_role || 'Other'}
                </span>
                {r.party_name ? (
                  <span className="ml-1.5 text-muted-foreground">{r.party_name}</span>
                ) : null}
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
              {/* "By" = the operator/agent leg. On OUT calls the operator is the
                  caller; on IN calls the operator is the answering (receiver)
                  side — showing caller_name there would wrongly print the
                  customer (already in "With"). */}
              <td className="py-1.5 pr-3">{(out ? r.caller_name : r.receiver_name) || '—'}</td>
              <td className="py-1.5"><RecordingCell row={r} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function CallHistoryButton({
  jobId,
  className,
}: {
  jobId: number;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);

  // Fetch only once the popup is opened (key null → disabled until then).
  // Job-scoped: every call on this job, whoever the counterparty was.
  const key = open && jobId ? `/admin/calls?jobId=${jobId}&limit=100` : null;
  const { data, loading, error } = useFetch<CallHistoryResp>(key, { enabled: !!key });
  const items = data?.items ?? [];

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="View call history for this job"
        aria-label="View call history for this job"
        className={cn(
          'inline-flex items-center align-middle text-sky-600 hover:text-sky-800',
          className,
        )}
      >
        <Info className="h-4 w-4" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base">
              Call History
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                · Job #{jobId}
              </span>
            </DialogTitle>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto">
            <CallHistoryTable items={items} loading={loading} error={error} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
