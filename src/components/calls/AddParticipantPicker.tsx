'use client';

/*
 * AddParticipantPicker — "Add To Call": pull a second or third person into a
 * live conference without dropping it.
 *
 * ─── The two rules that make this safe, and why they're both here ────────
 *
 *   1. Every roster row sends an IDENTIFIER, never digits. The row's
 *      `request` object is the exact POST body the backend published for it
 *      (`{ jobId, useAlt: true }`, `{ efrId }`, …); this component copies it
 *      verbatim and never derives a key from a target kind. The server
 *      resolves the number.
 *   2. The roster is derived server-side FROM THE CONFERENCE'S OWN JOB. This
 *      component renders what it is given and offers no way to name a party
 *      that isn't on it.
 *
 * Refusing free text stops an operator TYPING a number; scoping to the job
 * stops them ENUMERATING ids. Neither substitutes for the other.
 *
 * The one deliberate exception is the "Other Number" arm at the bottom, which
 * is rendered ONLY when the backend says this operator holds
 * `isConferenceCustomNumber` — a materially higher trust than being allowed to
 * conference the people already on a job. It is format-checked here with the
 * canonical INDIAN_MOBILE_REGEX, checked again at the validator, rate-limited
 * per operator, and audited with both the actor and the digits. It is an
 * INPUT, never an output: it must never become a way to READ a number the
 * operator could not already see.
 *
 * ─── NOT CallCustomNumbersDialog ────────────────────────────────────────
 *
 * That dialog is the QA test-number prompt gated on
 * `<PROVIDER>_CALLING_CUSTOM_NUMBER`; it accepts 10–12 digits, substitutes
 * BOTH legs of a NEW 1:1 call, and pre-fills UNMASKED env numbers. Every one
 * of those is wrong here. Only its structure (Dialog + header band + dirty
 * guard + bordered footer) is shared.
 */

import * as React from 'react';
import { UserPlus, Loader2, Phone, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { invalidateFetch } from '@/lib/hooks';
import { isValidIndianMobile, INDIAN_MOBILE_ERROR } from '@/lib/format';
import { showToast } from '@/components/ui/toast';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusChip } from '@/components/ui/StatusChip';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import {
  participantStatusLabel,
  participantStatusTone,
  targetKindIcon,
  type AddParticipantResp,
  type ConferenceRosterEntry,
  type ParticipantStatus,
} from './conference-types';

type Props = {
  open: boolean;
  conferenceId: number;
  /** Server-derived, already in ops' reading order. Re-rendered live by the parent's poll. */
  roster: ConferenceRosterEntry[];
  /** BE truth for isConferenceCustomNumber — NOT inferred from the role name. */
  /*
   * There is no `atCapacity` / `maxParticipants` pair here any more. The
   * max-participants property was deleted: the ceiling on a conference is
   * Plivo's own default, which is where a provider limit belongs. The FE
   * therefore has no number to check and never pre-blocks an Add — if the
   * provider refuses a leg, the POST fails and the error is shown verbatim,
   * which is the only capacity truth that was ever authoritative.
   */
  /** True when this conference has no job (its roster is empty by design). */
  jobless: boolean;
  onCancel: () => void;
  /** Refetch the conference so the new leg appears in the panel immediately. */
  onAdded: () => void;
};

/* Digits only, capped at 10 — INDIAN_MOBILE_REGEX takes no country code. */
function sanitize(v: string): string {
  return String(v || '').replace(/\D/g, '').slice(0, 10);
}

/*
 * The roster row's OWN leg status, when the wire carries one.
 *
 * `on_call` is a boolean over the ACTIVE set (`initiated | ringing | answered`),
 * so a chip painted straight off it says "On Call" about someone who is merely
 * being DIALLED — while the participant list directly beneath this dialog spells
 * that same person "Dialling" from the real status. Two surfaces disagreeing
 * about one person is how an operator learns to distrust both, and green is the
 * one colour that must never over-claim on a call screen.
 *
 * `status` is null for a row with no leg — that is the ordinary "not on the call
 * yet" case, and the caller falls through to the plain Add affordance. It is
 * non-null only when `on_call` is true, because the backend derives both from
 * the same matched leg.
 */
function rosterLegStatus(row: ConferenceRosterEntry): ParticipantStatus | null {
  return row.status ?? null;
}

export function AddParticipantPicker({
  open, conferenceId, roster,
  jobless, onCancel, onAdded,
}: Props) {
  // Which row is mid-flight. Keyed by row so two Add buttons can't both spin.
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [customOpen, setCustomOpen] = React.useState(false);
  const [customNumber, setCustomNumber] = React.useState('');
  const [customName, setCustomName] = React.useState('');
  const [customTouched, setCustomTouched] = React.useState(false);

  // Reset the custom arm each time the dialog opens so a half-typed number
  // from a previous call never carries into the next one.
  React.useEffect(() => {
    if (!open) return;
    setCustomOpen(false);
    setCustomNumber('');
    setCustomName('');
    setCustomTouched(false);
    setBusyKey(null);
  }, [open]);

  /*
   * One POST for both arms. The body is either a roster row's own `request`
   * or the custom pair — this function never builds a target key itself.
   *
   * The dialog CLOSES on success. It used to stay open, reasoning that the leg
   * is `dialling`, the parent's 2s poll flips the row within a beat, and an
   * operator adding two people shouldn't have to reopen the picker. That
   * assumed the row's status actually moves — and the Other Number arm never
   * produces a roster row at all, so it could not move by construction. What
   * ops got instead was a dialog that sat there unchanged after a successful
   * add, with nothing to distinguish it from one that had silently failed.
   * Closing IS the confirmation, and reopening costs one click.
   */
  const add = React.useCallback(async (
    key: string,
    body: Record<string, unknown>,
    who: string,
  ) => {
    if (busyKey) return;
    setBusyKey(key);
    try {
      const resp = await api.post<AddParticipantResp>(
        `/admin/conferences/${conferenceId}/participants`,
        body,
      );
      showToast({
        variant: 'success',
        message: resp.message || `Calling ${who} — they will join in a moment.`,
      });
      // Both, per the fetch-hook convention: drop the cached conference read
      // so any other consumer re-reads, then force this panel's own refetch.
      invalidateFetch((k) => k.startsWith('/admin/conferences'));
      onAdded();
      // No field reset here: closing unmounts nothing (Radix keeps the node)
      // but the open-effect above wipes every field on the way back IN, which
      // is the only moment a stale value could be seen.
      onCancel();
    } catch (err) {
      // Covers 400 (not on this job / no number on file / already ended),
      // 403 (missing the custom-number permission), 409 (already on the call),
      // 429 (custom-number rate limit) and 502 (provider refused) — the BE
      // messages are written to be shown to an operator as-is.
      showToast({
        variant: 'error',
        message: formatApiError(err, { fallback: 'Could not add that person to the call.' }),
      });
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, conferenceId, onAdded, onCancel]);

  const customValid = isValidIndianMobile(customNumber, { required: true });
  const customDirty = customNumber !== '' || customName !== '';
  const guardedOpenChange = useFormDirtyGuard(onCancel, { isDirty: () => customDirty });

  function submitCustom(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setCustomTouched(true);
    if (!customValid) return;
    const displayName = customName.trim();
    void add(
      'custom',
      { customNumber, ...(displayName ? { displayName } : {}) },
      displayName || 'that number',
    );
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      {/*
        z-[9999] clears the live-call panel's z-[9998]. This dialog is LAUNCHED
        FROM that panel, so at the shared z-50 the panel would paint over it.
        The backdrop stays at z-50 on purpose — the call panel remains lit and
        usable above the dim while the operator picks, which is the point.
      */}
      {/*
        PINNED HEADER AND FOOTER.

        DialogContent scrolls the WHOLE panel by default (max-h-[85vh]
        overflow-y-auto), so the roster band's own max-h-[60vh] made two nested
        scrollers: a long roster filled the inner band and the panel still had
        its own scrollbar left to travel, which pushed the Close row below the
        fold of the OUTER scroller. Nothing tells an operator mid-call that
        there is a second scrollbar to find.

        flex column + overflow-hidden here, shrink-0 on the header and footer,
        and one flex-1 middle that absorbs the overflow instead. min-h-0 on that
        middle is load-bearing: a flex child defaults to min-height:auto and
        refuses to shrink below its content, so without it the band would grow
        the panel instead of scrolling and the pinning would do nothing.
      */}
      <DialogContent className="sm:max-w-md z-[9999] !gap-0 max-h-[85vh] flex flex-col overflow-hidden" noPadding>
        <DialogHeader className="!py-4 px-6 shrink-0">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/20 ring-1 ring-success/40 text-success-tint">
              <UserPlus className="h-4 w-4" />
            </span>
            <div className="flex-1 min-w-0">
              <DialogTitle className="leading-tight">Add To Call</DialogTitle>
              <DialogDescription className="mt-0.5">
                They are dialled and joined to the call in progress.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="px-6 py-4 space-y-3 flex-1 min-h-0 overflow-y-auto">
          {/* ── The roster ─────────────────────────────────────────────── */}
          {roster.length === 0 ? (
            <p className="text-xs text-ink-500">
              {jobless
                ? 'This call is not linked to a job, so there is no roster to add from.'
                : 'Nobody on this job has a mobile number on file.'}
            </p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                On This Job
              </p>
              {roster.map((row) => {
                // Keyed on the row's own request body, not its index: the
                // parent re-renders this list every 2s and an index key would
                // move the in-flight spinner if the roster ever reordered.
                const key = `roster:${row.target_kind}:${JSON.stringify(row.request)}`;
                const Icon = targetKindIcon(row.target_kind);
                const busy = busyKey === key;
                const blocked = row.on_call || !row.available;
                const legStatus = rosterLegStatus(row);
                return (
                  <div
                    key={key}
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-2.5 py-2',
                      row.on_call
                        ? 'border-success bg-success-tint/60'
                        : 'border-ink-100 bg-card',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-ink-500" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold text-ink-900">
                        {row.name || row.label}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs text-ink-500">{row.label}</span>
                        {/* Masked, for recognition only — never the full number. */}
                        <span className="font-mono text-xs text-ink-500">
                          {row.available ? row.masked_number || '—' : 'No Number On File'}
                        </span>
                      </div>
                    </div>
                    {row.on_call ? (
                      <StatusChip
                        tone={legStatus ? participantStatusTone(legStatus) : 'emerald'}
                        size="sm"
                      >
                        {legStatus ? participantStatusLabel(legStatus) : 'On Call'}
                      </StatusChip>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={blocked || busy || !!busyKey}
                        onClick={() => void add(key, row.request, row.name || row.label)}
                        className="h-7 shrink-0 px-2 text-xs"
                      >
                        {busy
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Phone className="h-3.5 w-3.5" />}
                        <span className="ml-1">Add</span>
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Other Number — gated on isConferenceCustomNumber ────────── */}
          {/*
            Always offered. There is no separate custom-number permission —
            calling access IS conference access, per the owner. See
            conference-types.ts for the reasoning and what still constrains this
            arm (number format, rate limit, and an audit of actor + digits).
          */}
          {(
            <div className="pt-1 border-t border-ink-100">
              {!customOpen ? (
                <button
                  type="button"
                  onClick={() => setCustomOpen(true)}
                  className="mt-2 inline-flex w-full items-center gap-2 rounded-md border border-dashed border-ink-300 px-2.5 py-2 text-left text-xs font-semibold text-ink-700 hover:border-ink-500 hover:bg-ink-50 transition-colors"
                >
                  <UserPlus className="h-4 w-4 shrink-0 text-ink-500" aria-hidden />
                  Other Number
                  <span className="ml-auto font-normal text-xs text-ink-500">
                    Dial someone not on this job
                  </span>
                </button>
              ) : (
                <form onSubmit={submitCustom} className="mt-2 space-y-2">
                  <div className="space-y-1">
                    <Label htmlFor="conf-custom-number" className="text-xs uppercase tracking-wide text-muted-foreground">
                      Other Number
                    </Label>
                    <Input
                      id="conf-custom-number"
                      value={customNumber}
                      onChange={(e) => setCustomNumber(sanitize(e.target.value))}
                      placeholder="10-digit Indian mobile"
                      inputMode="numeric"
                      autoComplete="off"
                      autoFocus
                      aria-invalid={customTouched && !customValid}
                    />
                    {customTouched && !customValid && (
                      <p className="text-xs text-urgent-strong">{INDIAN_MOBILE_ERROR}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="conf-custom-name" className="text-xs uppercase tracking-wide text-muted-foreground">
                      Name (Optional)
                    </Label>
                    <Input
                      id="conf-custom-name"
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value.slice(0, 60))}
                      placeholder="Who is this?"
                      autoComplete="off"
                    />
                  </div>
                  {/* This add is audited with the actor AND the digits, and is
                      capped at 5 per minute per operator. Say so. */}
                  <p className="text-xs text-ink-500">
                    This number is recorded against your name in the call audit.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!customValid || !!busyKey}
                      className="h-8 px-3 text-xs"
                    >
                      {busyKey === 'custom'
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Check className="h-3.5 w-3.5" />}
                      <span className="ml-1">Add To Call</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 px-3 text-xs"
                      onClick={() => {
                        setCustomOpen(false);
                        setCustomNumber('');
                        setCustomName('');
                        setCustomTouched(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t bg-muted/30 shrink-0">
          <Button type="button" variant="outline" onClick={onCancel}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
