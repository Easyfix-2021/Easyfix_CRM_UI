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
 *
 * ─── Conference calls ────────────────────────────────────────────────────
 *
 * This is the surface where "the complete call history for the job" is the
 * whole promise, so it is where a conference has to read correctly. A call that
 * gained people is still ONE call and still ONE row here; the extra people are
 * an indented detail block underneath it, each labelled with their role. What
 * it must never do is show a 3-party conference as three calls — see
 * `groupCallRows` in lib/call-legs.ts for the guard, and why it is defensive.
 */

import * as React from 'react';
import { Info, PhoneIncoming, PhoneOutgoing, Loader2, Play } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CallRecordingAudio } from '@/components/ui/call-recording-audio';
import { StatusChip } from '@/components/ui/StatusChip';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  callLegRoleLabel,
  counterpartyLegs,
  groupCallRows,
  isConferenceCall,
  partyTone,
  type CallLeg,
} from '@/lib/call-legs';
import { CallLegsRow, ConferenceBadge } from './CallLegList';

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
  /*
   * Conference legs — every person on this call, the ops agent included. Absent
   * on an ordinary 1:1 call, and absent entirely against a backend that does not
   * project them yet, which is why every reader goes through the helpers in
   * lib/call-legs.ts rather than indexing `legs` directly.
   */
  conference_id?: number | null;
  legs?: CallLeg[] | null;
};
type CallHistoryResp = { total: number; items: CallRow[] };

// Header count — the column set below. Kept beside the <thead> it describes so
// the legs' full-width detail row cannot fall out of step with it.
const CALL_HISTORY_COLUMNS = 7;

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

/*
 * Who this call was with, for the "With" column.
 *
 * ⚠ PREFER THE LEG'S OWN ROLE over the row-level classification.
 *
 * The backend derives `party_role` from `jci.reciever` — the number stamped on
 * the call at click-to-call time — so it can only ever describe the party that
 * was dialled FIRST. On a conference every leg carries its own
 * `participant_role`, which is the only field that knows a technician was added
 * mid-call. Falling back to `party_role` keeps every ordinary 1:1 call reading
 * exactly as it did.
 */
function primaryParty(r: CallRow): { role: string; name: string | null } {
  const others = counterpartyLegs(r);
  if (others.length > 0) {
    const first = others[0];
    return {
      role: callLegRoleLabel(first.target_kind),
      name: first.display_name ?? r.party_name,
    };
  }
  return { role: r.party_role || 'Other', name: r.party_name };
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
  /*
   * Set once the endpoint has told us there is no audio for this row.
   *
   * WHY THIS ISN'T GATED ON A recording_url FIELD INSTEAD. The obvious version
   * of "hide Play when recording_url is NULL" would break playback almost
   * everywhere: the backend does not read that column to play a call — when it
   * is blank it PULLS fresh from Plivo by call_uuid and self-heals the row,
   * because (per its own comment) "the Plivo push callback has proven
   * unreliable (never populated the column)". A blank recording_url is the
   * NORMAL state of a call whose audio exists and plays fine, so gating on it
   * would turn a cosmetic annoyance into a loss of function.
   *
   * The attempt is the only trustworthy signal, so we keep it and remember the
   * answer — the same reasoning as the notice-attachment onError.
   */
  const [unavailable, setUnavailable] = React.useState(false);

  // Kaleyra rows carry an https recording URL; Plivo rows only *might* have one
  // (recorded + connected) — the endpoint 404s cleanly when there's none.
  const isPlivo = String(row.provider ?? '').toLowerCase() === 'plivo';
  const canPlay = !!row.recording || (isPlivo && (row.duration ?? 0) > 0);
  if (!canPlay) {
    // A Plivo call with no duration never connected → there is no recording to
    // fetch. Label it so operators don't expect a Play button that can't appear.
    if (isPlivo && (row.duration ?? 0) <= 0) {
      return (
        <span className="text-xs italic text-muted-foreground" title="Call wasn't answered — nothing was recorded">
          Not answered
        </span>
      );
    }
    return <span className="text-muted-foreground">—</span>;
  }

  if (url) {
    // Downmixes the 2-channel (agent | customer) Plivo recording to mono —
    // otherwise the customer is audible only on the RIGHT channel. See
    // components/ui/call-recording-audio.tsx.
    return <CallRecordingAudio src={url} autoPlay className="h-7 w-40" />;
  }

  async function play() {
    setLoading(true);
    try {
      const r = await api.get<{ url: string }>(`/admin/calls/${row.id}/recording`);
      if (r?.url) setUrl(r.url);
      else { setUnavailable(true); showToast({ variant: 'error', message: 'No recording available for this call.' }); }
    } catch (e) {
      setUnavailable(true);
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'No recording available for this call.' });
    } finally {
      setLoading(false);
    }
  }

  /*
   * Once we know there's nothing, stop advertising "Play" — that was the
   * complaint: a green Play that answers with an error toast, still sitting
   * there inviting the next click.
   *
   * STILL CLICKABLE, deliberately. The endpoint returns one 404 for two
   * different situations — "never recorded" and "not ready yet", since Plivo's
   * mp3 lags a minute or so after hangup — so a permanent dead label would
   * block a legitimate retry. The label tells the truth about now; the click
   * keeps the retry available, and the tooltip says which is which.
   */
  return (
    <button
      type="button"
      onClick={play}
      disabled={loading}
      title={unavailable
        ? 'No recording found. Recordings can take a minute to appear after a call ends — click to check again.'
        : 'Play call recording'}
      className={unavailable
        ? 'inline-flex items-center gap-1 text-xs italic text-muted-foreground hover:underline disabled:opacity-50'
        : 'inline-flex items-center gap-1 text-emerald-700 hover:underline disabled:opacity-50'}
    >
      {loading
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : (unavailable ? null : <Play className="h-3.5 w-3.5" />)}
      {unavailable ? 'No recording' : 'Play'}
    </button>
  );
}

/*
 * CallHistoryTable — the job-scoped call log (loading / error / empty / table),
 * with the party-aware "With" column. Shared by the ⓘ popup below and the
 * job-detail modal's inline "Calling History" section so the two never drift.
 */
export function CallHistoryTable({
  items: rawItems,
  loading,
  error,
}: {
  items: CallRow[];
  loading?: boolean;
  error?: unknown;
}) {
  /*
   * One row per CALL, whatever shape the endpoint sent. See `groupCallRows` —
   * the jci⋈pcl join is 1:N now, so an ungrouped render would show a 3-party
   * conference as three identical rows with three duplicate React keys.
   *
   * Memoised on the array identity, not deep-compared: `useFetch` hands back a
   * stable object per response, so this recomputes once per fetch.
   */
  const items = React.useMemo(() => groupCallRows(rawItems), [rawItems]);

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
          const party = primaryParty(r);
          const conference = isConferenceCall(r);
          return (
            /* Fragment, not two loose siblings: a conference contributes the
               call's row PLUS its legs' detail row, and they must stay adjacent
               and keyed as one unit. */
            <React.Fragment key={r.id}>
              <tr className={cn('border-b border-border/60', conference && 'border-b-0')}>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  {fmtTime(r.inserted_time || r.start_time)}
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <StatusChip tone={partyTone(party.role)} size="sm">
                    {party.role}
                  </StatusChip>
                  {party.name ? (
                    <span className="ml-1.5 text-muted-foreground">{party.name}</span>
                  ) : null}
                  {/* Says "one call, N people" right where the reader would
                      otherwise conclude the call was with one person. */}
                  <ConferenceBadge row={r} className="ml-1.5" />
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
                {/* The recording belongs to the CALL, not to a leg: the room is
                    recorded once and filed against the operator's leg, which is
                    why this stays on the call's row and never repeats per-leg. */}
                <td className="py-1.5"><RecordingCell row={r} /></td>
              </tr>
              <CallLegsRow row={r} colSpan={CALL_HISTORY_COLUMNS} />
            </React.Fragment>
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
