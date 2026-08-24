'use client';

/*
 * EasyfixerBankDialog — operator-driven change of a technician's bank
 * account, from the Manage Easyfixers row action menu.
 *
 * DEFAULT FLOW IS ONE STEP: fill the details, hit Verify & Update. The OTP
 * step still exists (see OTP_REQUIRED_DEFAULT below) but is off by default.
 *
 * Backend contract:
 *   POST  /admin/easyfixers/:id/bank/otp   200 → { sent: true }
 *         (the OTP goes to the TECHNICIAN's registered WhatsApp — not to
 *          the operator; the copy in step 2 says so explicitly)
 *   PATCH /admin/easyfixers/:id/bank
 *         body { accountNumber, ifsc, bankName, accountHolderName, reason,
 *                otp? }                    ← otp is OPTIONAL server-side now
 *         200 → { account_number_masked, ifsc, bank_id, account_holder_name,
 *                 verified, changed, name_match, name_score, otp_verified }
 *         400 → OTP invalid / expired          (nothing was changed; only
 *                                                reachable when the OTP
 *                                                property is ON)
 *         422 → bank verification failed / account does not exist
 *                                               (nothing was changed; the
 *                                                message carries the vendor's
 *                                                own reason)
 *         503 → vendor key unconfigured         (nothing was changed)
 *         504 → vendor timed out                (nothing was changed)
 *
 * The four failure codes are rendered as FOUR DISTINCT states because the
 * operator's next move differs in each:
 *   400 → the code is wrong/stale. Re-enter or resend the OTP; details stay.
 *   422 → the account details are wrong. Go back and fix them; a resend
 *         won't help, so the primary button becomes "Correct Bank Details".
 *   503 → misconfiguration on our side. Nothing the operator can fix by
 *         retyping; raise it rather than loop.
 *   504 → nothing is wrong with the input. Retry in a moment; the primary
 *         button becomes "Retry Verification".
 * Collapsing them into one "something went wrong" would send the operator
 * down the wrong path three times out of four.
 *
 * name_match is ADVISORY, never a failure: a 200 means the change is already
 * committed. A 'mismatch' holds the dialog open on a warning panel so the
 * operator knows the row needs review; a 'match' just closes with a toast.
 *
 * After a successful save the account number is never echoed back in full —
 * the confirmation toast shows the last 4 digits only.
 *
 * Conventions honoured: shared Dialog / Input / Label / Button primitives,
 * showToast (never native alert/confirm), Title Case labels, invalidateFetch
 * after the mutation, and the close paths routed through useFormDirtyGuard
 * (an inline onOpenChange arrow is a hard eslint error in this repo).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Landmark, ShieldAlert, Timer, WifiOff } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { invalidateFetch, useUiFlags } from '@/lib/hooks';
import { api, ApiError } from '@/lib/api';
import { formatEasyfixerName } from '@/lib/utils';

export type EasyfixerBankTarget = {
  efr_id: number;
  efr_name: string;
};

/*
 * Does this dialog collect an OTP?
 *
 * The SERVER owns the answer — easyfix_properties `bank.change.crm.otp.required`,
 * seeded 'false' — and it is surfaced to the CRM through
 * GET /admin/config/ui-flags as `bankChangeOtpRequired`, read via useUiFlags()
 * below. So flipping the property in the DB changes this dialog with no
 * deploy, which is the whole point of it being a property.
 *
 * The constant below is only the value used BEFORE that flag has loaded (and
 * if the config fetch fails outright). It matches the server's own `?? 'false'`
 * default deliberately: a UI that disagreed with the server on a missing
 * property would be worse than either posture.
 *
 * The flag is a RENDER HINT, never the gate. The server enforces regardless,
 * so a stale or unloaded hint costs at most one 400 — and the catch in
 * verifyAndUpdate() turns `otpRequired` on for the rest of this dialog's life,
 * so the operator sees the OTP step appear rather than a dead end.
 */
const OTP_REQUIRED_DEFAULT = false;

/*
 * IFSC: 4 alpha bank code + a literal '0' + 6 alphanumeric branch code.
 * Input is upper-cased as it is typed, so the check is upper-only.
 */
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const IFSC_ERROR = 'IFSC must be 11 characters — 4 letters, then 0, then 6 letters/digits.';

/* Indian bank account numbers are numeric and run roughly 6–18 digits. */
const ACCOUNT_MIN = 6;
const ACCOUNT_MAX = 18;

/* Matches DeleteEntityDialog's reason textarea — there is no shared
 * Textarea primitive in this repo and Input is single-line. */
const TEXTAREA_CLASS =
  'flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm '
  + 'transition-colors placeholder:text-muted-foreground focus:outline-none '
  + 'focus-visible:outline-none focus-visible:border-foreground/40';

/* The four actionable failure modes, kept apart on purpose (see header). */
type BankErrorKind = 'otp' | 'verification' | 'unavailable' | 'timeout';

/*
 * The 200 body. Only the fields this dialog renders are typed — the rest
 * (ifsc, bank_id, verified, changed) round-trips unread.
 */
type BankChangeResult = {
  account_number_masked: string;
  account_holder_name: string;
  name_match: 'match' | 'mismatch';
  name_score: number;
  otp_verified: boolean;
};

export function EasyfixerBankDialog({
  open,
  easyfixer,
  onClose,
  onUpdated,
}: {
  open: boolean;
  easyfixer: EasyfixerBankTarget | null;
  onClose: () => void;
  /* Fired after a 200 so the page can refresh the list. */
  onUpdated: (efrId: number) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [bankName, setBankName] = useState('');
  const [accountHolderName, setAccountHolderName] = useState('');
  const [reason, setReason] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [bankError, setBankError] = useState<{ kind: BankErrorKind; message: string } | null>(null);
  const [otpRequired, setOtpRequired] = useState(OTP_REQUIRED_DEFAULT);
  // Set ONLY on a name mismatch — a committed change the operator must see.
  const [mismatch, setMismatch] = useState<BankChangeResult | null>(null);
  // Server-owned policy; see OTP_REQUIRED_DEFAULT above. One cached fetch per
  // session — useUiFlags is useFetchOnce-backed, so mounting this dialog
  // repeatedly does not re-request it.
  const { bankChangeOtpRequired } = useUiFlags();
  /*
   * Held in a ref, NOT read directly by the reset effect below.
   *
   * The reset effect keys on [open, efr_id] and clears every field. If the
   * flag were one of its dependencies, the config fetch resolving while the
   * dialog is open would re-run it and wipe whatever the operator had already
   * typed. The ref lets the reset read the current value without being
   * triggered by it.
   */
  const otpFlagRef = useRef(OTP_REQUIRED_DEFAULT);
  useEffect(() => { otpFlagRef.current = bankChangeOtpRequired; }, [bankChangeOtpRequired]);

  // Full reset on each open so a previous attempt never bleeds through.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setAccountNumber('');
    setIfsc('');
    setBankName('');
    setAccountHolderName('');
    setReason('');
    setOtp('');
    setBusy(false);
    setBankError(null);
    // Server-owned policy as of this open; see otpFlagRef above.
    setOtpRequired(otpFlagRef.current);
    setMismatch(null);
  }, [open, easyfixer?.efr_id]);

  // Timestamp of the last open — drives the phantom-close swallow below.
  const openedAtRef = useRef(0);
  useEffect(() => { if (open) openedAtRef.current = Date.now(); }, [open]);

  const handleClose = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  const guardedOpenChange = useFormDirtyGuard(handleClose, {
    isDirty: () => step === 2
      || accountNumber.length > 0 || ifsc.length > 0
      || bankName.trim().length > 0 || accountHolderName.trim().length > 0
      || reason.trim().length > 0,
    // `mismatch` means the save already landed — the fields are still filled
    // but there is nothing left to discard, so skip the prompt.
    when: () => !busy && !mismatch,
  });

  /*
   * Same Radix DropdownMenu → Dialog race documented on the profile-update
   * dialog: the pointer-up that closes the kebab menu reads as a
   * click-outside on the just-mounted Dialog. Swallow any close fired within
   * 400ms of opening; real dismissals always arrive later.
   */
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next && Date.now() - openedAtRef.current < 400) return;
    guardedOpenChange(next);
  }, [guardedOpenChange]);

  const accountValid = accountNumber.length >= ACCOUNT_MIN && accountNumber.length <= ACCOUNT_MAX;
  const ifscValid = IFSC_REGEX.test(ifsc);
  const detailsValid = accountValid
    && ifscValid
    && bankName.trim().length > 0
    && accountHolderName.trim().length > 0
    && reason.trim().length > 0;

  /* Accept 4–6 digits so the dialog works whichever length the BE mints. */
  const otpValid = otp.length >= 4;

  async function sendOtp() {
    if (!easyfixer) return;
    setBusy(true);
    try {
      await api.post<{ sent: boolean }>(`/admin/easyfixers/${easyfixer.efr_id}/bank/otp`, {});
      setOtp('');
      setBankError(null);
      setStep(2);
      showToast({ variant: 'success', message: 'OTP sent to the technician on WhatsApp.' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        showToast({ variant: 'error', message: "You don't have permission to change a technician's bank details." });
      } else {
        showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed to send OTP' });
      }
    } finally {
      setBusy(false);
    }
  }

  async function verifyAndUpdate() {
    if (!easyfixer || !detailsValid) return;
    if (otpRequired && !otpValid) return;
    setBusy(true);
    setBankError(null);
    try {
      const result = await api.patch<BankChangeResult>(`/admin/easyfixers/${easyfixer.efr_id}/bank`, {
        // `otp` is optional server-side. Omit the key entirely on the default
        // (no-OTP) path rather than sending an empty string.
        ...(otp ? { otp } : {}),
        accountNumber,
        ifsc,
        bankName: bankName.trim(),
        accountHolderName: accountHolderName.trim(),
        reason: reason.trim(),
      });
      // The change is committed at this point, whatever name_match says — bust
      // any cached easyfixer read before the branch below.
      invalidateFetch((k) => k.startsWith('/admin/easyfixers'));
      onUpdated(easyfixer.efr_id);

      if (result?.name_match === 'mismatch') {
        // ADVISORY, not a failure. Hold the dialog open on the warning panel
        // so this cannot be missed the way an auto-dismissing toast can.
        setMismatch(result);
      } else {
        // Never echo the full account number back — last 4 only.
        showToast({
          variant: 'success',
          message: `Bank details updated for ${formatEasyfixerName(easyfixer.efr_name)} — account ending ${accountNumber.slice(-4)}.`,
        });
        onClose();
      }
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const message = e instanceof Error ? e.message : '';
      if (status === 400) {
        // Wrong, expired — or missing — code. Everything they typed survives;
        // only the OTP is cleared so the field is ready for the next attempt.
        setOtp('');
        setBankError({ kind: 'otp', message: message || 'That OTP is invalid or has expired.' });
        // A 400 on the OTP is only reachable when `bank.change.crm.otp.required`
        // is ON server-side. If we submitted without one (flag believed off,
        // ops flipped it on), switch the OTP step back on — the operator stays
        // on the details they already typed and the primary button becomes
        // "Send OTP To Technician".
        if (!otpRequired) setOtpRequired(true);
      } else if (status === 422) {
        // The vendor rejected the account (bad details, or no such account).
        // Resending an OTP cannot fix this.
        setBankError({ kind: 'verification', message: message || 'Bank verification failed for these details.' });
      } else if (status === 503) {
        setBankError({ kind: 'unavailable', message: message || 'The bank verification service is unavailable right now.' });
      } else if (status === 504) {
        setBankError({ kind: 'timeout', message: message || 'The bank verification service did not respond in time.' });
      } else if (status === 403) {
        showToast({ variant: 'error', message: "You don't have permission to change a technician's bank details." });
      } else {
        showToast({ variant: 'error', message: message || 'Failed to update bank details' });
      }
    } finally {
      setBusy(false);
    }
  }

  function backToDetails() {
    setStep(1);
    setOtp('');
    setBankError(null);
  }

  // Fragment (not null) keeps the render shape stable while closed — same
  // reasoning as SendProfileUpdateLinkDialog on the Easyfixers page.
  if (!easyfixer) return <></>;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="h-4 w-4" />
            {mismatch
              ? 'Bank Details Updated — Name Needs Review'
              : step === 1 ? 'Update Bank Details' : 'Verify & Update Bank Details'}
          </DialogTitle>
          <DialogDescription>
            {formatEasyfixerName(easyfixer.efr_name)} · Easyfixer #{easyfixer.efr_id}
          </DialogDescription>
        </DialogHeader>

        {mismatch ? (
          /*
           * Post-save advisory. Warning tokens, NOT the urgent/destructive
           * ones — the change is saved and this must not read as a failure.
           */
          <div className="space-y-3 p-4 pt-2">
            <div className="rounded border border-warning bg-warning-tint p-3 text-sm text-warning-strong space-y-2">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Account Holder Name Does Not Match
              </div>
              <p className="text-xs">
                The bank holds this account under a name that does not match
                {' '}{formatEasyfixerName(easyfixer.efr_name)}. This is a warning, not a failure.
              </p>
              <p className="text-xs font-medium">
                The change WAS saved (account ending {accountNumber.slice(-4)}) and needs review
                before the next payout run.
              </p>
            </div>

            <div className="rounded border bg-muted/40 p-3 text-xs space-y-1">
              <RecapRow label="Name At The Bank" value={mismatch.account_holder_name} />
              <RecapRow label="Name On File" value={formatEasyfixerName(easyfixer.efr_name)} />
              <RecapRow label="Account Number" value={mismatch.account_number_masked} mono />
              <RecapRow label="Name Match Score" value={`${Math.round((mismatch.name_score ?? 0) * 100)}%`} />
            </div>

            <div className="flex justify-end pt-1">
              <Button onClick={onClose}>Close</Button>
            </div>
          </div>
        ) : step === 1 ? (
          <div className="space-y-3 p-4 pt-2">
            <div className="space-y-1">
              <Label htmlFor="ef-bank-account" required>Bank Account Number</Label>
              <Input
                id="ef-bank-account"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, ACCOUNT_MAX))}
                placeholder="Account Number"
                className="font-mono"
                inputMode="numeric"
                autoComplete="off"
              />
              {accountNumber.length > 0 && !accountValid && (
                <p className="text-xs text-destructive">
                  Account number must be {ACCOUNT_MIN}–{ACCOUNT_MAX} digits.
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="ef-bank-ifsc" required>IFSC Code</Label>
                <Input
                  id="ef-bank-ifsc"
                  value={ifsc}
                  onChange={(e) => setIfsc(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11))}
                  placeholder="e.g. HDFC0001234"
                  className="font-mono uppercase"
                  autoComplete="off"
                />
                {ifsc.length > 0 && !ifscValid && (
                  <p className="text-xs text-destructive">{IFSC_ERROR}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="ef-bank-name" required>Bank Name</Label>
                <Input
                  id="ef-bank-name"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder="Bank Name"
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ef-bank-holder" required>Account Holder Name</Label>
              <Input
                id="ef-bank-holder"
                value={accountHolderName}
                onChange={(e) => setAccountHolderName(e.target.value)}
                placeholder="Name As Printed On The Passbook"
                autoComplete="off"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ef-bank-reason" required>Reason</Label>
              <textarea
                id="ef-bank-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Why are these bank details being changed?"
                className={TEXTAREA_CLASS}
              />
            </div>

            {otpRequired ? (
              <div className="rounded border bg-muted/40 p-3 text-xs text-muted-foreground">
                The next step sends a one-time code to the technician&apos;s registered WhatsApp
                number. They receive it, not you — ask them to read it back before you continue.
              </div>
            ) : (
              <div className="rounded border bg-muted/40 p-3 text-xs text-muted-foreground">
                The account is checked against the bank before it is saved, and the account
                holder&apos;s name is compared with the technician&apos;s. No code is needed from
                the technician.
              </div>
            )}

            {/* Failures land here too on the one-step flow. */}
            <BankErrorPanel error={bankError} step={step} />

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={handleClose} disabled={busy}>Cancel</Button>
              <Button onClick={otpRequired ? sendOtp : verifyAndUpdate} disabled={!detailsValid || busy}>
                {busy
                  ? (otpRequired ? 'Sending…' : 'Verifying…')
                  : otpRequired
                    ? 'Send OTP To Technician'
                    : bankError?.kind === 'unavailable' || bankError?.kind === 'timeout'
                      ? 'Retry Verification'
                      : 'Verify & Update'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 p-4 pt-2">
            {/*
              * Where the code went. Operators have tried to read this OTP off
              * their own phone; say plainly that it is not theirs.
              */}
            <div className="rounded border border-info bg-info-tint p-3 text-xs text-info-deep">
              A one-time code was sent to {formatEasyfixerName(easyfixer.efr_name)} on their
              registered WhatsApp number. The code is on the technician&apos;s phone, not yours —
              ask them to read it out.
            </div>

            {/* Read-only recap: exactly what is about to be committed. */}
            <div className="rounded border bg-muted/40 p-3 text-xs space-y-1">
              <RecapRow label="Bank Account Number" value={accountNumber} mono />
              <RecapRow label="IFSC Code" value={ifsc} mono />
              <RecapRow label="Bank Name" value={bankName.trim()} />
              <RecapRow label="Account Holder Name" value={accountHolderName.trim()} />
              <RecapRow label="Reason" value={reason.trim()} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ef-bank-otp" required>Enter OTP</Label>
              <Input
                id="ef-bank-otp"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="OTP From The Technician"
                className="tracking-[0.4em] text-center font-mono"
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </div>

            <BankErrorPanel error={bankError} step={step} />

            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex gap-2">
                <Button variant="outline" onClick={backToDetails} disabled={busy}>
                  Edit Details
                </Button>
                <Button variant="outline" onClick={sendOtp} disabled={busy}>
                  Resend OTP
                </Button>
              </div>
              {bankError?.kind === 'verification' ? (
                /*
                 * A vendor rejection is not retryable with the same input, so
                 * the primary action becomes the one that CAN fix it.
                 */
                <Button onClick={backToDetails} disabled={busy}>
                  Correct Bank Details
                </Button>
              ) : (
                <Button onClick={verifyAndUpdate} disabled={busy || !otpValid}>
                  {busy
                    ? 'Verifying…'
                    : bankError?.kind === 'unavailable' || bankError?.kind === 'timeout'
                      ? 'Retry Verification'
                      : 'Verify & Update'}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/*
 * The four failure states, kept apart on purpose (see the file header). Shared
 * by both steps because the one-step flow can hit 422/503/504 without ever
 * reaching the OTP screen — and a 400 can push the OTP step back on from here.
 */
function BankErrorPanel({
  error,
  step,
}: {
  error: { kind: BankErrorKind; message: string } | null;
  step: 1 | 2;
}) {
  if (!error) return null;

  if (error.kind === 'otp') {
    return (
      <div className="rounded border border-warning bg-warning-tint p-3 text-sm text-warning-strong space-y-1">
        <div className="flex items-center gap-2 font-medium">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          OTP Required
        </div>
        <p className="text-xs">{error.message}</p>
        <p className="text-xs">
          {step === 2
            ? 'Nothing was changed. Re-enter the code, or send a fresh one — the bank details above are kept.'
            : 'Nothing was changed. This change now needs a one-time code from the technician — send it to continue. The details you entered are kept.'}
        </p>
      </div>
    );
  }

  if (error.kind === 'verification') {
    return (
      <div className="rounded border border-urgent bg-urgent-tint p-3 text-sm text-urgent-strong space-y-1">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Bank Verification Failed
        </div>
        <p className="text-xs">{error.message}</p>
        <p className="text-xs">
          The account was NOT changed. Retrying with the same details will not help — correct the
          account number and IFSC, then try again.
        </p>
      </div>
    );
  }

  if (error.kind === 'unavailable') {
    return (
      <div className="rounded border border-ink-300 bg-ink-50 p-3 text-sm text-ink-700 space-y-1">
        <div className="flex items-center gap-2 font-medium">
          <WifiOff className="h-4 w-4 shrink-0" />
          Verification Service Unavailable
        </div>
        <p className="text-xs">{error.message}</p>
        <p className="text-xs">
          Nothing was changed and the details you entered are intact. This is a configuration
          problem on our side, not a problem with the account — raise it if it persists.
        </p>
      </div>
    );
  }

  /* timeout (504) — split from 503 because a retry IS the right next move. */
  return (
    <div className="rounded border border-ink-300 bg-ink-50 p-3 text-sm text-ink-700 space-y-1">
      <div className="flex items-center gap-2 font-medium">
        <Timer className="h-4 w-4 shrink-0" />
        Verification Timed Out
      </div>
      <p className="text-xs">{error.message}</p>
      <p className="text-xs">
        Nothing was changed and the details you entered are intact. The bank did not answer in
        time — retry in a minute.
      </p>
    </div>
  );
}

/* One line of the read-only recap. */
function RecapRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-foreground font-medium text-right break-all${mono ? ' font-mono' : ''}`}>
        {value || '—'}
      </span>
    </div>
  );
}
