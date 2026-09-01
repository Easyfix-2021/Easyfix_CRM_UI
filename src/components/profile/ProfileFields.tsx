'use client';
/*
 * My Profile — the editable half.
 *
 * Types, validators and the three presentational pieces the profile page
 * composes. Kept beside the page rather than in components/ui/ because none of
 * it is reusable: every rule here is about ONE user's own record.
 *
 * ─── THE APPROVAL MODEL THIS UI HAS TO MAKE VISIBLE ─────────────────────────
 * A user has AT MOST ONE open request, covering however many fields (contract,
 * "ONE OPEN REQUEST PER USER"). Submitting MERGES: keys sent overwrite, keys
 * omitted survive. So three facts must be legible without the user reasoning
 * about them:
 *
 *   1. WHICH fields are awaiting approval — shown on each field, because a
 *      user who cannot see their own pending change submits it again.
 *   2. That re-submitting a pending field REVISES it rather than erroring —
 *      so the control says "Revise Request", not "Request Change".
 *   3. That withdrawing is ALL-OR-NOTHING. This is the dangerous one: the
 *      button sits next to one field but cancels every field in the request.
 *      Hence PendingBanner, which states the whole scope in one place, and a
 *      withdraw confirm that enumerates everything being discarded.
 */
import * as React from 'react';
import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusChip } from '@/components/ui/StatusChip';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

/* ═══════════════════════════════════════════════════════════════════════════
 * Types — GET /api/profile/details, verbatim from the contract.
 * ═══════════════════════════════════════════════════════════════════════════ */

export type BankDetails = {
  account_number: string | null;
  ifsc: string | null;
  account_name: string | null;
  bank_name: string | null;
};

/* Only the keys actually awaiting approval are present. */
export type PendingChanges = {
  mobile_no?: string;
  date_of_birth?: string;
  bank?: BankDetails;
};

export type PendingRequest = {
  request_id: number;
  changes: PendingChanges;
  requested_on: string;
  updated_on: string | null;
};

export type ProfileDetails = {
  user_code: string | null;
  mobile_no: string | null;
  alternate_no: string | null;
  personal_email: string | null;
  date_of_birth: string | null;
  dob_locked: boolean;
  bank: BankDetails | null;
  pending: PendingRequest | null;
};

export type RequestableField = 'mobile_no' | 'date_of_birth' | 'bank';

export const FIELD_LABEL: Record<RequestableField, string> = {
  mobile_no: 'Mobile Number',
  date_of_birth: 'Date Of Birth',
  bank: 'Bank Details',
};

/* ═══════════════════════════════════════════════════════════════════════════
 * Validation — the contract's rules, checked before anything is submitted.
 *
 * NOTE: the app's own INDIAN_MOBILE_REGEX (lib/format.ts) is /^[6-9]\d{9}$/,
 * STRICTER than the contract's /^[0-9]{10}$/. The contract is the frozen
 * source and the server enforces its own rule, so a client-side check tighter
 * than the server's would reject values the server accepts. Contract wins.
 * ═══════════════════════════════════════════════════════════════════════════ */

export const PHONE_RE = /^[0-9]{10}$/;
export const PHONE_ERROR = 'Enter a 10-digit number.';

export const IFSC_RE = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;
export const IFSC_ERROR = 'IFSC must be 11 characters — 4 letters, then 0, then 6 letters or digits.';

/*
 * Calendar bounds built from LOCAL getters and compared as strings.
 *
 * YYYY-MM-DD sorts chronologically under plain string comparison, so the whole
 * age check needs no Date arithmetic — and more importantly no Date PARSING.
 * `new Date('1994-03-08')` is read as UTC midnight, which is a different
 * calendar day in half the world's zones; a date the user typed into a date
 * input is a wall-clock calendar date and must never round-trip through one.
 */
function shiftYears(years: number): string {
  const now = new Date();
  const y = now.getFullYear() - years;
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const dobToday = () => shiftYears(0);
/** Youngest permitted DOB (age 15). Also the date input's `max`. */
export const dobMax = () => shiftYears(15);
/** Oldest permitted DOB (age 100). Also the date input's `min`. */
export const dobMin = () => shiftYears(100);

export function dobError(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter a date as YYYY-MM-DD.';
  if (value > dobToday()) return 'Date of birth cannot be in the future.';
  if (value > dobMax()) return 'You must be at least 15 years old.';
  if (value < dobMin()) return 'Date of birth cannot be more than 100 years ago.';
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Rendering helpers
 * ═══════════════════════════════════════════════════════════════════════════ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* String in, string out — see the parsing note above. Accepts a DATETIME too
 * and keeps only its date half. */
export function fmtDate(value?: string | null): string {
  if (!value) return '';
  const m = String(value).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(value);
  return `${m[3]} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export function bankLine(bank?: BankDetails | null): string {
  if (!bank) return '';
  const parts = [bank.account_name, bank.account_number, bank.ifsc, bank.bank_name]
    .map((p) => (p ?? '').trim())
    .filter(Boolean);
  return parts.join(' · ');
}

/** One line per pending field: the label plus the value awaiting approval. */
export function pendingItems(changes?: PendingChanges | null):
  Array<{ key: RequestableField; label: string; text: string }> {
  if (!changes) return [];
  const out: Array<{ key: RequestableField; label: string; text: string }> = [];
  if (changes.mobile_no !== undefined) {
    out.push({ key: 'mobile_no', label: FIELD_LABEL.mobile_no, text: String(changes.mobile_no) });
  }
  if (changes.date_of_birth !== undefined) {
    out.push({ key: 'date_of_birth', label: FIELD_LABEL.date_of_birth, text: fmtDate(changes.date_of_birth) });
  }
  if (changes.bank !== undefined) {
    out.push({ key: 'bank', label: FIELD_LABEL.bank, text: bankLine(changes.bank) || '—' });
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ProfileRow — one label / value / action line.
 *
 * A definition list rather than a card per field: the page is a record to be
 * READ, and a reader scanning a column of labels finds a value far faster than
 * one hopping between boxes of equal visual weight.
 * ═══════════════════════════════════════════════════════════════════════════ */

export function ProfileRow({
  label, value, mono, hint, action, children, hideValue,
}: {
  label: string;
  value?: React.ReactNode;
  mono?: boolean;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  /* Suppress the value line entirely — for rows whose inline editor already
   * holds the current value, where an em dash above it reads as a second,
   * empty field rather than as "nothing on record". */
  hideValue?: boolean;
}) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className="py-3 first:pt-0 last:pb-0 border-b border-border/60 last:border-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
        <div className="w-full sm:w-44 shrink-0 text-xs font-medium text-muted-foreground pt-0.5">
          {label}
        </div>
        <div className="min-w-0 flex-1">
          {/* An em dash for anything absent — never a blank cell, which reads
              as a field that failed to load. */}
          {!hideValue && (
            <div className={[
              'text-sm break-words',
              mono ? 'font-mono' : '',
              empty ? 'text-muted-foreground' : '',
            ].join(' ')}>
              {empty ? '—' : value}
            </div>
          )}
          {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
          {children}
        </div>
        {action && <div className="shrink-0 ml-auto sm:ml-0">{action}</div>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PendingFieldNote — the pending state ON the field it targets.
 *
 * Neutral surface + a StatusChip for the colour. Painting body text onto a
 * *-tint background is how a strip ends up unreadable in one theme; the chip
 * already carries a bg/text pairing guaranteed legible in both.
 * ═══════════════════════════════════════════════════════════════════════════ */

export function PendingFieldNote({ text, alsoCovers }: { text: string; alsoCovers: string[] }) {
  return (
    <div className="mt-2 rounded-md border border-warning/40 bg-muted/50 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone="warning" size="sm">Awaiting Approval</StatusChip>
        <span className="text-xs text-muted-foreground">Requested value</span>
        <span className="text-xs font-medium break-all">{text}</span>
      </div>
      {alsoCovers.length > 0 && (
        <p className="text-xs text-muted-foreground mt-1.5">
          Part of one request that also covers {alsoCovers.join(' and ')}. Withdrawing cancels all of it.
        </p>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PendingBanner — the scope of the open request, stated once, up top.
 *
 * Withdraw lives HERE and not on the individual field notes, because the
 * action is all-or-nothing: a button beside one field that silently discards
 * two others is precisely the failure this layout exists to avoid.
 * ═══════════════════════════════════════════════════════════════════════════ */

export function PendingBanner({
  pending, onWithdraw, withdrawing,
}: {
  pending: PendingRequest;
  onWithdraw: () => void;
  withdrawing: boolean;
}) {
  const items = pendingItems(pending.changes);
  const n = items.length;
  return (
    <div className="rounded-lg border border-warning/40 border-l-4 border-l-warning bg-card shadow-sm p-4">
      <div className="flex flex-wrap items-start gap-3">
        <Clock className="size-4 text-warning-strong mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">
            {n} {n === 1 ? 'Change' : 'Changes'} Awaiting HR Approval
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Nothing below has changed yet. HR reviews all of it together and approves or
            rejects it as one request — raised {fmtDate(pending.requested_on)}
            {pending.updated_on ? `, last revised ${fmtDate(pending.updated_on)}` : ''}.
          </p>
          <ul className="mt-2 space-y-1">
            {items.map((it) => (
              <li key={it.key} className="text-xs flex flex-wrap gap-x-2">
                <span className="text-muted-foreground w-32 shrink-0">{it.label}</span>
                <span className="font-medium break-all">{it.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onWithdraw}
          disabled={withdrawing}
          className="shrink-0 ml-auto"
        >
          {withdrawing ? 'Withdrawing…' : 'Withdraw Request'}
        </Button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * RequestChangeDialog — the approval path for Mobile Number, Date Of Birth
 * (once locked) and Bank Details.
 *
 * One component, three field shapes. A dialog rather than an inline editor
 * because these submissions do NOT change the record: the modal step is what
 * separates "I edited this" from "I asked for this to be edited".
 * ═══════════════════════════════════════════════════════════════════════════ */

const EMPTY_BANK: BankDetails = { account_number: '', ifsc: '', account_name: '', bank_name: '' };

export function RequestChangeDialog({
  field, details, onClose, onSubmitted,
}: {
  field: RequestableField;
  details: ProfileDetails;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const pendingChanges = details.pending?.changes;
  const pendingForField = pendingChanges?.[field];
  const isRevision = pendingForField !== undefined;

  /* Other fields already in the open request — named so the user learns the
   * merge behaviour from the dialog instead of from a surprise later. */
  const otherPending = pendingItems(pendingChanges)
    .filter((it) => it.key !== field)
    .map((it) => it.label);

  /* Seed from what is already awaiting approval when there is one — the user
   * is revising that value, not the record's. */
  const [phone, setPhone] = React.useState(
    field === 'mobile_no' ? String(pendingChanges?.mobile_no ?? details.mobile_no ?? '') : '',
  );
  const [dob, setDob] = React.useState(
    field === 'date_of_birth'
      ? String(pendingChanges?.date_of_birth ?? details.date_of_birth ?? '').slice(0, 10)
      : '',
  );
  const [bank, setBank] = React.useState<BankDetails>(() => {
    const src = pendingChanges?.bank ?? details.bank ?? EMPTY_BANK;
    return {
      account_name: src.account_name ?? '',
      account_number: src.account_number ?? '',
      ifsc: src.ifsc ?? '',
      bank_name: src.bank_name ?? '',
    };
  });
  const [submitting, setSubmitting] = React.useState(false);

  const setBankField = (k: keyof BankDetails, v: string) =>
    setBank((b) => ({ ...b, [k]: v }));

  /* ── Per-field validation, evaluated on every keystroke ──────────────── */
  const phoneError = phone.length > 0 && !PHONE_RE.test(phone) ? PHONE_ERROR : null;
  const dobFieldError = dob.length > 0 ? dobError(dob) : null;
  const ifscError = (bank.ifsc ?? '').length > 0 && !IFSC_RE.test(bank.ifsc ?? '') ? IFSC_ERROR : null;

  let valid = false;
  if (field === 'mobile_no') valid = PHONE_RE.test(phone);
  else if (field === 'date_of_birth') valid = dob.length > 0 && dobError(dob) === null;
  else {
    valid = (bank.account_name ?? '').trim().length > 0
      && (bank.account_number ?? '').trim().length > 0
      && IFSC_RE.test(bank.ifsc ?? '')
      && (bank.bank_name ?? '').trim().length > 0;
  }

  /* The value this submission would put in the request. */
  const composed = field === 'mobile_no'
    ? phone
    : field === 'date_of_birth'
      ? dob
      : JSON.stringify({
          account_name: (bank.account_name ?? '').trim(),
          account_number: (bank.account_number ?? '').trim(),
          ifsc: (bank.ifsc ?? '').trim().toUpperCase(),
          bank_name: (bank.bank_name ?? '').trim(),
        });

  /* Refuse a no-op: identical to what is already pending, or (with nothing
   * pending) identical to the record. Either way the request would ask HR to
   * approve a change that changes nothing. */
  const comparisonTarget = isRevision
    ? (field === 'bank'
        ? JSON.stringify({
            account_name: (pendingChanges?.bank?.account_name ?? '').trim(),
            account_number: (pendingChanges?.bank?.account_number ?? '').trim(),
            ifsc: (pendingChanges?.bank?.ifsc ?? '').trim().toUpperCase(),
            bank_name: (pendingChanges?.bank?.bank_name ?? '').trim(),
          })
        : String(pendingForField ?? ''))
    : (field === 'mobile_no'
        ? String(details.mobile_no ?? '')
        : field === 'date_of_birth'
          ? String(details.date_of_birth ?? '').slice(0, 10)
          : JSON.stringify({
              account_name: (details.bank?.account_name ?? '').trim(),
              account_number: (details.bank?.account_number ?? '').trim(),
              ifsc: (details.bank?.ifsc ?? '').trim().toUpperCase(),
              bank_name: (details.bank?.bank_name ?? '').trim(),
            }));
  const unchanged = composed === comparisonTarget;

  async function submit() {
    if (!valid || unchanged || submitting) return;
    setSubmitting(true);
    try {
      const changes: PendingChanges =
        field === 'mobile_no' ? { mobile_no: phone }
        : field === 'date_of_birth' ? { date_of_birth: dob }
        : {
            bank: {
              account_name: (bank.account_name ?? '').trim(),
              account_number: (bank.account_number ?? '').trim(),
              ifsc: (bank.ifsc ?? '').trim().toUpperCase(),
              bank_name: (bank.bank_name ?? '').trim(),
            },
          };
      await api.post('/profile/update-requests', { changes });
      invalidateFetch((k) => k.startsWith('/profile'));
      showToast({
        variant: 'success',
        message: isRevision
          ? `${FIELD_LABEL[field]} updated on your pending request. HR still has to approve it.`
          : `${FIELD_LABEL[field]} change sent to HR. Nothing changes until it is approved.`,
      });
      onSubmitted();
    } catch (e) {
      showToast({
        variant: 'error',
        message: e instanceof ApiError ? e.message : 'Could not submit the request — please retry.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  /* Esc / X / overlay-click route through here. Prompts only when the user
   * actually typed something (`unchanged` means the composed value still
   * equals what is on record or already pending), and never closes out from
   * under an in-flight submit. */
  const guardedOpenChange = useFormDirtyGuard(
    () => { if (!submitting) onClose(); },
    { isDirty: () => !unchanged },
  );

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isRevision ? 'Revise' : 'Request'} {FIELD_LABEL[field]} Change
          </DialogTitle>
          <DialogDescription>
            HR has to approve this. Nothing on your record changes until they do.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isRevision && (
            <p className="text-xs rounded-md border border-warning/40 bg-muted/50 px-3 py-2">
              This replaces the {FIELD_LABEL[field].toLowerCase()} already awaiting approval. It
              revises your existing request rather than raising a second one.
            </p>
          )}
          {!isRevision && otherPending.length > 0 && (
            <p className="text-xs rounded-md border border-border bg-muted/50 px-3 py-2">
              This is added to your open request, which also covers {otherPending.join(' and ')}.
              HR approves or rejects all of it together.
            </p>
          )}

          {field === 'mobile_no' && (
            <div className="space-y-1">
              <Label htmlFor="pf-mobile" required>New Mobile Number</Label>
              <Input
                id="pf-mobile"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                inputMode="numeric"
                autoComplete="off"
                placeholder="10-digit number"
                className="font-mono"
              />
              {phoneError && <p className="text-xs text-destructive">{phoneError}</p>}
              <p className="text-xs text-muted-foreground">
                Currently on record: {details.mobile_no || '—'}
              </p>
            </div>
          )}

          {field === 'date_of_birth' && (
            <div className="space-y-1">
              <Label htmlFor="pf-dob" required>New Date Of Birth</Label>
              <Input
                id="pf-dob"
                type="date"
                value={dob}
                min={dobMin()}
                max={dobMax()}
                onChange={(e) => setDob(e.target.value)}
              />
              {dobFieldError && <p className="text-xs text-destructive">{dobFieldError}</p>}
              <p className="text-xs text-muted-foreground">
                Currently on record: {fmtDate(details.date_of_birth) || '—'}
              </p>
            </div>
          )}

          {field === 'bank' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="pf-bank-name-holder" required>Account Holder Name</Label>
                <Input
                  id="pf-bank-name-holder"
                  value={bank.account_name ?? ''}
                  onChange={(e) => setBankField('account_name', e.target.value)}
                  placeholder="Name As It Appears At The Bank"
                  autoComplete="off"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="pf-bank-account" required>Account Number</Label>
                  <Input
                    id="pf-bank-account"
                    value={bank.account_number ?? ''}
                    onChange={(e) => setBankField('account_number', e.target.value.replace(/[^0-9]/g, '').slice(0, 32))}
                    inputMode="numeric"
                    autoComplete="off"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pf-bank-ifsc" required>IFSC Code</Label>
                  <Input
                    id="pf-bank-ifsc"
                    value={bank.ifsc ?? ''}
                    onChange={(e) => setBankField('ifsc', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11))}
                    placeholder="e.g. HDFC0001234"
                    autoComplete="off"
                    className="font-mono uppercase"
                  />
                  {ifscError && <p className="text-xs text-destructive">{ifscError}</p>}
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pf-bank-bank" required>Bank Name</Label>
                <Input
                  id="pf-bank-bank"
                  value={bank.bank_name ?? ''}
                  onChange={(e) => setBankField('bank_name', e.target.value.slice(0, 120))}
                  autoComplete="off"
                />
              </div>
            </div>
          )}

          {unchanged && valid && (
            <p className="text-xs text-muted-foreground">
              This is the same value that is already on {isRevision ? 'your request' : 'record'} —
              change something before submitting.
            </p>
          )}
        </div>

        <DialogFooter>
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button onClick={submit} disabled={!valid || unchanged || submitting}>
            {submitting ? 'Submitting…' : 'Submit Request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
