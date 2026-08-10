'use client';

/*
 * WebCallPanel — fixed bottom-right card for the active BROWSER (WebRTC) call.
 *
 * Mounted once at the authed root (next to <LiveCallPanel/>). Renders nothing
 * until useWebCall() has an active call (web mode only). Unlike LiveCallPanel
 * (which polls the BE), this is driven entirely by Plivo Browser SDK events
 * surfaced through WebCallContext — so status + timer update in real time with
 * no polling. Offers Mute + Hangup while the leg is up, "End Call For Everyone"
 * when the leg has died under a room that has not; auto-dismisses a few seconds
 * after the call ends.
 *
 * CONFERENCE (2026-08):
 *   Every ops call is a Plivo Multi-Party Call in BOTH call modes — web-start
 *   mints the room exactly like click-to-call does — so this panel mounts the
 *   SAME <ConferenceSection> LiveCallPanel does, with the same two props. There
 *   is deliberately no web-specific copy of that surface: it is the thing that
 *   dials phone numbers, and a fork of it would drift.
 *
 *   The one thing that genuinely differs from mobile is what HANGING UP means.
 *   The operator's leg carries endMpcOnExit="true", so in web mode the browser
 *   IS the operator's leg and dropping it ends the room for everyone. The
 *   Hangup button therefore renames itself once anyone else is on the line, and
 *   the X — which reads as "close", not "end" — asks first.
 *
 * THE OPERATOR'S LEG CAN DIE UNDER A LIVE ROOM, AND THIS PANEL MUST SAY SO.
 *   A browser leg that fails at signalling (Plivo with no Voice Application to
 *   route it to answers the SDK with a bare "Busy") leaves the room running
 *   with everyone Add-To-Call put in it — talking, and billing — while the
 *   operator is not on it. Two things follow, and both are load-bearing:
 *   the header must not count a dead leg as a person on the call, and the panel
 *   must still offer a way to end the room. Getting either wrong turns the
 *   panel into a lie the operator has no control over.
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Phone, Loader2, X, PhoneOff, Mic, MicOff, Globe, GripVertical, Minus, Maximize2, Users, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { invalidateFetch } from '@/lib/hooks';
import { fmtDuration } from '@/lib/format';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { CALL_PANEL_ATTR } from '@/lib/portal-markers';
import { useWebCall, type WebCallStatus } from './WebCallContext';
import { useDraggablePanel } from './useDraggablePanel';
import { useConference, ConferenceSection } from './ConferenceSection';
import { ACTION_CONFERENCE, type EndConferenceResp } from './conference-types';

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
  const { status, active, muted, error, configWarnings, hangup, toggleMute, dismiss } = useWebCall();
  const { me } = useMe();
  const confirm = useConfirm();
  const [endingRoom, setEndingRoom] = React.useState(false);
  const [endRoomErr, setEndRoomErr] = React.useState<string | null>(null);

  const terminal = status === 'ended' || status === 'failed';
  const nonTerminal = status === 'connecting' || status === 'ringing' || status === 'in_progress';
  const connecting = status === 'connecting' || status === 'ringing';

  // Live timer from the answered-at epoch; freezes once terminal.
  const elapsed = useElapsed(active?.startedAt ?? null, !terminal);

  /*
   * ── Conference (additive; dark unless the call carries a conferenceId) ──
   *
   * Identical wiring to LiveCallPanel, deliberately: the same hook, the same
   * permission key, the same handle. The panel does no permission check of its
   * own — anyone who placed a call sees it — so the conference surface gates
   * ITSELF, and hasAction fails closed with no Admin bypass.
   *
   * `active?.conferenceId` is undefined between calls, which disables the poll.
   */
  const canConference = hasAction(me, ACTION_CONFERENCE);
  const conf = useConference(active?.conferenceId, { enabled: canConference });
  // Someone other than the operator is actually on the line. A 1-participant
  // MPC is EVERY ops call, so this — not "is there a conference" — is what
  // makes hanging up a multi-party act.
  const othersOnCall = conf.live && conf.activeOthers > 0;

  /*
   * ── Is the operator ACTUALLY on this call? ────────────────────────────
   *
   * The browser SDK is the only honest source. `conf.activeTotal` is not: it
   * counts the operator's own leg from the server's view of the room, and that
   * view survives the leg dying — a browser leg that fails at signalling is
   * never reported to Plivo as ended, so the server keeps counting it. That is
   * how a call the operator was never on rendered as "Web Conference (2)".
   *
   * So: presence comes from the SDK, and the head-count drops the operator
   * whenever the SDK says the operator is not on. `activeOthers` already
   * excludes the operator leg, which makes it the honest floor.
   */
  const operatorPresent = status === 'in_progress';
  const headCount = operatorPresent ? conf.activeTotal : conf.activeOthers;
  /*
   * The alarming case: the operator's leg is over, the room is not. People are
   * on a call the operator cannot hear, and the panel is the only handle on it.
   *
   * `conf.activeOthers > 0` IS THE POINT, not a refinement. `conf.live` only
   * says our conference ROW is non-terminal, and that row starts at 'creating'
   * the moment a call is placed — before Plivo has been asked for anything. So
   * a call that fails at signalling leaves a row nobody will ever move, and the
   * first version of this line read that as a stranded room: the panel showed
   * "Call Running Without You" over "ON THIS CALL 0" and offered to End Call
   * For Everyone on a conference Plivo had never heard of. Alarming and false is
   * worse than the over-count it replaced — the operator cannot tell which
   * alarms to trust after the first one turns out to be nothing.
   *
   * Somebody has to actually be on the line for a room to be stranded.
   */
  const strandedRoom = terminal && conf.live && conf.activeOthers > 0;
  const showHeadCount = headCount > 1 || (strandedRoom && headCount > 0);
  const headerTitle = strandedRoom ? 'Call Running Without You'
    : headCount > 1 ? 'Web Conference'
      : 'Web Call';

  /*
   * ── Which telephony control the panel offers ──────────────────────────
   *
   * One derivation, so the label, the enabled-ness and the endpoint can never
   * disagree — the same discipline as LiveCallPanel's `endMode`, with the arms
   * web mode actually has:
   *
   *   'live'      the leg is up: Mute + Hangup, exactly as before. Hanging up
   *               ends the room anyway (endMpcOnExit), so there is no separate
   *               end-the-room action to offer here.
   *   'end-room'  the leg is terminal but PEOPLE ARE STILL ON the room. Until
   *               now this rendered NO control at all — the panel stayed pinned
   *               open (auto-dismiss is suppressed while the room lives) with
   *               the participants talking and billing and nothing to press.
   *               This arm is the fix.
   *   'none'      nothing left to end.
   *
   * Gated on `strandedRoom`, NOT on `conf.live` alone. A conference row is
   * 'creating' from the instant a call is placed, so a call that failed at
   * signalling satisfies `conf.live` with an empty room — and this offered a
   * destructive "End Call For Everyone" for a conference Plivo never created.
   * Pressing it fires a DELETE that 404s; harmless, but a red button that does
   * nothing teaches the operator that the red button does nothing.
   */
  const controlMode: 'none' | 'live' | 'end-room' =
    nonTerminal ? 'live'
      : strandedRoom && active?.conferenceId != null ? 'end-room'
        : 'none';

  // ── Drag + collapse UI state (shared hook) ────────────────────────────
  // Default expanded whenever a NEW call becomes active — keyed by call id.
  const { containerRef, style, positioned, headerHandlers, collapsed, toggleCollapsed } =
    useDraggablePanel({ sessionKey: 'web', resetKey: active?.jobCallerInfoId ?? null });

  /*
   * Auto-dismiss 10s after the call ends (terminal) OR on a pre-call error (no
   * active call). A live/connecting call is NOT auto-hidden — only the X closes
   * it (handleClose hangs up first if still connected).
   *
   * SUPPRESSED WHILE PEOPLE ARE STILL ON THE ROOM, in the spirit of
   * LiveCallPanel. The browser leg can reach a terminal status while the
   * conference has not been torn down yet, and this panel is the ONLY handle
   * the FE has on that room — there is no reattach path. Silently hiding it
   * would leave legs billing with no way back to the Remove controls.
   *
   * Keyed on `strandedRoom`, not on `conf.live`. The row is 'creating' from the
   * moment a call is placed, so gating on liveness alone pinned this panel open
   * forever after a call that failed at signalling — an empty, dead call the
   * operator had to dismiss by hand, wearing the suppression meant for a real
   * one. There is nothing to protect when nobody is on the line.
   */
  React.useEffect(() => {
    const shouldAutoHide = (active && terminal) || (!active && !!error);
    if (!shouldAutoHide) return;
    if (active && strandedRoom) return;
    const t = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [active, terminal, error, dismiss, strandedRoom]);

  /*
   * ── Closing the panel ──
   *
   * On this panel X has always meant "hang up and close" while the call is
   * live — and in web mode the browser IS the operator's leg, which carries
   * endMpcOnExit="true", so that hangup ends the room for EVERYONE. With a
   * third person on the line a mis-click on a 320px panel would drop a customer
   * mid-sentence, so it asks first and says what it will do.
   *
   * And when the operator's own leg is already dead under a live room, X does
   * something different but no less serious: it only HIDES the panel, and there
   * is no reattach path, so the room keeps running with nobody able to reach
   * the End Call control again. That case gets its own prompt — it must not
   * claim the close will end anything.
   *
   * The panel sits ABOVE the confirm's backdrop (z-9998 vs z-50), so its X
   * stays clickable while the prompt is open. Without this guard a second click
   * would open a second confirm and strand the first promise.
   */
  const closingRef = React.useRef(false);
  const handleClose = React.useCallback(async () => {
    if (closingRef.current) return;
    if (nonTerminal && othersOnCall) {
      closingRef.current = true;
      const ok = await confirm({
        title: 'End This Call?',
        description: (
          <p className="text-foreground/85">
            The call is running with {headCount} people on it. Closing this panel
            hangs you up, which <span className="font-semibold">ends the call for
            everyone</span> on it.
          </p>
        ),
        confirmLabel: 'End Call For Everyone',
        cancelLabel: 'Keep It Open',
        variant: 'destructive',
        icon: <Users className="h-4 w-4" />,
        iconAccent: 'amber',
      });
      closingRef.current = false;
      if (!ok) return;
    } else if (strandedRoom) {
      closingRef.current = true;
      const ok = await confirm({
        title: 'Close This Panel?',
        description: (
          <p className="text-foreground/85">
            Your line has dropped, but the call is still running
            {headCount > 0 ? ` with ${headCount} other people on it` : ''}. Closing only
            hides this panel — it does <span className="font-semibold">not</span> end the
            call, and you will not be able to reopen it. Use End Call For Everyone to
            hang up for everyone.
          </p>
        ),
        confirmLabel: 'Close Panel',
        cancelLabel: 'Keep It Open',
        variant: 'destructive',
        icon: <Users className="h-4 w-4" />,
        iconAccent: 'amber',
      });
      closingRef.current = false;
      if (!ok) return;
    }
    if (nonTerminal) hangup(); else dismiss();
  }, [nonTerminal, othersOnCall, headCount, strandedRoom, confirm, hangup, dismiss]);

  /*
   * ── End Call For Everyone (the 'end-room' arm) ────────────────────────
   *
   * Ported from LiveCallPanel's conference teardown rather than reinvented:
   * same endpoint, same `verified:false` handling. `verified:false` means Plivo
   * accepted the teardown but still reports the room, and the operator is told
   * that rather than being told "ended" while legs are still billing.
   *
   * No confirm: the button already says it ends the call for everyone, and the
   * operator it would otherwise protect is not on the call to protect.
   */
  const endRoom = React.useCallback(async () => {
    const conferenceId = active?.conferenceId;
    if (endingRoom || conferenceId == null) return;
    setEndingRoom(true); setEndRoomErr(null);
    try {
      const resp = await api.post<EndConferenceResp>(`/admin/conferences/${conferenceId}/end`);
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
    } catch (err) {
      // 502 = the room is still reported live after the teardown.
      setEndRoomErr(formatApiError(err, { fallback: 'Could not end the call.' }));
    } finally {
      setEndingRoom(false);
    }
  }, [endingRoom, active?.conferenceId, conf]);

  if (typeof document === 'undefined') return null;
  // Nothing to show: no active call and no pre-call error.
  if (!active && !error) return null;

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
            {/* Head-count while minimised — the one thing about a conference
                the operator must not lose sight of behind a pill. Excludes the
                operator's own leg once that leg is no longer up (see
                `headCount`), so a dead leg can never pad the number. */}
            {showHeadCount && (
              <span className="inline-flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-px text-[10px] font-semibold text-sidebar-foreground/80">
                <Users className="h-3 w-3" aria-hidden />
                {headCount}
              </span>
            )}
          </span>
        ) : (
          <span className="flex-1 flex items-center gap-2 text-sm font-semibold leading-tight">
            <span className={cn(strandedRoom && 'text-amber-300')}>{headerTitle}</span>
            {showHeadCount && (
              <span className="inline-flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-px text-[10px] font-semibold text-sidebar-foreground/80">
                <Users className="h-3 w-3" aria-hidden />
                {headCount}
              </span>
            )}
          </span>
        )}

        {/* Teardown stays reachable directly from the collapsed pill — including
            the 'end-room' arm, which is the case most likely to be minimised
            and forgotten about. */}
        {collapsed && controlMode !== 'none' && (
          <button
            type="button"
            onClick={controlMode === 'end-room' ? () => void endRoom() : hangup}
            disabled={endingRoom}
            className={cn(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded bg-rose-600 text-white hover:bg-rose-700 transition-colors',
              endingRoom && 'opacity-60 cursor-wait',
            )}
            aria-label={controlMode === 'end-room' || othersOnCall ? 'End call for everyone' : 'Hang up'}
            title={controlMode === 'end-room' || othersOnCall ? 'End Call For Everyone' : 'Hang Up'}
          >
            {endingRoom ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PhoneOff className="h-3.5 w-3.5" />}
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

        {/*
          ── Why calls from this browser will fail ──

          The server already worked this out and logged it; the FE used to throw
          it away, which left "Busy" as the operator's entire diagnosis. Shown
          ABOVE the status chip because it EXPLAINS that chip: with an unset
          PLIVO_WEB_APP_ID every call fails as Busy without the receiver's phone
          ever ringing, and no amount of retrying changes that.

          Two registers on purpose. The first line is for the operator, who
          needs to know to stop retrying and who to tell. The raw server text
          below it is for whoever they tell — it names the missing setting, so
          it has to survive being copied verbatim rather than be paraphrased
          into something support can't act on.
        */}
        {configWarnings.length > 0 && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Web Calling Is Not Set Up On This Server
            </div>
            <p>
              Calls from this browser will keep failing until IT fixes the setup — retrying
              won&apos;t help. Please report it with the details below.
            </p>
            <ul className="list-disc pl-4 space-y-0.5 text-amber-900/90">
              {configWarnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
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

            {/*
              Participant list + Add To Call — or, for a call with no room, the
              can't-add-participants notice. THE SAME COMPONENT LiveCallPanel
              mounts, with the same two props. Every gate (permission → no
              conference → no state → empty roster) lives inside it, so mobile
              and web cannot disagree about when the surface appears — which is
              the entire point of it not being copied here.

              `operatorPresent` is the browser SDK's own verdict on whether this
              operator's leg is really up. The section cannot work that out from
              `conf` alone: the server keeps counting a browser leg that died at
              signalling, because nothing ever told it otherwise.
            */}
            <ConferenceSection
              conferenceId={active.conferenceId}
              conf={conf}
              operatorPresent={operatorPresent}
            />

            {/* Teardown error (e.g. 502 — the room is still reported live).
                Bound to the control it came from: this panel is mounted once at
                the root and never remounts per call, so an unbound error would
                still be sitting there during the operator's NEXT call. */}
            {endRoomErr && controlMode === 'end-room' && (
              <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
                {endRoomErr}
              </div>
            )}

            {/* Controls — while the operator's leg is live */}
            {controlMode === 'live' && (
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
                {/*
                  The operator's leg carries endMpcOnExit="true", so in web mode
                  hanging the BROWSER up ends the room for everyone on it. Say
                  so on the button rather than confirming: the operator leaving
                  would end the room anyway, and a label that tells the truth
                  beats a dialog that interrupts every call.
                */}
                <button
                  type="button"
                  onClick={hangup}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-md bg-rose-600 text-white text-xs font-semibold shadow-sm hover:bg-rose-700 transition-colors"
                >
                  <PhoneOff className="h-3.5 w-3.5" />
                  {othersOnCall ? 'End Call For Everyone' : 'Hangup'}
                </button>
              </div>
            )}

            {/*
              The operator's leg is over but the room is not. There is nothing
              left to mute and nothing left to hang up — the only thing the
              operator can still do to this call is stop it, so that is the only
              button. Without it the panel sits open (auto-dismiss is suppressed
              while the room lives) offering no control over a call that is
              still running and still billing.
            */}
            {controlMode === 'end-room' && (
              <button
                type="button"
                onClick={() => void endRoom()}
                disabled={endingRoom}
                className={cn(
                  'w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-md',
                  'bg-rose-600 text-white text-xs font-semibold shadow-sm',
                  'hover:bg-rose-700 transition-colors',
                  endingRoom && 'opacity-60 cursor-wait',
                )}
              >
                {endingRoom
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <PhoneOff className="h-3.5 w-3.5" />}
                {endingRoom ? 'Ending Call…' : 'End Call For Everyone'}
              </button>
            )}
          </>
        )}
      </div>
      )}
    </div>,
    document.body,
  );
}
