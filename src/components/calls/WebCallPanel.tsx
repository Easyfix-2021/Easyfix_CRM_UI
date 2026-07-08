'use client';

/*
 * WebCallPanel — fixed bottom-right card for the active BROWSER (WebRTC) call.
 *
 * Mounted once at the authed root (next to <LiveCallPanel/>). Renders nothing
 * until useWebCall() has an active call (web mode only). Unlike LiveCallPanel
 * (which polls the BE), this is driven entirely by Plivo Browser SDK events
 * surfaced through WebCallContext — so status + timer update in real time with
 * no polling. Offers Mute + Hangup; auto-dismisses a few seconds after the call
 * ends.
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Phone, Loader2, X, PhoneOff, Mic, MicOff, Globe, GripVertical, Minus, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtDuration } from '@/lib/format';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { CALL_PANEL_ATTR } from '@/lib/portal-markers';
import { useWebCall, type WebCallStatus } from './WebCallContext';
import { useDraggablePanel } from './useDraggablePanel';

const TONE: Record<WebCallStatus, StatusChipTone> = {
  idle: 'slate', connecting: 'amber', ringing: 'amber', in_progress: 'sky', ended: 'emerald', failed: 'rose',
};
const LABEL: Record<WebCallStatus, string> = {
  idle: 'Idle', connecting: 'Connecting…', ringing: 'Ringing', in_progress: 'In Progress', ended: 'Call Ended', failed: 'Failed',
};
const AUTO_DISMISS_MS = 10000;

function useElapsed(startedAt: number | null, running: boolean): number {
  const [s, setS] = React.useState(0);
  React.useEffect(() => {
    if (!startedAt) { setS(0); return; }
    const compute = () => setS(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    compute();
    if (!running) return;
    const iv = setInterval(compute, 1000);
    return () => clearInterval(iv);
  }, [startedAt, running]);
  return s;
}

export function WebCallPanel() {
  const { status, active, muted, error, hangup, toggleMute, dismiss } = useWebCall();

  const terminal = status === 'ended' || status === 'failed';
  const nonTerminal = status === 'connecting' || status === 'ringing' || status === 'in_progress';
  const connecting = status === 'connecting' || status === 'ringing';

  // Live timer from the answered-at epoch; freezes once terminal.
  const elapsed = useElapsed(active?.startedAt ?? null, !terminal);

  // ── Drag + collapse UI state (shared hook) ────────────────────────────
  // Default expanded whenever a NEW call becomes active — keyed by call id.
  const { containerRef, style, positioned, headerHandlers, collapsed, toggleCollapsed } =
    useDraggablePanel({ sessionKey: 'web', resetKey: active?.jobCallerInfoId ?? null });

  // Auto-dismiss 10s after the call ends (terminal) OR on a pre-call error (no
  // active call). A live/connecting call is NOT auto-hidden — only the X closes
  // it (handleClose hangs up first if still connected).
  React.useEffect(() => {
    const shouldAutoHide = (active && terminal) || (!active && !!error);
    if (!shouldAutoHide) return;
    const t = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [active, terminal, error, dismiss]);

  if (typeof document === 'undefined') return null;
  // Nothing to show: no active call and no pre-call error.
  if (!active && !error) return null;

  const handleClose = () => { if (nonTerminal) hangup(); else dismiss(); };

  const statusLabel = status === 'failed' ? (active?.endedReason || 'Failed') : LABEL[status];

  return createPortal(
    <div
      ref={containerRef}
      role="status"
      aria-live="polite"
      {...CALL_PANEL_ATTR}
      style={style}
      className={cn(
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
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
        </span>

        {collapsed ? (
          // Collapsed pill: status + live timer inline so the operator keeps
          // the essentials at a glance while the panel is out of the way.
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold leading-tight truncate">{statusLabel}</span>
            {active?.startedAt != null && (
              <span className="font-mono tabular-nums text-xs font-semibold text-sidebar-foreground/80">
                {fmtDuration(elapsed)}
              </span>
            )}
          </span>
        ) : (
          <span className="flex-1 text-sm font-semibold leading-tight">Web Call</span>
        )}

        {/* Hangup stays reachable directly from the collapsed pill. */}
        {collapsed && nonTerminal && (
          <button
            type="button"
            onClick={hangup}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded bg-rose-600 text-white hover:bg-rose-700 transition-colors"
            aria-label="Hang up"
            title="Hang up"
          >
            <PhoneOff className="h-3.5 w-3.5" />
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
            onClick={handleClose}
            className="rounded p-1 text-sidebar-foreground/70 hover:bg-white/10 hover:text-sidebar-foreground"
            aria-label={nonTerminal ? 'Hang up and close' : 'Close'}
            title={nonTerminal ? 'Hang up and close' : 'Close'}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body — hidden while collapsed; the call keeps running regardless. */}
      {!collapsed && (
      <div className="px-4 py-3 space-y-3">
        {/* Pre-call error (e.g. web-credentials 409 / web-start failure) */}
        {error && !active && (
          <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1.5">
            {error}
          </div>
        )}

        {active && (
          <>
            {active.name && (
              <div className="text-sm font-medium text-foreground truncate">{active.name}</div>
            )}

            {/* Masked customer number */}
            <div className="flex items-center justify-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
                <Phone className="h-3.5 w-3.5 text-sky-600" aria-hidden />
                <span className="font-mono text-xs font-semibold text-slate-800">{active.toMasked || '—'}</span>
              </span>
            </div>

            {/* Status + live timer. On a failed/declined call show the SPECIFIC
                outcome (Busy / No Answer / …) AS the single red chip — no extra
                "Failed" chip + duplicate reason line. */}
            <div className="flex items-center justify-between gap-2">
              <StatusChip tone={TONE[status]}>
                {statusLabel}
              </StatusChip>
              <div className="flex items-center gap-1.5 text-sm">
                {connecting && <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden />}
                {active.startedAt != null && (
                  <span className="font-mono tabular-nums font-semibold text-slate-700">{fmtDuration(elapsed)}</span>
                )}
              </div>
            </div>

            {/* Controls — only while the call is live */}
            {nonTerminal && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleMute}
                  disabled={status !== 'in_progress'}
                  className={cn(
                    'inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md text-xs font-semibold border transition-colors',
                    muted
                      ? 'bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100'
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50',
                    status !== 'in_progress' && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  {muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                  {muted ? 'Unmute' : 'Mute'}
                </button>
                <button
                  type="button"
                  onClick={hangup}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-md bg-rose-600 text-white text-xs font-semibold shadow-sm hover:bg-rose-700 transition-colors"
                >
                  <PhoneOff className="h-3.5 w-3.5" />
                  Hangup
                </button>
              </div>
            )}
          </>
        )}
      </div>
      )}
    </div>,
    document.body,
  );
}
