'use client';

/*
 * Points Ledger — the complete audit trail of the technician rewards
 * programme, and the ONLY surface where a balance can be corrected.
 *
 * ── What "points" are (and are not) ──────────────────────────────────────
 * Points are earned for good work (a good customer rating, a same-day
 * appointment, a successful referral) and are spent in the rewards shop.
 * They are NOT money. EasyFix runs a separate real wallet for advances and
 * withdrawals; a point can only ever become a shop item, never cash. Every
 * string on this page is written to keep that boundary obvious — an operator
 * who reads a points balance as rupees will eventually try to reconcile it
 * against payouts, and the copy is the cheapest place to stop that.
 *
 * ── Reading a row ────────────────────────────────────────────────────────
 * `delta` is SIGNED — positive is a credit, negative a debit — so the ledger
 * is a single stream rather than two columns that have to be mentally
 * summed. `reason_code` says WHY, and `ref_type`/`ref_id` say against WHAT,
 * which together answer the only question an operator ever asks of this
 * table: "what was this for?".
 *
 * ── Writing a row ────────────────────────────────────────────────────────
 * The Adjust Points dialog (gated on `isRewardsManage`) is the manual
 * correction path. It shows the technician's CURRENT balance before the
 * operator types anything and the RESULTING balance before they commit —
 * adjusting blind is exactly how balances go wrong, and the backend's 409
 * on an overdraw would otherwise be the first time anyone learns the
 * balance was smaller than assumed.
 *
 * Reads stay ungated: a coordinator answering "why did my points drop?"
 * needs the ledger without holding the permission to change it.
 */

import * as React from 'react';
import { Coins, Search, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { formatEasyfixerName } from '@/lib/utils';
import { TechnicianPicker, techOption, type EasyfixerLite } from '@/components/ui/technician-picker';
import { RewardsPausedNotice } from '@/components/rewards/RewardsPausedNotice';

/* ── Types ──────────────────────────────────────────────────────────────── */

type ReasonCode = 'RATING' | 'SDA' | 'REFERRAL' | 'CLAIM' | 'CLAIM_REFUND' | 'MANUAL';

type LedgerRow = {
  id: number;
  easyfixer_id: number;
  /* SIGNED — positive credit, negative debit. Never render bare: the sign
     carries half the meaning, so the cell prints it explicitly. */
  delta: number;
  reason_code: ReasonCode | string;
  ref_type: 'job' | 'claim' | 'referral' | null;
  ref_id: number | null;
  note: string | null;
  /*
   * NULL for system-awarded points (rating / SDA / referral crons). Rendered
   * as "System", not an em-dash — "nobody" and "the system did it" are
   * different facts, and only one of them is true here.
   */
  created_by: string | number | null;
  created_at: string;
  /* LEFT-joined, so a purged technician still lists rather than vanishing. */
  technician_name: string | null;
  technician_mobile: string | null;
};
type LedgerResp = { rows: LedgerRow[]; total: number; limit: number; offset: number };

/* Bare ARRAY (not {rows,total}) — /shared/lookup/* returns the list directly. */
type BalanceResp = { easyfixer_id: number; balance: number };
type AdjustResp = { balance: number };

/* ── Backend bounds, mirrored ───────────────────────────────────────────── */

/*
 * Mirrors the POST /admin/rewards/ledger/adjust Joi bounds. Enforced in the
 * form too, so an out-of-range delta or a two-character note fails inline
 * instead of as a bare 400 toast after the round-trip.
 */
const MAX_ABS_DELTA = 100_000;
const NOTE_MIN = 3;
const NOTE_MAX = 255;

/*
 * 'All' is deliberately absent. The ledger is an append-only audit trail that
 * only ever grows, so "All" would render one un-navigable page whose range
 * hint claims to show every row while the response was silently truncated at
 * the endpoint's limit.
 */
const LEDGER_PAGE_SIZES: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
];

/*
 * Human labels for the reason enum. The raw codes are storage, not language —
 * "SDA" tells an operator nothing, and a table that speaks in enums forces
 * everyone to keep a decoder in their head. Tones are all distinct so the
 * reason is legible at a glance without reading the words.
 */
const REASON_META: Record<ReasonCode, { label: string; tone: StatusChipTone }> = {
  RATING:       { label: 'Good Rating',           tone: 'emerald' },
  SDA:          { label: 'Same-Day Appointment',  tone: 'sky'     },
  REFERRAL:     { label: 'Referral',              tone: 'violet'  },
  CLAIM:        { label: 'Reward Claimed',        tone: 'amber'   },
  CLAIM_REFUND: { label: 'Claim Refunded',        tone: 'orange'  },
  MANUAL:       { label: 'Manual Adjustment',     tone: 'slate'   },
};

const REASON_ORDER: ReasonCode[] = ['RATING', 'SDA', 'REFERRAL', 'CLAIM', 'CLAIM_REFUND', 'MANUAL'];

/*
 * An unrecognised code (a reason added on the BE before this page knows about
 * it) shows its raw value rather than being swallowed into "Manual
 * Adjustment" — a wrong label is worse than an unfamiliar one.
 */
function reasonMeta(code: string): { label: string; tone: StatusChipTone } {
  return REASON_META[code as ReasonCode] ?? { label: code, tone: 'slate' };
}

const REF_NOUNS: Record<string, string> = { job: 'Job', claim: 'Claim', referral: 'Referral' };

/*
 * "Job #88213" / "Claim #1042" — the pointer back to whatever caused the
 * movement. Returns null when the row carries no reference (a manual
 * adjustment points at nothing but its own note).
 */
function refLabel(refType: string | null, refId: number | null): string | null {
  if (!refType || refId == null) return null;
  const noun = REF_NOUNS[refType] ?? refType.charAt(0).toUpperCase() + refType.slice(1);
  return `${noun} #${refId}`;
}

/*
 * `created_by` is NULL when the points were awarded by a system rule rather
 * than a person. "System" is the truth; an em-dash would read as missing data
 * and send someone hunting for an operator who never existed. A numeric value
 * is a user id we cannot resolve to a name here, so it is labelled as one
 * instead of being printed as a bare number that looks like a quantity.
 */
function formatCreatedBy(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return 'System';
  const t = String(v).trim();
  if (!t) return 'System';
  return /^\d+$/.test(t) ? `User #${t}` : t;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/*
 * `created_at` arrives as a raw MySQL DATETIME string ("2026-08-13 10:30:00")
 * because the BE pool runs `dateStrings: true` — it is already an IST
 * wall-clock reading, NOT an instant. `new Date(...)` + toLocaleString would
 * re-interpret it in the viewer's timezone and shift every timestamp in an
 * audit trail, so we format the string's own parts and never build a Date.
 */
function formatStamp(raw: string | null | undefined): string {
  if (!raw) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(raw));
  // Unexpected shape → show it verbatim. "Invalid Date" tells the operator
  // nothing; the raw value at least hints at what the BE actually sent.
  if (!m) return String(raw);
  const [, year, month, day, hh, mi] = m;
  const hour24 = Number(hh);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${day} ${MONTHS[Number(month) - 1] ?? month} ${year}, ${String(hour12).padStart(2, '0')}:${mi} ${hour24 >= 12 ? 'PM' : 'AM'}`;
}

/*
 * Whole numbers only, sign allowed. '' and anything non-integer return null so
 * the form can say what is wrong instead of silently coercing to NaN (or, far
 * worse, to 0 — a zero delta is a write that changes nothing while reporting
 * success).
 */
function parseDelta(raw: string): number | null {
  const t = raw.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/* ── Points cell ────────────────────────────────────────────────────────── */

/*
 * The star column. Points are a currency but NOT rupees, so this deliberately
 * looks nothing like the ₹ amounts elsewhere in the CRM: no symbol, an
 * explicit sign, and a "pts" unit that makes the kind of quantity unmistakable
 * at a glance. Green credits / red debits carry the direction; tabular numerals
 * keep the digits aligned down the column so a scan reads as a running list of
 * magnitudes rather than ragged text.
 */
function PointsCell({ delta }: { delta: number }) {
  // Guarded even though the API forbids a zero delta — a legacy or corrupt row
  // must not render as "−0", which reads as a debit that never happened.
  if (!delta) {
    return (
      <span className="text-muted-foreground tabular-nums">
        0<span className="ml-1 text-[10px] uppercase tracking-wide">pts</span>
      </span>
    );
  }
  const credit = delta > 0;
  return (
    <span className={credit ? 'text-emerald-700' : 'text-rose-700'}>
      <span className="font-semibold tabular-nums">
        {credit ? '+' : '−'}
        {Math.abs(delta).toLocaleString('en-IN')}
      </span>
      <span className="ml-1 text-[10px] uppercase tracking-wide opacity-70">pts</span>
    </span>
  );
}

/* ── Technician picker ──────────────────────────────────────────────────── */

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function PointsLedgerPage() {
  const { me } = useMe();
  const can = actionFlags(me, ['isRewardsManage']);

  const [search, setSearch] = React.useState('');
  const [reasonCode, setReasonCode] = React.useState<string>('');
  const [easyfixerId, setEasyfixerId] = React.useState<number | ''>('');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  const [adjustOpen, setAdjustOpen] = React.useState(false);

  const dq = useDebouncedValue(search, 300);
  const limit = pageSize === 'all' ? 1000 : pageSize;

  const qs = new URLSearchParams();
  if (dq.trim()) qs.set('q', dq.trim());
  if (reasonCode) qs.set('reasonCode', reasonCode);
  if (easyfixerId !== '') qs.set('easyfixerId', String(easyfixerId));
  qs.set('limit', String(limit));
  qs.set('offset', String(page * limit));
  const listFetch = useFetch<LedgerResp>(`/admin/rewards/ledger?${qs.toString()}`);

  /*
   * Any filter change re-queries from row 0. Without this, narrowing a filter
   * while on page 4 asks for an offset the smaller result set no longer has
   * and the table renders empty with no visible cause.
   */
  React.useEffect(() => { setPage(0); }, [dq, reasonCode, easyfixerId]);

  const reasonOptions = React.useMemo<SearchOption[]>(
    () => [
      { value: '', label: 'All Reasons' },
      ...REASON_ORDER.map((c) => ({ value: c, label: REASON_META[c].label, keywords: c })),
    ],
    [],
  );

  /*
   * Post-write refresh. `invalidateFetch` only evicts the module cache — it
   * has no subscriber mechanism, so a MOUNTED useFetch keeps showing the old
   * rows until something re-requests. The explicit `refetch()` is what
   * actually puts the new entry on screen.
   */
  function handleAdjusted() {
    setAdjustOpen(false);
    invalidateFetch((k) => k.startsWith('/admin/rewards'));
    listFetch.refetch();
  }

  const rows = listFetch.data?.rows ?? [];
  const total = listFetch.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <RewardsPausedNotice />
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Coins className="size-6" /> Points Ledger
          </h1>
          <p className="text-sm text-muted-foreground">
            Every points credit and debit, and the only place to correct a balance. Points are
            earned for good work and spent in the rewards shop — they are never paid out as cash.
          </p>
        </div>
        {can.isRewardsManage && (
          <Button onClick={() => setAdjustOpen(true)}>
            <SlidersHorizontal className="size-4 mr-1" /> Adjust Points
          </Button>
        )}
      </div>

      {/* ── Filters ────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by technician name, mobile, or note…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              aria-label="Search Ledger"
            />
          </div>
          <SearchSelect
            value={reasonCode}
            onChange={(v) => setReasonCode(v)}
            options={reasonOptions}
            placeholder="All Reasons"
            className="w-56"
          />
          <TechnicianPicker
            value={easyfixerId}
            onPick={(t) => setEasyfixerId(t ? t.efr_id : '')}
            placeholder="All Technicians"
            allLabel="All Technicians"
            className="w-72"
          />
        </CardContent>
      </Card>

      {listFetch.error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle className="size-4" /> {listFetch.error}
          </CardContent>
        </Card>
      )}

      {/* ── Ledger ─────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full">
            <colgroup>
              {/* Date */}
              <col style={{ width: '15%' }} />
              {/* Technician */}
              <col style={{ width: '20%' }} />
              {/* Points */}
              <col style={{ width: '10%' }} />
              {/* Reason */}
              <col style={{ width: '16%' }} />
              {/* Details */}
              <col style={{ width: '28%' }} />
              {/* By */}
              <col style={{ width: '11%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="!text-left whitespace-nowrap">Date</th>
                <th className="!text-left">Technician</th>
                <th className="!text-right whitespace-nowrap">Points</th>
                <th className="!text-left">Reason</th>
                <th className="!text-left">Details</th>
                <th className="!text-left">By</th>
              </tr>
            </thead>
            <tbody>
              {listFetch.loading && (
                <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!listFetch.loading && rows.length === 0 && (
                <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">No points entries match the current filters.</td></tr>
              )}
              {!listFetch.loading && rows.map((r) => {
                const meta = reasonMeta(r.reason_code);
                const ref = refLabel(r.ref_type, r.ref_id);
                return (
                  <tr key={r.id}>
                    <td className="!text-left whitespace-nowrap text-xs">{formatStamp(r.created_at)}</td>
                    <td className="!text-left">
                      <div className="font-medium">
                        {r.technician_name
                          ? formatEasyfixerName(r.technician_name)
                          : `Technician #${r.easyfixer_id}`}
                      </div>
                      {/*
                       * Mobiles arrive pre-masked ("9876••••••") from the admin
                       * masking middleware. Rendered verbatim — any reformatting
                       * here would mangle the bullets.
                       */}
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {r.technician_mobile || '—'}
                      </div>
                    </td>
                    <td className="!text-right whitespace-nowrap">
                      <PointsCell delta={r.delta} />
                    </td>
                    <td className="!text-left">
                      <StatusChip tone={meta.tone} size="sm">{meta.label}</StatusChip>
                    </td>
                    <td className="!text-left">
                      {r.note && <div className="text-xs">{r.note}</div>}
                      {ref && <div className="text-[11px] text-muted-foreground">{ref}</div>}
                      {!r.note && !ref && <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="!text-left text-xs">{formatCreatedBy(r.created_by)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <TablePagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
        pageSizeOptions={LEDGER_PAGE_SIZES}
      />

      {/* Mounted only while open, so every adjustment starts from a clean
          form. The permission is re-checked here as well as on the trigger —
          a dialog that can write is worth gating at the dialog. */}
      {adjustOpen && can.isRewardsManage && (
        <AdjustPointsDialog
          onClose={() => setAdjustOpen(false)}
          onSaved={handleAdjusted}
        />
      )}
    </div>
  );
}

/* ── Adjust Points ──────────────────────────────────────────────────────── */

/*
 * Manual credit / debit. Three things make this safe rather than merely
 * possible:
 *
 *   1. The CURRENT balance is fetched and shown as soon as a technician is
 *      picked. An operator adjusting blind is how balances go wrong.
 *   2. The RESULTING balance is shown before they commit, and a debit that
 *      would push it below zero disables the button — the backend refuses
 *      that with a 409, and finding out from a red toast after the fact is a
 *      worse way to learn it. The 409 is still caught, because the balance
 *      can move between the fetch and the submit.
 *   3. The note is REQUIRED. Every manual row lands in the ledger as
 *      "Manual Adjustment", and without the reason beside it nobody
 *      reviewing this table six months from now can tell a correction from a
 *      mistake.
 */
function AdjustPointsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  const [tech, setTech] = React.useState<EasyfixerLite | null>(null);
  const [deltaRaw, setDeltaRaw] = React.useState('');
  const [note, setNote] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const balanceFetch = useFetch<BalanceResp>(tech ? `/admin/rewards/balance/${tech.efr_id}` : null);
  const current = balanceFetch.data?.balance ?? null;

  const delta = parseDelta(deltaRaw);
  const deltaFormatInvalid = deltaRaw.trim() !== '' && delta === null;
  const deltaIsZero = delta === 0;
  const deltaOverBounds = delta !== null && Math.abs(delta) > MAX_ABS_DELTA;
  const deltaValid = delta !== null && !deltaIsZero && !deltaOverBounds;

  const trimmedNote = note.trim();
  const noteValid = trimmedNote.length >= NOTE_MIN && trimmedNote.length <= NOTE_MAX;

  /*
   * Preview only — the balance the API returns is the one that counts. Null
   * while the balance is still loading (or failed), in which case we do NOT
   * block: the server is the authority on whether an overdraw is happening,
   * and refusing locally on missing data would strand the operator.
   */
  const resulting = current !== null && deltaValid && delta !== null ? current + delta : null;
  const wouldGoNegative = resulting !== null && resulting < 0;

  const canSubmit = !!tech
    && deltaValid
    && noteValid
    && !wouldGoNegative
    && !balanceFetch.loading
    && !submitting;

  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: !!tech || deltaRaw.trim() !== '' || note.trim() !== '',
    // A write in flight closes without a prompt — the dialog is about to
    // unmount and the list to refetch either way.
    when: () => !submitting,
  });

  async function handleSubmit() {
    if (!canSubmit || !tech || delta === null) return;

    /*
     * Confirm DEBITS only. A credit is additive and self-evident from the
     * ledger; taking points away removes something the technician earned, and
     * that deserves one deliberate beat before it happens. Prompting on both
     * would just train the operator to click through.
     */
    if (delta < 0) {
      const ok = await confirm({
        title: 'Deduct Points?',
        description: `${formatEasyfixerName(tech.efr_name)} will lose ${Math.abs(delta).toLocaleString('en-IN')} points`
          + `${resulting !== null ? `, leaving a balance of ${resulting.toLocaleString('en-IN')} points` : ''}.`
          + ' This affects their rewards balance only — it does not touch wages, advances or withdrawals.',
        confirmLabel: 'Deduct Points',
        cancelLabel: 'Keep Editing',
        variant: 'destructive',
      });
      if (!ok) return;
    }

    setSubmitting(true);
    const toastId = showToast({ variant: 'loading', message: 'Adjusting Points…' });
    try {
      const res = await api.post<AdjustResp>('/admin/rewards/ledger/adjust', {
        easyfixer_id: tech.efr_id,
        delta,
        note: trimmedNote,
      });
      dismissToast(toastId);
      showToast({
        variant: 'success',
        // Quote the balance the SERVER returned, not our preview — it is the
        // stored truth, and a concurrent claim could have moved it.
        message: `Points Adjusted · ${formatEasyfixerName(tech.efr_name)} Now Has ${res.balance.toLocaleString('en-IN')} Points`,
      });
      // Parent closes this dialog and refreshes the ledger, so `submitting` is
      // deliberately left true — the component unmounts on the next commit.
      onSaved();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Adjustment failed' });
      /*
       * A 409 means the server's balance is smaller than what we are showing —
       * the technician spent points between our fetch and this submit. Re-read
       * it so the operator sees the real number instead of the stale one that
       * just misled them.
       */
      if (e instanceof ApiError && e.status === 409) {
        invalidateFetch((k) => k.startsWith('/admin/rewards/balance'));
        balanceFetch.refetch();
      }
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust Points</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="block mb-1" required>Technician</Label>
            <TechnicianPicker
              value={tech ? tech.efr_id : ''}
              onPick={setTech}
              placeholder="Search By Name, Code Or City…"
              disabled={submitting}
            />
          </div>

          {/* Current balance — shown the moment a technician is picked, before
              the operator types a number. */}
          {tech && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
              <span className="text-muted-foreground">Current Balance</span>
              {balanceFetch.loading && <span className="text-muted-foreground">Loading…</span>}
              {!balanceFetch.loading && balanceFetch.error && (
                <span className="text-red-600">{balanceFetch.error}</span>
              )}
              {!balanceFetch.loading && !balanceFetch.error && current !== null && (
                <span className="font-semibold tabular-nums">
                  {current.toLocaleString('en-IN')}
                  <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground">pts</span>
                </span>
              )}
            </div>
          )}

          <div>
            <Label htmlFor="adjust-delta" className="block mb-1" required>Points</Label>
            <Input
              id="adjust-delta"
              inputMode="numeric"
              value={deltaRaw}
              onChange={(e) => setDeltaRaw(e.target.value)}
              placeholder="e.g. 250 To Credit, -250 To Debit"
              disabled={submitting}
            />
            {deltaFormatInvalid && (
              <p className="mt-1 text-[11px] text-red-600">Enter a whole number — use a leading minus to deduct.</p>
            )}
            {!deltaFormatInvalid && deltaIsZero && (
              <p className="mt-1 text-[11px] text-red-600">Enter a non-zero number — a zero adjustment changes nothing.</p>
            )}
            {!deltaFormatInvalid && deltaOverBounds && (
              <p className="mt-1 text-[11px] text-red-600">
                Maximum {MAX_ABS_DELTA.toLocaleString('en-IN')} points in a single adjustment.
              </p>
            )}
            {/* Resulting balance — the number the operator is actually
                committing to, stated before they can commit to it. */}
            {resulting !== null && (
              <p className={`mt-1 text-[11px] ${wouldGoNegative ? 'text-red-600' : 'text-muted-foreground'}`}>
                New Balance{' '}
                <span className={wouldGoNegative ? 'font-medium' : 'font-medium text-foreground'}>
                  {resulting.toLocaleString('en-IN')} pts
                </span>
              </p>
            )}
            {wouldGoNegative && (
              <p className="mt-0.5 text-[11px] text-red-600">
                A balance cannot go below zero. Deduct at most {(current ?? 0).toLocaleString('en-IN')} points.
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="adjust-note" className="block mb-1" required>Reason</Label>
            <Input
              id="adjust-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why this adjustment is being made"
              maxLength={NOTE_MAX}
              disabled={submitting}
            />
            {trimmedNote.length > 0 && trimmedNote.length < NOTE_MIN && (
              <p className="mt-1 text-[11px] text-red-600">Give at least {NOTE_MIN} characters.</p>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              This note is the only explanation the ledger will carry for this entry.
            </p>
          </div>

          {/* The boundary, stated where it matters most — at the moment
              someone is typing a number into a balance. */}
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
            <AlertTriangle className="size-3.5 shrink-0 mt-px" />
            <span>
              Points are not money. An adjustment changes the technician&apos;s rewards balance only —
              it never affects wages, advances or withdrawals, and points can only be redeemed for
              rewards shop items.
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              <SlidersHorizontal className="size-4 mr-1" />
              {submitting ? 'Adjusting…' : 'Adjust Points'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
