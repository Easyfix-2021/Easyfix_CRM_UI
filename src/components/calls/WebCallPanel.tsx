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
import { Phone, Loader2, X, PhoneOff, Mic, MicOff, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtDuration } from '@/lib/format';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { useWebCall, type WebCallStatus } from './WebCallContext';

const TONE: Record<WebCallStatus, StatusChipTone> = {
  idle: 'slate', connecting: 'amber', ringing: 'amber', in_progress: 'sky', ended: 'emerald', failed: 'rose',
};
const LABEL: Record<WebCallStatus, string> = {
  idle: 'Idle', connecting: 'Connecting…', ringing: 'Ringing', in_progress: 'In Progress', ended: 'Call Ended', failed: 'Failed',
};
const AUTO_DISMISS_MS = 4000;

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

  // Auto-dismiss after a call ends.
  React.useEffect(() => {
    if (!active || !terminal) return;
    const t = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [active, terminal, dismiss]);

  if (typeof document === 'undefined') return null;
  // Nothing to show: no active call and no pre-call error.
  if (!active && !error) return null;

  const handleClose = () => { if (nonTerminal) hangup(); else dismiss(); };

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-6 right-6 z-[9998]',
        'w-[320px] max-w-[calc(100vw-3rem)]',
        'rounded-xl border border-slate-200 bg-white shadow-2xl overflow-hidden',
      )}
    >
      {/* Header band — dark slate, mirrors LiveCallPanel + the modal convention. */}
      <div className="flex items-center gap-2.5 bg-sidebar text-sidebar-foreground px-4 py-3">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 ring-1 ring-emerald-400/40 text-emerald-200">
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
        </span>
        <span className="flex-1 text-sm font-semibold leading-tight">Web Call</span>
        <button
          type="button"
          onClick={handleClose}
          className="rounded p-1 text-sidebar-foreground/70 hover:bg-white/10 hover:text-sidebar-foreground"
          aria-label={nonTerminal ? 'Hang up and close' : 'Close'}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

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

            {/* Status + live timer */}
            <div className="flex items-center justify-between gap-2">
              <StatusChip tone={TONE[status]}>{LABEL[status]}</StatusChip>
              <div className="flex items-center gap-1.5 text-sm">
                {connecting && <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden />}
                {active.startedAt != null && (
                  <span className="font-mono tabular-nums font-semibold text-slate-700">{fmtDuration(elapsed)}</span>
                )}
              </div>
            </div>

            {status === 'failed' && active.endedReason && (
              <div className="text-xs text-rose-700">{active.endedReason}</div>
            )}

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
    </div>,
    document.body,
  );
}
