'use client';

/*
 * ConferenceSection — the participant list + "Add To Call" block, and
 * `useConference`, the poll that feeds it.
 *
 * ─── ONE COMPONENT, BOTH CALL PANELS ─────────────────────────────────────
 *
 * <LiveCallPanel> (mobile mode — Plivo rings the operator's phone) and
 * <WebCallPanel> (web mode — the operator talks in the browser) BOTH mount
 * this, with the identical two-prop call shape:
 *
 *     <ConferenceSection conferenceId={call.conferenceId} conf={conf} />
 *
 * There must never be a second copy of this file. Every ops call is a Plivo
 * Multi-Party Call in BOTH modes — `/admin/calls/click-to-call` and
 * `/admin/calls/web-start` each mint a conference and each answer route joins
 * it — so the participant surface is mode-independent by construction. A fork
 * would drift within a month, and this is the surface that dials phone numbers.
 *
 * That is also why the component swallows its own gating (permission → no
 * conference → no state → empty) instead of making each panel restate it: two
 * restatements are two chances to get it wrong, and one of them already was
 * (the fallback notice's condition was unreachable in LiveCallPanel).
 *
 * ─── Why this is a section and not a second panel ────────────────────────
 *
 * Ops does not think of these as two different things. They click Call, it
 * rings, they talk — and at some point they need a third person. The moment
 * that happens the panel they are already looking at grows a roster. Nothing
 * says "conference" until there is someone to add.
 *
 * ─── Dark by default, and that is correct ────────────────────────────────
 *
 * This renders NOTHING participant-shaped unless the live call carries a
 * `conferenceId`. Conference creation is deliberately fail-soft on BOTH call
 * paths, so a call can come back without a room in ANY mode (Plivo disabled,
 * provider is Kaleyra, a DB error) — it still connects, it simply can never
 * gain a participant. A conference problem must never break the call.
 *
 * It is also gated on `isClickToCall` (see conference-types.ts — conferencing
 * shares the CALLING key; there is no separate conference permission). Neither
 * panel does a permission check of its own, so every conference control has to
 * gate itself, and `hasAction` fails closed.
 *
 * ─── One poll drives everything ──────────────────────────────────────────
 *
 * `GET /admin/conferences/:id` returns the conference, its legs AND the roster
 * with each row already flagged `on_call`. The picker therefore needs no fetch
 * of its own, and the "who is allowed" set the FE renders is literally the same
 * derivation the POST enforces — they cannot disagree.
 */

import * as React from 'react';
import { UserPlus, UserMinus, Users, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { StatusChip } from '@/components/ui/StatusChip';
import { AddParticipantPicker } from './AddParticipantPicker';
import {
  participantStatusLabel,
  participantStatusTone,
  targetKindIcon,
  targetKindLabel,
  type ConferenceParticipant,
  type ConferenceStateResp,
  type RemoveParticipantResp,
} from './conference-types';

/* Same cadence as the call-status poll — a leg goes dialling → ringing →
 * joined in a couple of seconds and the operator is watching it happen. */
export const CONFERENCE_POLL_MS = 2000;

export type ConferenceHandle = {
  /*
   * The RBAC gate ALONE — "this operator may see conference surfaces at all".
   * True even for a call that has no room, which is exactly what the
   * can't-add-participants notice keys on: telling someone a capability they
   * never had is missing is just noise, so the notice needs `permitted` while
   * `enabled` (below) is false.
   */
  permitted: boolean;
  /** True when there is a conference id AND the operator may see conferences. */
  enabled: boolean;
  state: ConferenceStateResp | null;
  /** The room is `creating | live | ending`. */
  live: boolean;
  /** Latched — the room reached `ended | failed`. */
  terminal: boolean;
  /** ACTIVE legs that are not the operator's own. Drives End Call vs Hangup. */
  activeOthers: number;
  /** Total ACTIVE legs, operator included (the collapsed pill's badge). */
  activeTotal: number;
  /** Stable across renders — safe to put in a dependency array. */
  refresh: () => void;
};

/*
 * useConference — poll GET /admin/conferences/:id until the room is terminal.
 *
 * Two latches, both load-bearing:
 *   `terminal` — stops the poll once the room has ended, the same way the
 *                call-status poll latches (a transient refetch error must not
 *                un-terminal a finished call).
 *   `dead`     — stops the poll when the FIRST read never succeeded. Without
 *                it, a 403 (not the owner of this call, or the key isn't
 *                seeded) becomes a 403 every 2 seconds for as long as the
 *                panel is open. A later error with data already in hand is
 *                treated as transient and keeps polling.
 */
export function useConference(
  conferenceId: number | null | undefined,
  opts: { enabled?: boolean } = {},
): ConferenceHandle {
  const permitted = opts.enabled !== false;
  const enabled = permitted && conferenceId != null;
  const [terminal, setTerminal] = React.useState(false);

  const key = enabled ? `/admin/conferences/${conferenceId}` : null;
  const { data, error, refetch } = useFetch<ConferenceStateResp>(key, {
    refetchInterval: terminal ? undefined : CONFERENCE_POLL_MS,
  });

  // First read never landed → treat as permanently unavailable and stop.
  const dead = !!error && data == null;

  /*
   * IDENTITY GUARD. `useFetch` deliberately keeps the PREVIOUS key's data
   * mounted across a key change (its anti-flicker rule: never blank a populated
   * surface on a refetch). So between one call ending and the next call's first
   * read landing, `data` is still the previous ROOM — and a payload for a
   * different conference is no more usable here than no payload at all. Render
   * it and the operator sees the last call's roster, and its Remove buttons,
   * under the new call's header. Everything below reads `fresh`, never `data`.
   */
  const fresh = data && data.conference?.id === conferenceId ? data : null;

  /*
   * `terminal` is a LATCH and neither panel keys this component on the call —
   * WebCallPanel mounts once for the whole session — so nothing else would ever
   * lower it. Without this reset the FIRST room to end sets `refetchInterval`
   * to undefined permanently, and every later call in that tab shows whatever
   * its opening read happened to say, forever. Reset on the room, not on
   * unmount, because there is no unmount.
   */
  React.useEffect(() => { setTerminal(false); }, [conferenceId]);

  // Keyed on the GUARDED value: a stale terminal room must not re-latch the
  // flag we just reset for the new one.
  React.useEffect(() => {
    if (fresh?.conference?.terminal) setTerminal(true);
  }, [fresh?.conference?.terminal]);

  React.useEffect(() => {
    if (dead) setTerminal(true);
  }, [dead]);

  /*
   * `refetch` is rebuilt on every render by useFetch, so exposing it directly
   * would make this handle unusable in a dependency array. Bounce it through a
   * ref to hand callers a stable function.
   */
  const refetchRef = React.useRef(refetch);
  React.useEffect(() => { refetchRef.current = refetch; });
  const refresh = React.useCallback(() => { refetchRef.current(); }, []);

  const participants = fresh?.participants ?? [];
  const activeOthers = participants.filter((p) => p.active && p.target_kind !== 'operator').length;
  const activeTotal = participants.filter((p) => p.active).length;

  return {
    permitted,
    enabled,
    state: dead ? null : fresh,
    live: !dead && !!fresh?.conference?.live,
    terminal,
    activeOthers,
    activeTotal,
    refresh,
  };
}

/* ─── the section ───────────────────────────────────────────────────────── */

export function ConferenceSection({
  conferenceId,
  conf,
  operatorPresent,
}: {
  /**
   * The room this CALL belongs to, straight off the call object —
   * `LiveCall.conferenceId` (mobile) or `ActiveWebCall.conferenceId` (web).
   * Null/undefined ⇒ the call is on the classic bridge and gets the notice.
   */
  conferenceId: number | null | undefined;
  /** The poll handle from `useConference(conferenceId, { enabled: canConference })`. */
  conf: ConferenceHandle;
  /*
   * Is the OPERATOR'S OWN leg genuinely up? Each panel knows this and this
   * component cannot: in web mode it is the browser leg's live SDK state, in
   * mobile mode it is the operator's phone leg. Required, not defaulted — a
   * default of `true` would silently arm the button on whichever panel forgot
   * to answer, and that button dials a customer.
   */
  operatorPresent: boolean;
}) {
  const confirm = useConfirm();
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [removingId, setRemovingId] = React.useState<number | null>(null);

  const state = conf.state;
  const live = conf.live;
  const onChanged = conf.refresh;
  const participants = state?.participants ?? [];
  const roster = state?.roster ?? [];
  const activeCount = participants.filter((p) => p.active).length;

  /*
   * Drop one leg and leave the room running. Confirmed first: a mis-tap on a
   * 320px panel would otherwise silently hang up on a customer mid-sentence.
   * The operator's own leg never offers this control (BE: can_remove false) —
   * dropping it would end the room, and End Call is that action.
   */
  const removeParticipant = React.useCallback(async (p: ConferenceParticipant) => {
    if (removingId || conferenceId == null) return;
    const who = p.display_name || targetKindLabel(p.target_kind);
    const ok = await confirm({
      title: 'Remove From Call?',
      description: (
        <p className="text-foreground/85">
          <span className="font-semibold">{who}</span> will be dropped from this call.
          Everyone else stays connected.
        </p>
      ),
      confirmLabel: 'Remove',
      cancelLabel: 'Keep On Call',
      variant: 'destructive',
      icon: <UserMinus className="h-4 w-4" />,
      iconAccent: 'rose',
    });
    if (!ok) return;

    setRemovingId(p.id);
    try {
      const resp = await api.delete<RemoveParticipantResp>(
        `/admin/conferences/${conferenceId}/participants/${p.id}`,
      );
      showToast({ variant: 'success', message: resp.message || 'Removed from the call.' });
      invalidateFetch((k) => k.startsWith('/admin/conferences'));
      onChanged();
    } catch (err) {
      // 409 = the leg exists but hasn't joined yet (no member id) — the BE
      // message says to retry shortly, so show it verbatim.
      showToast({
        variant: 'error',
        message: formatApiError(err, { fallback: 'Could not drop that person from the call.' }),
      });
    } finally {
      setRemovingId(null);
    }
  }, [confirm, conferenceId, onChanged, removingId]);

  /*
   * ─── The gate, in one place, for both panels ──────────────────────────
   *
   * Hooks above, gate below — every early return here is after the last hook,
   * so the order is stable whatever the call turns out to be.
   */

  // No calling permission ⇒ no conference surface of any kind, not even the
  // notice. hasAction fails closed and there is no Admin bypass.
  if (!conf.permitted) return null;

  /*
   * THE FALLBACK NOTICE. A call with no conferenceId works perfectly — it is
   * just on the classic bridge and can never gain a participant, because Plivo
   * cannot upgrade a live <Dial>.
   *
   * Keyed on the CALL, not on the mode. It is tempting to show this when
   * voice.call.mode is one thing or another, but the mode is not the real
   * condition: createConference is deliberately fail-soft on BOTH call paths,
   * so a call can come back without a room in ANY mode (Plivo disabled,
   * provider is Kaleyra, a DB error). One condition covers every cause and
   * cannot go stale when another mode gains conferencing.
   *
   * ⚠ It keys on `permitted`, NOT `enabled`. `enabled` already requires
   * `conferenceId != null`, so `enabled && conferenceId == null` — which is
   * what LiveCallPanel used to test inline — is a contradiction that never
   * rendered. That is the whole reason this gate moved in here.
   */
  if (conferenceId == null) {
    return (
      <div className="text-xs text-warning-strong bg-warning-tint border border-warning rounded px-2 py-1.5">
        This call can&apos;t add participants — it&apos;s connected on the direct bridge.
        Start a new call to conference someone in.
      </div>
    );
  }

  // The room exists but the first read hasn't landed (or 403'd — `state` is
  // null once useConference gives up). Stay quiet rather than render an empty
  // roster: the call itself is unaffected.
  if (!state) return null;
  if (participants.length === 0 && roster.length === 0) return null;

  return (
    <div className="space-y-1.5 border-t border-ink-100 pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
          On This Call
        </span>
        {/*
          * A bare count, with no "/ N" ceiling beside it. The max-participants
          * property was deleted — a conference's ceiling is Plivo's own default,
          * not a number this product sets — so there is nothing to count
          * towards, and a denominator here would invent one.
          */}
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-ink-500">
          <Users className="h-3.5 w-3.5" aria-hidden />
          {activeCount}
        </span>
      </div>

      <ul className="space-y-1" aria-label="Call participants">
        {participants.map((p) => {
          const Icon = targetKindIcon(p.target_kind);
          const busy = removingId === p.id;
          return (
            <li
              key={p.id}
              className={cn(
                'flex items-center gap-2 rounded-md border px-2 py-1.5',
                p.active ? 'border-ink-100 bg-ink-50' : 'border-ink-100/70 bg-card opacity-70',
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-ink-500" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-ink-900">
                  {p.display_name || targetKindLabel(p.target_kind)}
                </div>
                {/* Masked, always. There is no unmasked form on this wire. */}
                <div className="truncate font-mono text-xs text-ink-500">
                  {p.masked_number || '—'}
                </div>
              </div>
              <StatusChip tone={participantStatusTone(p.status)} size="sm">
                {participantStatusLabel(p.status)}
              </StatusChip>
              {live && p.can_remove && (
                <button
                  type="button"
                  onClick={() => void removeParticipant(p)}
                  disabled={busy || removingId != null}
                  className={cn(
                    'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded',
                    'text-ink-500 hover:bg-urgent/15 hover:text-urgent-strong transition-colors',
                    (busy || removingId != null) && 'opacity-50 cursor-not-allowed',
                  )}
                  aria-label={`Remove ${p.display_name || targetKindLabel(p.target_kind)} from the call`}
                  title="Remove From Call"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {/*
        * `live` describes the ROOM, not the operator. A room stays live with the
        * operator's own leg dead — that is exactly the failure this feature was
        * shipped through — and adding then dials a customer into a conference
        * with no agent in it, which is worse than not adding at all. So the
        * button needs BOTH facts.
        *
        * Only the button is disarmed. The Remove controls above stay reachable
        * on purpose: an operator who has fallen off a room still has to be able
        * to clear the people left in it.
        */}
      {live && (
        <>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            disabled={!operatorPresent}
            className={cn(
              'mt-1 w-full inline-flex items-center justify-center gap-1.5 h-8 rounded-md',
              'border text-xs font-semibold transition-colors',
              operatorPresent
                ? 'border-success bg-success-tint text-success-strong hover:bg-success/15'
                : 'border-ink-100 bg-ink-100 text-ink-500 cursor-not-allowed',
            )}
            title={operatorPresent ? 'Add To Call' : 'You are not connected to this call'}
          >
            <UserPlus className="h-3.5 w-3.5" aria-hidden />
            Add To Call
          </button>
          {!operatorPresent && (
            <p className="text-xs text-warning-strong">
              You&apos;re not connected to this call, so anyone you added would be alone on it.
              End it and call again to add someone.
            </p>
          )}
        </>
      )}

      {/* Always mounted (Radix renders nothing while closed) so the dialog
          keeps its open/close animation; it resets its own state on open. */}
      <AddParticipantPicker
        open={pickerOpen}
        conferenceId={conferenceId}
        roster={roster}
        jobless={state.conference?.job_id == null}
        onCancel={() => setPickerOpen(false)}
        onAdded={onChanged}
      />
    </div>
  );
}
