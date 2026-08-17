'use client';

/*
 * EasyfixerBankDialog — operator-driven change of a technician's bank
 * account, from the Manage Easyfixers row action menu. Two steps inside one
 * dialog so the operator never loses what they typed.
 *
 * Backend contract:
 *   POST  /admin/easyfixers/:id/bank/otp   200 → { sent: true }
 *         (the OTP goes to the TECHNICIAN's registered WhatsApp — not to
 *          the operator; the copy in step 2 says so explicitly)
 *   PATCH /admin/easyfixers/:id/bank
 *         body { otp, accountNumber, ifsc, bankName, accountHolderName, reason }
 *         200 → updated
 *         400 → OTP invalid / expired          (nothing was changed)
 *         422 → bank verification failed        (nothing was changed; the
 *                                                message carries the vendor's
 *                                                reason)
 *         503 → verification service unavailable
 *
 * The three failure codes are rendered as THREE DISTINCT states because the
 * operator's next move differs in each:
 *   400 → the code is wrong/stale. Re-enter or resend the OTP; details stay.
 *   422 → the account details are wrong. Go back and fix them; a resend
 *         won't help, so the primary button becomes "Edit Details".
 *   503 → nothing is wrong with the input. Retry in a moment; the primary
 *         button becomes "Retry Verification".
 * Collapsing them into one "something went wrong" would send the operator
 * down the wrong path two times out of three.
 *
 * After a successful save the account number is never echoed back in full —
 * the confirmation toast shows the last 4 digits only.
 *
 * Conventions honoured: shared Dialog / Input / Label / Button primitives,
 * showToast (never native alert/confirm), Title Case labels, and the close
 * paths routed through useFormDirtyGuard (an inline onOpenChange arrow is a
 * hard eslint error in this repo).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Landmark, ShieldAlert, WifiOff } from 'lucide-react';
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
import { api, ApiError } from '@/lib/api';
import { formatEasyfixerName } from '@/lib/utils';

export type EasyfixerBankTarget = {
  efr_id: number;
  efr_name: string;
};

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
  'flex w-full rounded-md border border-input bg-white px-3 py-2 text-sm shadow-sm '
  + 'transition-colors placeholder:text-muted-foreground focus:outline-none '
  + 'focus-visible:outline-none focus-visible:border-foreground/40';

/* The three actionable failure modes, kept apart on purpose (see header). */
type BankErrorKind = 'otp' | 'verification' | 'unavailable';

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
    when: () => !busy,
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
    if (!easyfixer || !detailsValid || !otpValid) return;
    setBusy(true);
    setBankError(null);
    try {
      await api.patch(`/admin/easyfixers/${easyfixer.efr_id}/bank`, {
        otp,
        accountNumber,
        ifsc,
        bankName: bankName.trim(),
        accountHolderName: accountHolderName.trim(),
        reason: reason.trim(),
      });
      // Never echo the full account number back — last 4 only.
      showToast({
        variant: 'success',
        message: `Bank details updated for ${formatEasyfixerName(easyfixer.efr_name)} — account ending ${accountNumber.slice(-4)}.`,
      });
      onUpdated(easyfixer.efr_id);
      onClose();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const message = e instanceof Error ? e.message : '';
      if (status === 400) {
        // Wrong or expired code. Everything they typed survives; only the OTP
        // is cleared so the field is ready for the next attempt.
        setOtp('');
        setBankError({ kind: 'otp', message: message || 'That OTP is invalid or has expired.' });
      } else if (status === 422) {
        // The vendor rejected the account. Resending an OTP cannot fix this.
        setBankError({ kind: 'verification', message: message || 'Bank verification failed for these details.' });
      } else if (status === 503) {
        setBankError({ kind: 'unavailable', message: message || 'The bank verification service is unavailable right now.' });
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
            {step === 1 ? 'Update Bank Details' : 'Verify & Update Bank Details'}
          </DialogTitle>
          <DialogDescription>
            {formatEasyfixerName(easyfixer.efr_name)} · Easyfixer #{easyfixer.efr_id}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
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

            <div className="rounded border bg-muted/40 p-3 text-xs text-muted-foreground">
              The next step sends a one-time code to the technician&apos;s registered WhatsApp
              number. They receive it, not you — ask them to read it back before you continue.
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={handleClose} disabled={busy}>Cancel</Button>
              <Button onClick={sendOtp} disabled={!detailsValid || busy}>
                {busy ? 'Sending…' : 'Send OTP To Technician'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 p-4 pt-2">
            {/*
              * Where the code went. Operators have tried to read this OTP off
              * their own phone; say plainly that it is not theirs.
              */}
            <div className="rounded border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
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

            {/* ─── The three distinct failure states ─────────────────────── */}
            {bankError?.kind === 'otp' && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-1">
                <div className="flex items-center gap-2 font-medium">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  OTP Invalid Or Expired
                </div>
                <p className="text-xs">{bankError.message}</p>
                <p className="text-xs">
                  Nothing was changed. Re-enter the code, or send a fresh one — the bank details
                  above are kept.
                </p>
              </div>
            )}
            {bankError?.kind === 'verification' && (
              <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 space-y-1">
                <div className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  Bank Verification Failed
                </div>
                <p className="text-xs">{bankError.message}</p>
                <p className="text-xs">
                  The account was NOT changed. A new OTP will not help — correct the account
                  details and try again.
                </p>
              </div>
            )}
            {bankError?.kind === 'unavailable' && (
              <div className="rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700 space-y-1">
                <div className="flex items-center gap-2 font-medium">
                  <WifiOff className="h-4 w-4 shrink-0" />
                  Verification Service Unavailable
                </div>
                <p className="text-xs">{bankError.message}</p>
                <p className="text-xs">
                  Nothing was changed and the details you entered are intact. Retry in a minute.
                </p>
              </div>
            )}

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
                    : bankError?.kind === 'unavailable' ? 'Retry Verification' : 'Verify & Update'}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* One line of the step-2 read-only recap. */
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
