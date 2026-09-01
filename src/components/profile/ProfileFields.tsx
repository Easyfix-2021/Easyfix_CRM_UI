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
 *   2. That re-submitting a pending field REVISES it rather than erroring.
 *      One modal edits every field at once and posts ONE merge, which is the
 *      backend's model stated directly rather than three posts that each merge
 *      into the same row; a pending field is seeded with its pending value and
 *      marked, so editing it visibly revises the request.
 *   3. That withdrawing is ALL-OR-NOTHING — one button cancels every field in
 *      the request. Hence PendingBanner, which states the whole scope in one
 *      place, and a withdraw confirm that enumerates everything discarded.
 */
import * as React from 'react';
import { Camera, Check, Clock, Eye, EyeOff, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useConfirm } from '@/components/ui/confirm-dialog';
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

/*
 * Bank details, as the client is ever allowed to hold them.
 *
 * account_number and account_name are ENCRYPTED AT REST (contract addendum),
 * so GET /api/profile/details ships them MASKED and never in clear. The record
 * uses the `_masked` key spelling; a pending request's nested `bank` object
 * masks the same two fields, and the contract does not fix which spelling the
 * service uses there — so both are read, through maskedText(), which also
 * refuses to render anything that still looks like ciphertext.
 *
 * The plaintext lives behind POST /api/profile/bank/reveal only. It is never
 * part of this type: a value that arrives here by accident would be rendered.
 */
export type BankDetails = {
  account_number_masked?: string | null;
  account_name_masked?: string | null;
  /* Same two values under the un-suffixed names — a pending request's shape. */
  account_number?: string | null;
  account_name?: string | null;
  /* Clear on purpose: an IFSC is a published RBI branch code and the bank name
   * is a lookup label. Encrypting them buys nothing. */
  ifsc?: string | null;
  bank_name?: string | null;
  has_details?: boolean;
};

/** What a reveal endpoint hands back. Held in state, never persisted or logged. */
export type RevealedBank = {
  account_number?: string | null;
  account_name?: string | null;
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
  /*
   * A short-TTL PRESIGNED S3 url, resolved into this payload so the avatar
   * costs no second request. Never a placeholder image: `null` is the only way
   * "no photo" is expressed, so "no photo set" and "a photo that failed to
   * load" can never look the same to this code. It is also null when S3 is
   * unreachable — the backend resolves it fail-soft — which makes the initials
   * monogram the degraded state as well as the empty one.
   */
  photo_url: string | null;
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

/*
 * Ciphertext is `v1:<iv>:<tag>:<ct>` (contract addendum, "Cipher"). If one ever
 * reaches the client it is a server bug, and the ONE thing this UI must not do
 * is paint it on the screen as though it were a value — a stored secret shown
 * to whoever is standing behind the operator. Rendered as absent instead.
 */
const CIPHERTEXT_RE = /^v\d+:/;

/**
 * First usable masked string among the candidates, or null.
 * Anything shaped like ciphertext is discarded rather than displayed.
 */
export function maskedText(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    const s = String(c ?? '').trim();
    if (!s) continue;
    if (CIPHERTEXT_RE.test(s)) return null;
    return s;
  }
  return null;
}

export const bankAccountMasked = (b?: BankDetails | null) =>
  maskedText(b?.account_number_masked, b?.account_number);
export const bankHolderMasked = (b?: BankDetails | null) =>
  maskedText(b?.account_name_masked, b?.account_name);

/** One-line summary. Masked halves only — this line appears in banners and confirms. */
export function bankLine(bank?: BankDetails | null): string {
  if (!bank) return '';
  const parts = [
    bankHolderMasked(bank), bankAccountMasked(bank),
    maskedText(bank.ifsc), maskedText(bank.bank_name),
  ].filter(Boolean);
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
 * Revealing an encrypted value — shared by /profile and /hrms/approvals.
 *
 * A reveal is a POST, not a CSS toggle: it round-trips to the server, it can
 * fail, and it writes an audit row. Treating it as instant is the bug this
 * hook exists to prevent — hence a real busy state and an error toast, and an
 * in-flight guard so a double click cannot bill two audit rows for one look.
 *
 * The value is re-masked on a timer and on unmount. Neither is security (it
 * already crossed the wire) — both are about the screen someone walked away
 * from, which is the realistic way a colleague's account number gets read.
 * ═══════════════════════════════════════════════════════════════════════════ */

export const REVEAL_AUTO_MASK_MS = 30_000;

export function useReveal<T>(load: () => Promise<T>, ms = REVEAL_AUTO_MASK_MS) {
  const [value, setValue] = React.useState<T | null>(null);
  const [busy, setBusy] = React.useState(false);

  /* In a ref so an inline arrow at the call site neither re-creates show() on
   * every render nor leaves it closed over a stale loader. */
  const loadRef = React.useRef(load);
  loadRef.current = load;

  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = React.useRef(true);
  const inFlight = React.useRef(false);

  const hide = React.useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setValue(null);
  }, []);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    };
  }, []);

  const show = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const v = await loadRef.current();
      /* Unmounted mid-flight — the plaintext is dropped, never stored. */
      if (!mounted.current) return;
      setValue(v);
      timer.current = setTimeout(() => setValue(null), ms);
    } catch (e) {
      /* The message is the server's, which carries no value; nothing revealed
       * is ever written to the console. */
      if (mounted.current) {
        showToast({
          variant: 'error',
          message: e instanceof ApiError ? e.message : 'Could not show the details — please retry.',
        });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [ms]);

  const toggle = React.useCallback(() => {
    if (value !== null) hide(); else void show();
  }, [value, hide, show]);

  return { value, busy, shown: value !== null, show, hide, toggle };
}

/** The eye. `what` is the Title Case thing being shown, e.g. "Bank Details". */
export function RevealButton({ shown, busy, onToggle, what }: {
  shown: boolean;
  busy: boolean;
  onToggle: () => void;
  what: string;
}) {
  return (
    <IconButton
      icon={shown ? EyeOff : Eye}
      label={shown ? `Hide ${what}` : `Show ${what}`}
      busy={busy}
      onClick={onToggle}
    />
  );
}

/*
 * Said once per section, before anyone clicks. The audit log protects the
 * company either way; telling people it exists is what protects the colleague
 * whose account number is being read.
 */
export function RevealNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-muted-foreground flex items-start gap-1.5">
      <Eye className="size-3.5 shrink-0 mt-0.5" aria-hidden />
      <span>
        {children} They hide again on their own after {REVEAL_AUTO_MASK_MS / 1000} seconds.
      </span>
    </p>
  );
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
        {/* `text-warning`, NOT `text-warning-strong`: -strong is the FOREGROUND
            half of the bg-warning-tint pairing and the two swap between themes,
            so used bare on a card it renders near-white in dark. --warning is
            the same amber in both. */}
        <Clock className="size-4 text-warning mt-0.5 shrink-0" aria-hidden />
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
 * The edit surfaces — the profile photo, and the one dialog that edits
 * everything else.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* The FORM's shape, deliberately not BankDetails: what the user types is
 * plaintext, what the record holds is masked. Keeping them one type is how a
 * row of dots ends up submitted as an account number. */
type BankForm = { account_name: string; account_number: string; ifsc: string; bank_name: string };
const EMPTY_BANK: BankForm = { account_number: '', ifsc: '', account_name: '', bank_name: '' };


/* ═══════════════════════════════════════════════════════════════════════════
 * ProfilePhoto — the identity band's avatar, and the only place it is set.
 *
 * The url arrives ALREADY RESOLVED on GET /profile/details as `photo_url`: a
 * short-TTL presigned S3 url, public for its TTL. So it is a plain <img src>.
 *
 * There is deliberately no fetch-as-Blob / object-URL dance here. That IS the
 * house pattern for an authenticated /admin image (see `AuthImage` in
 * components/job/JobDocumentsCard.tsx) — but this endpoint needs no bearer
 * token, so the pattern would only add an object URL with a revoke lifecycle to
 * get wrong. Resolving the url into the details payload also means one round
 * trip: a returning user never sees their own initials for a beat before the
 * photo arrives.
 *
 * `photo_url === null` is the ONLY way "no photo" is expressed — never a
 * placeholder image — and it is also what a fail-soft backend returns when S3
 * is unreachable. So the initials monogram is the empty state AND the degraded
 * state, and has to look deliberate as both. It does: a solid brand plate.
 *
 * The one object URL that IS created here is the local preview of a file the
 * user just picked, which has no url until it is uploaded. That one is revoked
 * on replacement, on cancel and on unmount.
 *
 * A photo needs no approval: it is not in the approval set.
 * ═══════════════════════════════════════════════════════════════════════════ */

/*
 * The backend identifies the type from the file's MAGIC BYTES, not from the
 * extension or the browser-declared MIME type — so a .gif renamed .png is
 * rejected there however this input is configured. The client check is the
 * fast, kind half of that; the copy says what is actually allowed so the answer
 * does not have to come from a server error.
 */
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_HINT = 'JPEG, PNG or WEBP only, up to 5 MB — the file itself has to be one of those, not just named like one.';

/* One plate geometry for the photo, the preview and the initials fallback.
 * `bg-primary text-primary-foreground` measures 5.77:1 in BOTH themes; the
 * previous `bg-primary/10 text-primary` was 1.85:1 in dark — the page's
 * identity anchor, near-unreadable. */
const PLATE = 'size-16 shrink-0 rounded-2xl overflow-hidden flex items-center justify-center';

export function ProfilePhoto({ initials, photoUrl }: {
  initials: string;
  photoUrl: string | null;
}) {
  const confirm = useConfirm();
  const [draft, setDraft] = React.useState<{ file: File; url: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  /* A presigned url can expire while the page is open. Falling back to the
   * monogram beats a broken-image glyph — and it is reset whenever a new url
   * arrives, so a refresh recovers. */
  const [imgFailed, setImgFailed] = React.useState(false);
  React.useEffect(() => { setImgFailed(false); }, [photoUrl]);

  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const draftUrl = React.useRef<string | null>(null);
  React.useEffect(() => () => {
    if (draftUrl.current) URL.revokeObjectURL(draftUrl.current);
  }, []);

  function chooseFile(file?: File | null) {
    if (!file) return;
    /* Checked at the boundary, not just by the input's accept attribute —
     * accept is a file-picker filter, not a guarantee. */
    if (!PHOTO_TYPES.includes(file.type)) {
      showToast({ variant: 'error', message: `That is not an image we can accept. ${PHOTO_HINT}` });
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      showToast({ variant: 'error', message: `That image is too large. ${PHOTO_HINT}` });
      return;
    }
    if (draftUrl.current) URL.revokeObjectURL(draftUrl.current);
    const url = URL.createObjectURL(file);
    draftUrl.current = url;
    setDraft({ file, url });
  }

  function clearDraft() {
    if (draftUrl.current) { URL.revokeObjectURL(draftUrl.current); draftUrl.current = null; }
    setDraft(null);
  }

  /* photo_url now rides on the details payload, so THAT is what a write has to
   * invalidate for the avatar to change. */
  const refreshDetails = () => invalidateFetch((k) => k.startsWith('/profile/details'));

  async function savePhoto() {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('photo', draft.file);
      await api.post('/profile/photo', fd);
      clearDraft();
      refreshDetails();
      showToast({ variant: 'success', message: 'Profile photo updated.' });
    } catch (e) {
      showToast({
        variant: 'error',
        message: e instanceof ApiError ? e.message : 'Could not save the photo — please retry.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto() {
    if (busy) return;
    const ok = await confirm({
      title: 'Remove Profile Photo?',
      variant: 'destructive',
      confirmLabel: 'Remove Photo',
      cancelLabel: 'Keep Photo',
      description: 'Your initials are shown instead. You can upload a new photo at any time.',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.delete('/profile/photo');
      refreshDetails();
      showToast({ variant: 'success', message: 'Profile photo removed.' });
    } catch (e) {
      showToast({
        variant: 'error',
        message: e instanceof ApiError ? e.message : 'Could not remove the photo — please retry.',
      });
    } finally {
      setBusy(false);
    }
  }

  /* The draft wins while one is pending: what you are about to commit is what
   * you should be looking at. */
  const shown = draft?.url ?? (imgFailed ? null : photoUrl);

  return (
    <div className="shrink-0 flex flex-col items-center gap-1.5">
      <span
        aria-hidden
        className={`${PLATE} ${shown ? 'bg-muted' : 'bg-primary text-primary-foreground font-semibold text-xl'}`}
      >
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element -- a presigned S3
          // url with a short TTL; next/image would try to proxy and cache it.
          <img
            src={shown}
            alt=""
            className="size-full object-cover"
            onError={() => { if (!draft) setImgFailed(true); }}
          />
        ) : initials}
      </span>

      <input
        ref={fileRef}
        type="file"
        accept={PHOTO_TYPES.join(',')}
        className="hidden"
        onChange={(e) => { chooseFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      <div className="flex items-center gap-1">
        {draft ? (
          <>
            <IconButton icon={Check} label="Save Photo" intent="success" busy={busy} onClick={savePhoto} />
            <IconButton icon={X} label="Discard Photo" intent="danger" disabled={busy} onClick={clearDraft} />
          </>
        ) : (
          <>
            <IconButton
              icon={Camera}
              label={photoUrl ? 'Change Photo' : 'Upload Photo'}
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            />
            {photoUrl && (
              <IconButton icon={Trash2} label="Remove Photo" intent="danger" busy={busy} onClick={removePhoto} />
            )}
          </>
        )}
      </div>
      {draft && (
        <p className="text-xs text-muted-foreground text-center max-w-[8rem]">Preview — Not Saved Yet</p>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════════════
 * EditProfileDialog — ONE button, ONE modal, ONE submission.
 *
 * The page used to grow an outline "Request Change" per field: three of them on
 * a settled record plus a fourth on the Bank header, each opening its own
 * dialog and each POSTing its own request that the backend then MERGED into the
 * same open row. This is that model expressed directly instead: every editable
 * field in one modal, one POST carrying { mobile_no?, date_of_birth?, bank? }.
 *
 * ONLY CHANGED FIELDS ARE SENT. An unchanged field added to the request is a
 * field HR must approve that nobody asked to change.
 *
 * ALTERNATE NUMBER IS THE ODD ONE OUT, and is separated visually because of it:
 * it writes straight to tbl_user with no approval (PATCH /profile/alternate-no).
 * Quietly folding it into the request would be less code and would be wrong —
 * it would put a field behind an approval the contract says it does not need.
 * So it keeps its own call, made first.
 * ═══════════════════════════════════════════════════════════════════════════ */

function DialogGroup({ title, note, children }: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div>
        <div className="text-xs font-semibold">{title}</div>
        <p className="text-xs text-muted-foreground mt-0.5">{note}</p>
      </div>
      {children}
    </div>
  );
}

/* Marks a field the user has already asked to change: the input is seeded with
 * the PENDING value, so editing it revises the request rather than adding to it. */
function PendingMark({ shown }: { shown: boolean }) {
  if (!shown) return null;
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <StatusChip tone="warning" size="sm">Awaiting Approval</StatusChip>
      <span className="text-xs text-muted-foreground">Editing this revises your open request.</span>
    </span>
  );
}

export function EditProfileDialog({ details, onClose, onSubmitted }: {
  details: ProfileDetails;
  onClose: () => void;
  onSubmitted: () => void | Promise<void>;
}) {
  const pendingChanges = details.pending?.changes;
  const pendingMobile = pendingChanges?.mobile_no;
  const pendingDob = pendingChanges?.date_of_birth;
  const pendingBank = pendingChanges?.bank;

  /* Baselines: what is already pending wins over what is on record, because a
   * pending value is what the user last asked for. */
  const baseAlt = String(details.alternate_no ?? '');
  const baseMobile = String(pendingMobile ?? details.mobile_no ?? '');
  const baseDob = String(pendingDob ?? details.date_of_birth ?? '').slice(0, 10);

  const [alt, setAlt] = React.useState(baseAlt);
  const [phone, setPhone] = React.useState(baseMobile);
  const [dob, setDob] = React.useState(baseDob);
  /*
   * Account number and holder name start EMPTY and must be typed in full: the
   * only form of them this client holds is masked, and prefilling a row of dots
   * is how a mask gets submitted as an account number. IFSC and bank name are
   * stored in clear, so those seed normally.
   */
  const [bank, setBank] = React.useState<BankForm>(() => ({
    ...EMPTY_BANK,
    ifsc: maskedText(pendingBank?.ifsc, details.bank?.ifsc) ?? '',
    bank_name: maskedText(pendingBank?.bank_name, details.bank?.bank_name) ?? '',
  }));
  const bankSeed = React.useRef(bank);
  const [submitting, setSubmitting] = React.useState(false);

  const setBankField = (k: keyof BankForm, v: string) => setBank((b) => ({ ...b, [k]: v }));

  /*
   * A date of birth that has never been set is NOT editable here: the first one
   * is a direct write (POST /profile/date-of-birth) with no approval, and it
   * has its own control on the page. Offering it in this modal would route the
   * free set through an approval it does not need.
   */
  const dobEditable = !!details.date_of_birth || details.dob_locked || pendingDob !== undefined;

  /*
   * A first ADD is still a request for everything except the date of birth.
   * There is no direct write route for a mobile number or a bank block at all
   * (routes/profile.js exposes only alternate-no, date-of-birth and
   * update-requests), so the copy says "Add" but the consequence line does not
   * soften: HR still has to approve it.
   */
  const hasBankOnRecord = details.bank?.has_details
    ?? !!(bankAccountMasked(details.bank) || bankHolderMasked(details.bank)
      || details.bank?.ifsc || details.bank?.bank_name);

  /* ── What actually changed ───────────────────────────────────────────── */
  const altDirty = alt !== baseAlt;
  const phoneDirty = phone !== baseMobile;
  const dobDirty = dobEditable && dob !== baseDob;
  const bankDirty = (Object.keys(bank) as Array<keyof BankForm>)
    .some((k) => bank[k] !== bankSeed.current[k]);
  const dirty = altDirty || phoneDirty || dobDirty || bankDirty;

  /* ── Per-field validation ────────────────────────────────────────────── */
  const altError = alt !== '' && !PHONE_RE.test(alt) ? PHONE_ERROR : null;
  const phoneError = phone.length > 0 && !PHONE_RE.test(phone) ? PHONE_ERROR : null;
  const dobFieldError = dob.length > 0 ? dobError(dob) : null;
  const ifscError = bank.ifsc.length > 0 && !IFSC_RE.test(bank.ifsc) ? IFSC_ERROR : null;
  const bankComplete = bank.account_name.trim() !== ''
    && bank.account_number.trim() !== ''
    && IFSC_RE.test(bank.ifsc)
    && bank.bank_name.trim() !== '';
  /* All four move as one — a request cannot carry half a bank account. */
  const bankError = bankDirty && !bankComplete
    ? 'All four bank fields are needed: HR approves them as one set.'
    : null;

  const canSubmit = dirty && !submitting
    && !(altDirty && altError)
    && !(phoneDirty && !PHONE_RE.test(phone))
    && !(dobDirty && (dob === '' || dobError(dob) !== null))
    && !(bankDirty && !bankComplete);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    const done: string[] = [];
    try {
      /* The direct write goes first: it needs no approval, so it must not be
       * held hostage by the request that does. */
      if (altDirty) {
        await api.patch('/profile/alternate-no', { alternate_no: alt });
        done.push('Alternate number saved');
      }

      const changes: PendingChanges = {};
      if (phoneDirty) changes.mobile_no = phone;
      if (dobDirty) changes.date_of_birth = dob;
      if (bankDirty) {
        changes.bank = {
          account_name: bank.account_name.trim(),
          account_number: bank.account_number.trim(),
          ifsc: bank.ifsc.trim().toUpperCase(),
          bank_name: bank.bank_name.trim(),
        };
      }
      const n = Object.keys(changes).length;
      if (n > 0) {
        await api.post('/profile/update-requests', { changes });
        done.push(`${n} ${n === 1 ? 'change' : 'changes'} sent to HR — nothing moves until approved`);
      }

      invalidateFetch((k) => k.startsWith('/profile'));
      showToast({ variant: 'success', message: `${done.join('. ')}.` });
      await onSubmitted();
    } catch (e) {
      /* Invalidate on the failure path too: the alternate number may already
       * have been written before the request POST failed, and the page must not
       * keep showing the old one. */
      invalidateFetch((k) => k.startsWith('/profile'));
      showToast({
        variant: 'error',
        message: e instanceof ApiError ? e.message : 'Could not save — please retry.',
      });
      setSubmitting(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(
    () => { if (!submitting) onClose(); },
    { isDirty: () => dirty },
  );

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Profile Details</DialogTitle>
          <DialogDescription>
            Change anything below and submit once. Only the fields you actually change are sent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <DialogGroup
            title="Saves Immediately"
            note="This one is yours to change — it is written straight to your record, with no HR approval."
          >
            <div className="space-y-1">
              <Label htmlFor="pf-alt">Alternate Number</Label>
              <Input
                id="pf-alt"
                value={alt}
                onChange={(e) => setAlt(e.target.value.replace(/\D/g, '').slice(0, 10))}
                inputMode="numeric"
                autoComplete="off"
                placeholder="10-digit number"
                className="font-mono"
              />
              {altError && <p className="text-xs text-destructive">{altError}</p>}
              <p className="text-xs text-muted-foreground">Leave it empty to remove the number.</p>
            </div>
          </DialogGroup>

          <DialogGroup
            title="Needs HR Approval"
            note="Nothing here reaches your record until HR approves it, and they approve or reject the whole request together. Adding one of these for the first time is a request too — only a date of birth has a free first set."
          >
            <div className="space-y-1">
              <Label htmlFor="pf-mobile">{details.mobile_no ? 'Mobile Number' : 'Add Mobile Number'}</Label>
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
              <PendingMark shown={pendingMobile !== undefined} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="pf-dob">Date Of Birth</Label>
              {dobEditable ? (
                <>
                  <Input
                    id="pf-dob"
                    type="date"
                    value={dob}
                    min={dobMin()}
                    max={dobMax()}
                    onChange={(e) => setDob(e.target.value)}
                  />
                  {dobFieldError && <p className="text-xs text-destructive">{dobFieldError}</p>}
                  <PendingMark shown={pendingDob !== undefined} />
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Not set yet. Your first date of birth needs no approval — set it on the
                  Personal &amp; Contact Details row, and it is locked after that.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium">{hasBankOnRecord ? 'Bank Details' : 'Add Bank Details'}</div>
              <p className="text-xs text-muted-foreground">
                {hasBankOnRecord
                  ? 'Your account number and holder name are stored encrypted, so they are not filled in here — type both in full to change them. The IFSC code and bank name are carried over.'
                  : 'No bank details on record yet. Adding them is still a request: HR has to approve it, and nothing reaches your record until they do.'}
                {' '}Leave all four untouched and no bank change is sent.
              </p>
              <div className="space-y-1">
                <Label htmlFor="pf-bank-name-holder">Account Holder Name</Label>
                <Input
                  id="pf-bank-name-holder"
                  value={bank.account_name}
                  onChange={(e) => setBankField('account_name', e.target.value)}
                  placeholder="Name As It Appears At The Bank"
                  autoComplete="off"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="pf-bank-account">Account Number</Label>
                  <Input
                    id="pf-bank-account"
                    value={bank.account_number}
                    onChange={(e) => setBankField('account_number', e.target.value.replace(/[^0-9]/g, '').slice(0, 32))}
                    inputMode="numeric"
                    autoComplete="off"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pf-bank-ifsc">IFSC Code</Label>
                  <Input
                    id="pf-bank-ifsc"
                    value={bank.ifsc}
                    onChange={(e) => setBankField('ifsc', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11))}
                    placeholder="e.g. HDFC0001234"
                    autoComplete="off"
                    className="font-mono uppercase"
                  />
                  {ifscError && <p className="text-xs text-destructive">{ifscError}</p>}
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pf-bank-bank">Bank Name</Label>
                <Input
                  id="pf-bank-bank"
                  value={bank.bank_name}
                  onChange={(e) => setBankField('bank_name', e.target.value.slice(0, 120))}
                  autoComplete="off"
                />
              </div>
              {bankError && <p className="text-xs text-destructive">{bankError}</p>}
              <PendingMark shown={pendingBank !== undefined} />
            </div>
          </DialogGroup>

          {!dirty && (
            <p className="text-xs text-muted-foreground">
              Nothing has changed yet — edit a field above to enable Submit.
            </p>
          )}
        </div>

        <DialogFooter>
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? 'Submitting…' : 'Submit Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
