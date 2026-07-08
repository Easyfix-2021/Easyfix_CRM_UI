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
 *   - Polls GET /admin/calls/:id/status every ~2s. useFetch has no interval
 *     option, so we drive it the same way ClickToCallTab drives its refresh:
 *     a setInterval bumps a `tick`, and the fetch key embeds `?t=${tick}`
 *     to bust the module cache and force a fresh request each cycle.
 *   - Stops polling the moment `terminal` is true.
 *   - A live mm:ss timer (useElapsedTimer) counts up from `answered_at`
 *     once the call is answered.
 *   - On terminal: shows the outcome line, then auto-dismisses (endCall)
 *     after ~4s. A manual close (X) is always available.
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Phone, Loader2, X, ArrowRight, PhoneOff, GripVertical, Minus, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useFetch } from '@/lib/hooks';
import { fmtDuration } from '@/lib/format';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { CALL_PANEL_ATTR } from '@/lib/portal-markers';
import { useLiveCall, type LiveCall } from './LiveCallContext';
import { useDraggablePanel } from './useDraggablePanel';

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
    const startMs = new Date(startedAt).getTime();
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

  // ── Auto-dismiss once terminal ──
  React.useEffect(() => {
    if (!terminal) return;
    const t = setTimeout(onClose, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [terminal, onClose]);

  // ── Hangup action (hidden once terminal) ──
  const onHangup = React.useCallback(async () => {
    if (hangupBusy || terminal) return;
    setHangupBusy(true); setHangupErr(null);
    try {
      await api.post<{ success: boolean }>(`/admin/calls/${call.id}/hangup`);
      // Don't optimistically flip terminal — let the next status poll report
      // the real ended state. We just disable the button meanwhile.
    } catch (err) {
      // 409 = provider can't hang up. Surface the BE message inline.
      setHangupErr(formatApiError(err, { fallback: 'Could not hang up the call.' }));
    } finally {
      setHangupBusy(false);
    }
  }, [hangupBusy, terminal, call.id]);

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
        'rounded-xl border border-slate-200 bg-white shadow-2xl overflow-hidden',
      )}
    >
      {/* Header band — dark slate, doubles as the drag handle. */}
      <div
        {...headerHandlers}
        className="flex items-center gap-2 bg-sidebar text-sidebar-foreground px-3 py-2.5 cursor-grab active:cursor-grabbing select-none"
      >
        <GripVertical className="h-4 w-4 shrink-0 text-sidebar-foreground/40" aria-hidden />
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 ring-1 ring-emerald-400/40 text-emerald-200">
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
          </span>
        ) : (
          <span className="flex-1 text-sm font-semibold leading-tight">Live Call</span>
        )}

        {/* Hangup stays reachable directly from the collapsed pill. */}
        {collapsed && !terminal && (
          <button
            type="button"
            onClick={onHangup}
            disabled={hangupBusy}
            className={cn(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded bg-rose-600 text-white hover:bg-rose-700 transition-colors',
              hangupBusy && 'opacity-60 cursor-wait',
            )}
            aria-label="Hang up"
            title="Hang up"
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
            onClick={onClose}
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
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
            <Phone className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
            <span className="font-mono text-xs font-semibold text-slate-800">{call.fromMasked || '—'}</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
            <Phone className="h-3.5 w-3.5 text-sky-600" aria-hidden />
            <span className="font-mono text-xs font-semibold text-slate-800">{call.toMasked || '—'}</span>
          </span>
        </div>

        {/* Status row: chip + live timer / spinner */}
        <div className="flex items-center justify-between gap-2">
          <StatusChip tone={tone}>{label}</StatusChip>
          <div className="flex items-center gap-1.5 text-sm">
            {!terminal && connecting && (
              <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden />
            )}
            {showTimer && (
              <span className="font-mono tabular-nums font-semibold text-slate-700">
                {fmtDuration(shownSeconds)}
              </span>
            )}
          </div>
        </div>

        {/* Terminal outcome line */}
        {terminal && outcomeLine && (
          <div className="text-sm font-medium text-foreground">{outcomeLine}</div>
        )}

        {/* Hangup error (e.g. 409 — provider can't hang up) */}
        {hangupErr && (
          <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
            {hangupErr}
          </div>
        )}

        {/* Status-fetch error (non-fatal — operator can still close) */}
        {error && !data && (
          <div className="text-xs text-amber-700">Updating status…</div>
        )}

        {/* Hangup button — only while NOT terminal */}
        {!terminal && (
          <button
            type="button"
            onClick={onHangup}
            disabled={hangupBusy}
            className={cn(
              'w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-md',
              'bg-rose-600 text-white text-xs font-semibold shadow-sm',
              'hover:bg-rose-700 transition-colors',
              hangupBusy && 'opacity-60 cursor-wait',
            )}
          >
            {hangupBusy
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <PhoneOff className="h-3.5 w-3.5" />}
            {hangupBusy ? 'Hanging Up…' : 'Hangup'}
          </button>
        )}
      </div>
      )}
    </div>,
    document.body,
  );
}
