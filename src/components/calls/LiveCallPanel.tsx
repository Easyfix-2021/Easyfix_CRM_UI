'use client';

/*
 * LiveCallPanel — fixed bottom-right live status card for the active call.
 *
 * Mounted ONCE at the authed root (next to <ToastHost/>). Renders nothing
 * until useLiveCall() has an active call — which only happens on the Plivo
 * path (POST /admin/calls/click-to-call → supportsLiveStatus true). With
 * Plivo off (enabledProviders === ['kaleyra']) startCall is never called,
 * so this panel stays dormant and behaviour is identical to today.
 *
 * Lifecycle:
 *   - Polls GET /admin/calls/:id/status every ~2s, driven by a setInterval
 *     that bumps a `tick` embedded in the fetch key (`?t=${tick}`) to bust
 *     the module cache. (useFetch has since grown a `refetchInterval`
 *     option — the conference poll below uses it; this one predates it and
 *     is left alone because it works.)
 *   - Stops polling the moment `terminal` is true.
 *   - A live mm:ss timer (useElapsedTimer) counts up from `answered_at`
 *     once the call is answered.
 *   - On terminal: shows the outcome line, then auto-dismisses (endCall)
 *     after ~4s. A manual close (X) is always available.
 *
 * CONFERENCE (2026-08):
 *   When the call carries a `conferenceId`, the body grows a participant
 *   list and an "Add To Call" control (ConferenceSection), and the red
 *   button becomes "End Call" once someone else is actually on the line.
 *   Everything about that is additive and self-gating: without a
 *   conferenceId — which is today's backend — this file renders exactly
 *   what it rendered before.
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Phone, Loader2, X, ArrowRight, PhoneOff, GripVertical, Minus, Maximize2, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { fmtDuration, pluralize } from '@/lib/format';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { CALL_PANEL_ATTR } from '@/lib/portal-markers';
import { parseIstDateTime } from '@/lib/format';
import { useLiveCall, type LiveCall } from './LiveCallContext';
import { useDraggablePanel } from './useDraggablePanel';
import { useConference, ConferenceSection } from './ConferenceSection';
import { ACTION_CONFERENCE, type EndConferenceResp } from './conference-types';

// ─── BE contract: GET /admin/calls/:id/status ─────────────────────────
type CallStatus =
  | 'initiated' | 'placed' | 'ringing' | 'answered'
  | 'completed' | 'busy' | 'no_answer' | 'failed' | 'hungup';

type StatusResp = {
  status: CallStatus;
  ringing_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration: number | null;
  terminal: boolean;
  provider: string;
};

const POLL_MS = 2000;
const AUTO_DISMISS_MS = 4000;

// ─── status → StatusChip tone + human label ───────────────────────────
//   initiated            → slate
//   ringing              → amber
//   answered/in-progress → sky
//   completed            → emerald
//   busy/no_answer/failed/hungup → rose
const STATUS_TONE: Record<CallStatus, StatusChipTone> = {
  initiated: 'slate',
  placed:    'amber',
  ringing:   'amber',
  answered:  'sky',
  completed: 'emerald',
  busy:      'rose',
  no_answer: 'rose',
  failed:    'rose',
  hungup:    'rose',
};

const STATUS_LABEL: Record<CallStatus, string> = {
  initiated: 'Initiated',
  placed:    'Calling…',
  ringing:   'Ringing',
  answered:  'In Progress',
  completed: 'Completed',
  busy:      'Busy',
  no_answer: 'No Answer',
  failed:    'Failed',
  hungup:    'Hung Up',
};

/*
 * useElapsedTimer — once `startedAt` is set, returns the whole seconds
 * elapsed since then, ticking every 1s. Returns 0 before the call is
 * answered (startedAt null). Self-clears its interval when startedAt
 * changes or the timer stops being needed.
 */
function useElapsedTimer(startedAt: string | null, running: boolean): number {
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    if (!startedAt) { setElapsed(0); return; }
    // parseIstDateTime: answered_at is a zone-less IST DATETIME (tbl_job_caller_
    // info.start_time, written NOW()). Subtracted from Date.now(), a real
    // instant, so nothing cancels — west of IST the diff is negative and the
    // Math.max(0, …) below pins the live timer at 0:00 for the whole call.
    const startMs = parseIstDateTime(startedAt).getTime();
    if (Number.isNaN(startMs)) { setElapsed(0); return; }

    const compute = () => setElapsed(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
    compute(); // seed immediately so we don't flash 0:00 for a second
    if (!running) return;
    const iv = setInterval(compute, 1000);
    return () => clearInterval(iv);
  }, [startedAt, running]);

  return elapsed;
}

export function LiveCallPanel() {
  const { active, endCall } = useLiveCall();

  if (!active) return null;
  // Key the inner panel by call id so all internal state (tick, hangup
  // busy, timer) resets cleanly when a new call replaces the old one.
  return <LiveCallCard key={active.id} call={active} onClose={endCall} />;
}

function LiveCallCard({
  call,
  onClose,
}: {
  call: LiveCall;
  onClose: () => void;
}) {
  const [tick, setTick] = React.useState(0);
  const [terminal, setTerminal] = React.useState(false);
  const [hangupBusy, setHangupBusy] = React.useState(false);
  const [hangupErr, setHangupErr] = React.useState<string | null>(null);
  const { me } = useMe();
  const confirm = useConfirm();

  // ── Conference (additive; dark unless the call carries a conferenceId) ──
  // The panel itself does no permission check — anyone who placed a call sees
  // it — so the conference surface gates ITSELF. hasAction fails closed and
  // there is no Admin bypass, so an unseeded key hides this from everyone.
  const canConference = hasAction(me, ACTION_CONFERENCE);
  const conf = useConference(call.conferenceId, { enabled: canConference });
  const conferenceLive = conf.enabled && conf.live;

  /*
   * Which teardown the red button performs — one derivation, so the label, the
   * enabled-ness and the endpoint can never disagree.
   *
   *   'hangup'     today's behaviour: drop the operator's own leg.
   *   'conference' end the room for everyone. Chosen when someone else is
   *                actually on the line (a 1-participant MPC is every ops
   *                call, so offering "for everyone" there would be theatre) —
   *                OR when the operator's own leg has already ended while the
   *                room has not. That second case is the cost leak this button
   *                exists to catch: without it, a terminal call with a live
   *                room leaves the operator no way to stop the billing.
   *   'none'       call finished, no live room — the button hides, as before.
   */
  const endMode: 'none' | 'hangup' | 'conference' =
    conferenceLive && (conf.activeOthers > 0 || terminal) ? 'conference'
      : !terminal ? 'hangup'
        : 'none';
  const endsConference = endMode === 'conference';

  // ── Drag + collapse UI state (shared hook) ────────────────────────────
  // Keyed 'live' so it never clobbers WebCallPanel's remembered position.
  const { containerRef, style, positioned, headerHandlers, collapsed, toggleCollapsed } =
    useDraggablePanel({ sessionKey: 'live', resetKey: call.id });

  // ── Polling driver: bump `tick` every POLL_MS until terminal. The
  //    fetch key embeds the tick to bust the module-level cache so each
  //    cycle is a real round-trip (mirrors ClickToCallTab's setInterval
  //    + cache-busting refresh pattern). ──
  React.useEffect(() => {
    if (terminal) return;
    const iv = setInterval(() => setTick((t) => t + 1), POLL_MS);
    return () => clearInterval(iv);
  }, [terminal]);

  const { data, error } = useFetch<StatusResp>(`/admin/calls/${call.id}/status?t=${tick}`);

  // Latch terminal once the BE reports it — stops both the poll and the
  // running timer. (Latched in state rather than read inline so a transient
  // refetch error can't "un-terminal" a finished call.)
  React.useEffect(() => {
    if (data?.terminal) setTerminal(true);
  }, [data?.terminal]);

  const status: CallStatus = data?.status ?? 'initiated';
  const tone = STATUS_TONE[status] ?? 'slate';
  const label = STATUS_LABEL[status] ?? 'Initiated';

  // Connecting/ringing → show a spinner; the timer runs only once answered
  // (and keeps running until terminal). The mm:ss source is the live timer
  // while in progress, then the BE-reported duration on terminal.
  const connecting = status === 'initiated' || status === 'placed' || status === 'ringing';
  const liveElapsed = useElapsedTimer(data?.answered_at ?? null, !terminal);
  const shownSeconds = terminal
    ? (data?.duration ?? liveElapsed)
    : liveElapsed;
  const showTimer = !!data?.answered_at;

  /*
   * ── Auto-dismiss once terminal ──
   *
   * Suppressed while a conference is still live. The operator's own leg can
   * reach a terminal status while the room has not been torn down yet, and
   * this panel is the ONLY handle the FE has on that room — there is no
   * reattach path. Silently dismissing it would leave legs billing with no
   * way back to the End Call button.
   */
  React.useEffect(() => {
    if (!terminal) return;
    if (conferenceLive) return;
    const t = setTimeout(onClose, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [terminal, onClose, conferenceLive]);

  /*
   * ── Closing the panel ──
   *
   * Closing has never hung up the call, and it still doesn't. But with other
   * people on the line, "X" losing the only handle to a live conference is a
   * different order of mistake, so it asks first and says plainly what closing
   * does and does not do.
   */
  // The panel sits ABOVE the confirm's backdrop (z-9998 vs z-50), so its X
  // stays clickable while the prompt is open. Without this guard a second
  // click would open a second confirm and strand the first promise.
  const closingRef = React.useRef(false);

  /*
   * Retract the prompt if the room empties while it is on screen.
   *
   * `description` is a ReactNode captured at call time, so `activeTotal` in it
   * is a snapshot while the conference keeps polling every 2s behind the
   * backdrop. Left alone, the dialog goes on insisting the call is "still
   * running with N people" over a panel that has already flipped every
   * participant to Left — and points at an End Call control that is hidden
   * once the call is terminal. Same defect as WebCallPanel's stranded-room
   * prompt; same handle.
   */
  const promptAbort = React.useRef<AbortController | null>(null);
  const premiseHolds = conferenceLive && conf.activeOthers > 0;
  React.useEffect(() => {
    if (!premiseHolds) promptAbort.current?.abort();
  }, [premiseHolds]);

  const handleClose = React.useCallback(async () => {
    if (closingRef.current) return;
    if (conferenceLive && conf.activeOthers > 0) {
      closingRef.current = true;
      const ac = new AbortController();
      promptAbort.current = ac;
      const ok = await confirm({
        title: 'Close This Panel?',
        description: (
          <p className="text-foreground/85">
            The call is still running with {pluralize(conf.activeTotal, 'person', 'people')} on
            it. Closing only hides this panel — it does <span className="font-semibold">not</span> end
            the call, and you will not be able to reopen it. Use End Call to hang up for
            everyone.
          </p>
        ),
        confirmLabel: 'Close Panel',
        cancelLabel: 'Keep It Open',
        variant: 'destructive',
        icon: <Users className="h-4 w-4" />,
        iconAccent: 'amber',
        signal: ac.signal,
      });
      closingRef.current = false;
      promptAbort.current = null;
      if (!ok) return;
    }
    onClose();
  }, [conferenceLive, conf.activeOthers, conf.activeTotal, confirm, onClose]);

  /*
   * ── Hang up / End Call (hidden once terminal) ──
   *
   * Two endpoints, chosen by whether anyone else is actually on the line:
   *   - alone      → POST /admin/calls/:id/hangup, exactly as before.
   *   - conference → POST /admin/conferences/:id/end, which tears the room
   *                  down and READS IT BACK. `verified:false` means Plivo
   *                  accepted the teardown but still reports the room; the
   *                  operator is told that rather than being told "ended"
   *                  while legs are still billing.
   * No confirm on this one: the button says what it does, and the operator
   * leaving would end the room anyway (endMpcOnExit).
   */
  const onHangup = React.useCallback(async () => {
    if (hangupBusy || endMode === 'none') return;
    setHangupBusy(true); setHangupErr(null);
    try {
      if (endsConference && call.conferenceId) {
        const resp = await api.post<EndConferenceResp>(
          `/admin/conferences/${call.conferenceId}/end`,
        );
        showToast(
          resp.verified === false
            ? {
                variant: 'warning',
                message: 'Ending the call — the provider has not confirmed yet. It will be force-ended shortly.',
              }
            : { variant: 'success', message: resp.message || 'Call ended for everyone.' },
        );
        invalidateFetch((k) => k.startsWith('/admin/conferences'));
        conf.refresh();
      } else {
        await api.post<{ success: boolean }>(`/admin/calls/${call.id}/hangup`);
      }
      // Don't optimistically flip terminal — let the next status poll report
      // the real ended state. We just disable the button meanwhile.
    } catch (err) {
      // 409 = provider can't hang up; 502 = the room is still reported live.
      // Surface the BE message inline either way.
      setHangupErr(formatApiError(err, {
        fallback: endsConference ? 'Could not end the call.' : 'Could not hang up the call.',
      }));
    } finally {
      setHangupBusy(false);
    }
  }, [hangupBusy, endMode, call.id, call.conferenceId, endsConference, conf]);

  // Terminal outcome line: "Call Ended · 2:14" / "Busy" / "No Answer" / "Failed".
  const outcomeLine = React.useMemo(() => {
    if (!terminal) return null;
    switch (status) {
      case 'completed':
      case 'hungup':
        return `Call Ended · ${fmtDuration(shownSeconds)}`;
      case 'busy':      return 'Busy';
      case 'no_answer': return 'No Answer';
      case 'failed':    return 'Failed';
      default:          return 'Call Ended';
    }
  }, [terminal, status, shownSeconds]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={containerRef}
      role="status"
      aria-live="polite"
      {...CALL_PANEL_ATTR}
      style={style}
      className={cn(
        // Bottom-right (above modal overlays; Radix Dialog defaults to z-50),
        // unless dragged — then pinned via `style`.
        'fixed z-[9998]',
        !positioned && 'bottom-6 right-6',
        collapsed ? 'w-auto' : 'w-[320px] max-w-[calc(100vw-3rem)]',
        'rounded-xl border border-ink-100 bg-card shadow-2xl overflow-hidden',
      )}
    >
      {/* Header band — dark slate, doubles as the drag handle. */}
      <div
        {...headerHandlers}
        className="flex items-center gap-2 bg-sidebar text-sidebar-foreground px-3 py-2.5 cursor-grab active:cursor-grabbing select-none"
      >
        <GripVertical className="h-4 w-4 shrink-0 text-sidebar-foreground/40" aria-hidden />
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success/20 ring-1 ring-success/40 text-success-tint">
          {connecting && !terminal
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <Phone className="h-4 w-4" />}
        </span>

        {collapsed ? (
          // Collapsed pill: status + live timer inline so the operator keeps
          // the essentials at a glance while the panel is out of the way.
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold leading-tight truncate">{label}</span>
            {showTimer && (
              <span className="font-mono tabular-nums text-xs font-semibold text-sidebar-foreground/80">
                {fmtDuration(shownSeconds)}
              </span>
            )}
            {/* Head-count while minimised — the one thing about a conference
                the operator must not lose sight of behind a pill. */}
            {conf.activeTotal > 1 && (
              <span className="inline-flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-px text-xs font-semibold text-sidebar-foreground/80">
                <Users className="h-3 w-3" aria-hidden />
                {conf.activeTotal}
              </span>
            )}
          </span>
        ) : (
          <span className="flex-1 flex items-center gap-2 text-sm font-semibold leading-tight">
            {conf.activeTotal > 1 ? 'Conference Call' : 'Live Call'}
            {conf.activeTotal > 1 && (
              <span className="inline-flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-px text-xs font-semibold text-sidebar-foreground/80">
                <Users className="h-3 w-3" aria-hidden />
                {conf.activeTotal}
              </span>
            )}
          </span>
        )}

        {/* Hangup stays reachable directly from the collapsed pill. */}
        {collapsed && endMode !== 'none' && (
          <button
            type="button"
            onClick={onHangup}
            disabled={hangupBusy}
            className={cn(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded bg-destructive text-white hover:bg-destructive-strong transition-colors',
              hangupBusy && 'opacity-60 cursor-wait',
            )}
            aria-label={endsConference ? 'End call for everyone' : 'Hang up'}
            title={endsConference ? 'End Call' : 'Hang Up'}
          >
            {hangupBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PhoneOff className="h-3.5 w-3.5" />}
          </button>
        )}

        <div className={cn('flex items-center gap-1', !collapsed && 'ml-auto')}>
          <button
            type="button"
            onClick={toggleCollapsed}
            className="rounded p-1 text-sidebar-foreground/70 hover:bg-white/10 hover:text-sidebar-foreground"
            aria-label={collapsed ? 'Expand call panel' : 'Minimize call panel'}
            title={collapsed ? 'Expand' : 'Minimize'}
          >
            {collapsed ? <Maximize2 className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => void handleClose()}
            className="rounded p-1 text-sidebar-foreground/70 hover:bg-white/10 hover:text-sidebar-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body — hidden while collapsed; the call keeps polling regardless. */}
      {!collapsed && (
      <div className="px-4 py-3 space-y-3">
        {/* Optional callee name */}
        {call.name && (
          <div className="text-sm font-medium text-foreground truncate">{call.name}</div>
        )}

        {/* Masked from → to */}
        <div className="flex items-center justify-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-100 bg-ink-50 px-2.5 py-1">
            <Phone className="h-3.5 w-3.5 text-success-strong" aria-hidden />
            <span className="font-mono text-xs font-semibold text-ink-900">{call.fromMasked || '—'}</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-ink-500" aria-hidden />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-100 bg-ink-50 px-2.5 py-1">
            <Phone className="h-3.5 w-3.5 text-info" aria-hidden />
            <span className="font-mono text-xs font-semibold text-ink-900">{call.toMasked || '—'}</span>
          </span>
        </div>

        {/* Status row: chip + live timer / spinner */}
        <div className="flex items-center justify-between gap-2">
          <StatusChip tone={tone}>{label}</StatusChip>
          <div className="flex items-center gap-1.5 text-sm">
            {!terminal && connecting && (
              <Loader2 className="h-4 w-4 animate-spin text-ink-500" aria-hidden />
            )}
            {showTimer && (
              <span className="font-mono tabular-nums font-semibold text-ink-700">
                {fmtDuration(shownSeconds)}
              </span>
            )}
          </div>
        </div>

        {/* Terminal outcome line */}
        {terminal && outcomeLine && (
          <div className="text-sm font-medium text-foreground">{outcomeLine}</div>
        )}

        {/*
          Participant list + Add To Call — or, for a call with no room, the
          can't-add-participants notice. WebCallPanel mounts this exact same
          component with this exact same prop shape; the component owns every
          gate (permission → no conference → no state → empty roster), so the
          two panels cannot disagree about when the surface appears.

          operatorPresent is derived DIFFERENTLY in each panel on purpose, and
          the prop is required precisely so neither can forget to answer the
          question. Here the operator's leg is a real phone leg, so the honest
          source is the call-status poll — `answered` and not yet terminal. In
          web mode it is the browser SDK's own state. Both answer the same
          question: is a human from our side actually in the room? If they are
          not, Add To Call disarms, because dialling a customer into a room with
          no agent in it is the one outcome this surface must never produce.
        */}
        <ConferenceSection
          conferenceId={call.conferenceId}
          conf={conf}
          operatorPresent={status === 'answered' && !terminal}
        />

        {/* Hangup error (e.g. 409 — provider can't hang up) */}
        {hangupErr && (
          <div className="text-xs text-urgent-strong bg-urgent-tint border border-urgent rounded px-2 py-1">
            {hangupErr}
          </div>
        )}

        {/* Status-fetch error (non-fatal — operator can still close) */}
        {error && !data && (
          <div className="text-xs text-warning-strong">Updating status…</div>
        )}

        {/* Hang up / End Call — hidden only when there is nothing left to end. */}
        {endMode !== 'none' && (
          <button
            type="button"
            onClick={onHangup}
            disabled={hangupBusy}
            className={cn(
              'w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-md',
              'bg-destructive text-white text-xs font-semibold shadow-sm',
              'hover:bg-destructive-strong transition-colors',
              hangupBusy && 'opacity-60 cursor-wait',
            )}
          >
            {hangupBusy
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <PhoneOff className="h-3.5 w-3.5" />}
            {hangupBusy
              ? (endsConference ? 'Ending Call…' : 'Hanging Up…')
              : (endsConference ? 'End Call For Everyone' : 'Hangup')}
          </button>
        )}
      </div>
      )}
    </div>,
    document.body,
  );
}
