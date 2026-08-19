'use client';

/*
 * Reward Claims — the fulfilment queue (menu slug `rewardsClaims`, 2026-08-13).
 *
 * Technicians spend earned points on real items; this page is where ops sees
 * what was claimed and walks each parcel to the door. It is a WORKLIST, not a
 * report — every column exists because someone packing a box needs it, and the
 * two write actions ARE the page.
 *
 * The pipeline is linear and one-way:
 *
 *     ORDERED  →  PACKED  →  SENT  →  DELIVERED
 *                                 ↘
 *                                  REJECTED   (an exit, not a step)
 *
 * Backend rules this UI is built around (routes/admin/rewards.js +
 * services/rewards.service.js):
 *   - `reject_reason` is REQUIRED when status is REJECTED (400 otherwise).
 *   - Rejecting REFUNDS the points as a new ledger row and returns the unit to
 *     stock; the response says `refunded: true`. The toast repeats it, because
 *     "did the technician get their points back?" is the very next question.
 *   - A REJECTED claim can never be changed again (409).
 *   - A DELIVERED claim can never be moved back (409).
 * The last two are why Advance is hidden on terminal rows rather than left
 * clickable to fail — the server is the authority, but an operator should not
 * have to discover a dead end by hitting it.
 *
 * ── ONE TRAP WORTH THE COMMENT ───────────────────────────────────────────
 * The PATCH handler writes `tracking_ref` on EVERY call:
 *     tracking_ref = (trackingRef === undefined ? null : …)
 * so a PATCH that merely advances SENT → DELIVERED and omits the field would
 * NULL a tracking reference the technician is actively watching in the app.
 * Every write below therefore round-trips the existing `tracking_ref` back,
 * rather than trusting omission to mean "leave it alone".
 */

import * as React from 'react';
import {
  Package, PackageCheck, Truck, CheckCircle2, Ban, Search, AlertTriangle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { IconButton } from '@/components/ui/icon-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { SearchSelect } from '@/components/ui/search-select';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { api, ApiError } from '@/lib/api';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { formatEasyfixerName } from '@/lib/utils';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { RewardsPausedNotice } from '@/components/rewards/RewardsPausedNotice';

type ClaimStatus = 'ORDERED' | 'PACKED' | 'SENT' | 'DELIVERED' | 'REJECTED';

type Claim = {
  id: number;
  easyfixer_id: number;
  item_id: number;
  /*
   * `item_name` is SNAPSHOTTED onto the claim at claim time, not joined from
   * the catalogue — so a renamed or retired item still reads as what the
   * technician actually ordered.
   */
  item_name: string;
  /* NULL for items with no size axis (a mug, a toolkit) — em-dash, not "null". */
  size: string | null;
  points_spent: number;
  address_line: string | null;
  address_city: string | null;
  address_pincode: string | null;
  address_phone: string | null;
  status: ClaimStatus;
  /* NULL until the parcel is dispatched. This is what the app shows the
     technician, which is why SENT cannot be reached without one. */
  tracking_ref: string | null;
  reject_reason: string | null;
  created_at: string;
  updated_at: string | null;
  /* LEFT JOIN on tbl_easyfixer — a purged technician still lists, with NULLs,
     rather than the claim vanishing from the fulfilment queue. */
  technician_name: string | null;
  technician_mobile: string | null;
};
type ClaimsResp = { rows: Claim[]; total: number; limit: number; offset: number };

/* PATCH response. `refunded` is the server's word on whether points went back —
   we report it rather than inferring it from the status we sent. */
type ClaimPatchResult = { id: number; status: ClaimStatus; refunded: boolean };

/*
 * The forward pipeline, mirroring CLAIM_PIPELINE in rewards.service.js.
 * REJECTED is deliberately absent: it is an exit, so it must never be reachable
 * by the "advance" affordance.
 */
const CLAIM_PIPELINE = ['ORDERED', 'PACKED', 'SENT', 'DELIVERED'] as const;
type PipelineStatus = typeof CLAIM_PIPELINE[number];
/* Every pipeline step except the first is reachable as an advance TARGET. */
type AdvanceTarget = Exclude<PipelineStatus, 'ORDERED'>;

/*
 * Colour progression, not an arbitrary palette: the row visibly warms and then
 * settles as the parcel moves — muted while it is only a request, amber while
 * it is being handled, blue in transit, green on arrival. Rejected breaks the
 * ramp in red because it left the pipeline entirely.
 */
const STATUS_META: Record<ClaimStatus, { label: string; tone: StatusChipTone }> = {
  ORDERED:   { label: 'Ordered',   tone: 'slate' },
  PACKED:    { label: 'Packed',    tone: 'amber' },
  SENT:      { label: 'Sent',      tone: 'sky' },
  DELIVERED: { label: 'Delivered', tone: 'emerald' },
  REJECTED:  { label: 'Rejected',  tone: 'red' },
};

/* The action icon states the DESTINATION, so the row reads as "make this
   packed / send this / mark this delivered" without opening anything. */
const ADVANCE_ICON: Record<AdvanceTarget, LucideIcon> = {
  PACKED: PackageCheck,
  SENT: Truck,
  DELIVERED: CheckCircle2,
};

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All Statuses' },
  ...CLAIM_PIPELINE.map((s) => ({ value: s, label: STATUS_META[s].label })),
  { value: 'REJECTED', label: STATUS_META.REJECTED.label },
];

/*
 * 'All' is deliberately absent. /admin/rewards/claims caps `limit` at 1000 and
 * the claims table only ever grows, so once the programme is past its first
 * thousand parcels an "All" page would silently truncate while its range hint
 * claimed to be showing everything.
 */
const CLAIM_PAGE_SIZES: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/*
 * `created_at` arrives as a raw MySQL DATETIME string ("2026-08-13 10:30:00")
 * because the BE pool runs `dateStrings: true` — it is already an IST
 * wall-clock reading, NOT an instant. `new Date(str)` would re-interpret it in
 * the viewer's timezone and shift every claim time for anyone off IST, so we
 * format the string's own parts and never construct a Date at all.
 */
function formatClaimedOn(raw: string | null | undefined): string {
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
 * Points are a CURRENCY, but not the rupee. Grouped in thousands (not the
 * Indian lakh grouping used for money elsewhere in the CRM) and always shown
 * with a "pts" suffix, so "1,250 pts" can never be misread as ₹1,250 by
 * someone scanning a column of numbers.
 */
function formatPoints(v: number | null | undefined): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '0';
}

/* The next step in the pipeline, or null on a terminal row (DELIVERED — done;
   REJECTED — never in the pipeline to begin with). */
function nextStatus(status: ClaimStatus): AdvanceTarget | null {
  const i = (CLAIM_PIPELINE as readonly string[]).indexOf(status);
  if (i < 0 || i >= CLAIM_PIPELINE.length - 1) return null;
  return CLAIM_PIPELINE[i + 1] as AdvanceTarget;
}

function technicianLabel(c: Claim): string {
  return c.technician_name ? formatEasyfixerName(c.technician_name) : `Technician #${c.easyfixer_id}`;
}

/* Shared em-dash for the several nullable text columns — "—" everywhere, and
   never the string "null" leaking out of a template literal. */
function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

export default function RewardClaimsPage() {
  const { me } = useMe();
  const can = actionFlags(me, ['isRewardsManage']);

  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState<string>('');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  const dq = useDebouncedValue(search, 300);
  const limit = pageSize === 'all' ? 1000 : pageSize;

  /*
   * Row being advanced / rejected. The whole ROW is held (not just an id) so
   * each dialog mounts fresh per claim and its inputs seed from that claim for
   * free, instead of needing a reset effect.
   */
  const [advancing, setAdvancing] = React.useState<Claim | null>(null);
  const [rejecting, setRejecting] = React.useState<Claim | null>(null);

  const qs = new URLSearchParams();
  if (dq.trim()) qs.set('q', dq.trim());
  if (status) qs.set('status', status);
  qs.set('limit', String(limit));
  qs.set('offset', String(page * limit));
  const listFetch = useFetch<ClaimsResp>(`/admin/rewards/claims?${qs.toString()}`);

  /*
   * Any filter change re-queries from row 0. Without this, narrowing the status
   * filter while on page 4 asks for an offset the smaller result set no longer
   * has, and the table renders empty with no visible cause.
   */
  React.useEffect(() => { setPage(0); }, [dq, status]);

  /*
   * Post-write refresh. BOTH halves are required: `invalidateFetch` evicts the
   * module cache but has no subscriber mechanism, so a MOUNTED list would keep
   * rendering the stale row until a full page reload — the explicit `refetch`
   * is what actually repaints it.
   */
  function refreshClaims() {
    invalidateFetch((k) => k.startsWith('/admin/rewards/claims'));
    listFetch.refetch();
  }

  function handleAdvanced() {
    setAdvancing(null);
    refreshClaims();
  }

  function handleRejected() {
    setRejecting(null);
    refreshClaims();
  }

  const rows = listFetch.data?.rows ?? [];
  const total = listFetch.data?.total ?? 0;
  const advanceTarget = advancing ? nextStatus(advancing.status) : null;

  return (
    <div className="space-y-4">
      <RewardsPausedNotice />
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Package className="size-6" /> Reward Claims
        </h1>
        <p className="text-sm text-muted-foreground">
          Track what technicians have redeemed their points for and move each parcel from ordered to delivered.
        </p>
      </div>

      {/* ── Filters ────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by technician, mobile, item, or tracking reference…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              aria-label="Search Claims"
            />
          </div>
          <SearchSelect
            value={status}
            onChange={(v) => setStatus(v)}
            options={STATUS_FILTER_OPTIONS}
            placeholder="All Statuses"
            className="w-52"
          />
        </CardContent>
      </Card>

      {listFetch.error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {listFetch.error}
          </CardContent>
        </Card>
      )}

      {/* ── Claims queue ───────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {/*
                * A JSX comment must NEVER sit on the same LINE as a <col />:
                * the space between them becomes a whitespace text node, which
                * is illegal inside <colgroup> and throws a hydration error at
                * runtime. Comments go on their own line, as here.
                */}
              <col style={{ width: '6%'  }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '6%'  }} />
              <col style={{ width: '8%'  }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '8%'  }} />
              <col style={{ width: '9%'  }} />
              <col style={{ width: '6%'  }} />
            </colgroup>
            <thead>
              <tr>
                <th className="!text-center">Claim</th>
                <th className="!text-left">Technician</th>
                <th className="!text-left">Item</th>
                <th className="!text-center">Size</th>
                <th className="!text-right">Points</th>
                <th className="!text-left">Deliver To</th>
                <th className="!text-left whitespace-nowrap">Claimed On</th>
                <th className="!text-center">Status</th>
                <th className="!text-left">Tracking</th>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {listFetch.loading && (
                <tr><td colSpan={10} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!listFetch.loading && rows.length === 0 && (
                <tr><td colSpan={10} className="!text-center text-muted-foreground py-6">No claims match the current filters.</td></tr>
              )}
              {!listFetch.loading && rows.map((c) => {
                const meta = STATUS_META[c.status] ?? { label: String(c.status), tone: 'slate' as StatusChipTone };
                const next = nextStatus(c.status);
                const AdvanceIcon = next ? ADVANCE_ICON[next] : null;
                const place = [c.address_city, c.address_pincode].filter(Boolean).join(' · ');
                return (
                  <tr key={c.id}>
                    <td className="!text-center font-mono text-xs">#{c.id}</td>
                    <td className="!text-left">
                      <div className="font-medium truncate" title={technicianLabel(c)}>{technicianLabel(c)}</div>
                      {/*
                        * Mobiles arrive pre-masked ("9876••••••") from the admin
                        * masking middleware. Rendered verbatim — any reformatting
                        * here would mangle the bullets.
                        */}
                      <div className="font-mono text-xs text-muted-foreground">
                        {c.technician_mobile || '—'}
                      </div>
                    </td>
                    <td className="!text-left truncate" title={c.item_name}>{c.item_name}</td>
                    <td className="!text-center text-xs">{c.size || <Dash />}</td>
                    {/*
                      * Gold, tabular, right-aligned — a currency column, but
                      * pointedly NOT the rupee columns elsewhere in the CRM.
                      * The "pts" suffix removes the last of the ambiguity.
                      */}
                    <td className="!text-right whitespace-nowrap tabular-nums font-semibold text-warning">
                      {formatPoints(c.points_spent)}
                      <span className="ml-0.5 text-xs font-normal text-warning-strong/70">pts</span>
                    </td>
                    {/* The shipping label, wrapped over its own lines — this is
                        the cell someone reads while writing on a box. */}
                    <td className="!text-left text-xs leading-snug">
                      {(c.address_line || place || c.address_phone)
                        ? (
                          <>
                            {c.address_line && <div className="break-words">{c.address_line}</div>}
                            {place && <div className="text-muted-foreground">{place}</div>}
                            {c.address_phone && (
                              <div className="font-mono text-xs text-muted-foreground">{c.address_phone}</div>
                            )}
                          </>
                        )
                        : <Dash />}
                    </td>
                    <td className="!text-left whitespace-nowrap text-xs">{formatClaimedOn(c.created_at)}</td>
                    <td className="!text-center whitespace-nowrap">
                      <StatusChip tone={meta.tone} size="sm">{meta.label}</StatusChip>
                      {/* The reason IS the record for a rejection — kept on the
                          row (as a tooltip on long text) rather than buried in
                          a detail view nobody opens. */}
                      {c.status === 'REJECTED' && c.reject_reason && (
                        <span
                          className="block text-xs text-muted-foreground mt-0.5 truncate"
                          title={c.reject_reason}
                        >
                          {c.reject_reason}
                        </span>
                      )}
                    </td>
                    <td className="!text-left font-mono text-xs break-words">
                      {c.tracking_ref || <Dash />}
                    </td>
                    <td className="!text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1">
                        {can.isRewardsManage
                          ? (
                            <>
                              {/*
                                * Hidden, not disabled, on terminal rows: the
                                * server answers 409 for both "already rejected"
                                * and "delivered cannot move back", and there is
                                * no future in which the button becomes usable
                                * again. A permanently-dead control is noise.
                                */}
                              {next && AdvanceIcon && (
                                <IconButton
                                  icon={AdvanceIcon}
                                  label={`Mark As ${STATUS_META[next].label}`}
                                  intent="primary"
                                  onClick={() => setAdvancing(c)}
                                />
                              )}
                              {c.status !== 'REJECTED' && c.status !== 'DELIVERED' && (
                                <IconButton
                                  icon={Ban}
                                  label="Reject Claim"
                                  intent="danger"
                                  onClick={() => setRejecting(c)}
                                />
                              )}
                              {!next && c.status === 'DELIVERED' && (
                                <span className="text-xs text-muted-foreground">done</span>
                              )}
                              {c.status === 'REJECTED' && (
                                <span className="text-xs text-muted-foreground">closed</span>
                              )}
                            </>
                          )
                          : <span className="text-xs text-muted-foreground">view-only</span>}
                      </div>
                    </td>
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
        pageSizeOptions={CLAIM_PAGE_SIZES}
      />

      {/* Both dialogs re-check the permission as well as their triggers. The
          state is only reachable from a gated button today, but a dialog that
          can write is worth gating at the dialog. */}
      {advancing && advanceTarget && can.isRewardsManage && (
        <AdvanceClaimDialog
          claim={advancing}
          target={advanceTarget}
          onClose={() => setAdvancing(null)}
          onSaved={handleAdvanced}
        />
      )}

      {rejecting && can.isRewardsManage && (
        <RejectClaimDialog
          claim={rejecting}
          onClose={() => setRejecting(null)}
          onSaved={handleRejected}
        />
      )}
    </div>
  );
}

/*
 * Advance — move one claim to the NEXT pipeline status.
 *
 * A dialog rather than a bare click because of SENT: the tracking reference is
 * what the technician watches in the app, and a parcel marked sent without one
 * turns "where is my hoodie?" into a support ticket nobody can answer. So the
 * field is REQUIRED on the SENT hop and the button stays disabled until it is
 * filled.
 *
 * The field is also shown (optional, pre-filled) on any row that already has a
 * reference, for two reasons: a typo'd courier number can be corrected on the
 * way to DELIVERED, and — see the file header — the PATCH handler rewrites
 * `tracking_ref` on every call, so the value must be sent back or it is wiped.
 */
function AdvanceClaimDialog({
  claim,
  target,
  onClose,
  onSaved,
}: {
  claim: Claim;
  target: AdvanceTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialTracking = claim.tracking_ref ?? '';
  const [tracking, setTracking] = React.useState(initialTracking);
  const [submitting, setSubmitting] = React.useState(false);

  const trackingRequired = target === 'SENT';
  const trackingShown = trackingRequired || !!claim.tracking_ref;
  const trackingMissing = trackingRequired && tracking.trim() === '';
  const canSubmit = !trackingMissing && !submitting;

  /*
   * Dirty = the operator actually typed something into the tracking field. A
   * real check rather than a blanket `true`: prompting "Discard changes?" on an
   * untouched dialog trains people to dismiss the prompt without reading it,
   * which is exactly when it stops protecting anything.
   */
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: tracking !== initialTracking,
    // A write in flight closes without a prompt — the row is about to be
    // refetched and the dialog unmounted either way.
    when: () => !submitting,
  });

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    const toastId = showToast({ variant: 'loading', message: 'Updating Claim…' });
    try {
      const res = await api.patch<ClaimPatchResult>(`/admin/rewards/claims/${claim.id}`, {
        status: target,
        // Always sent, never omitted — omission NULLs the column server-side.
        tracking_ref: tracking.trim() || null,
      });
      dismissToast(toastId);
      showToast({
        variant: 'success',
        message: `Claim #${claim.id} Marked As ${STATUS_META[res.status]?.label ?? STATUS_META[target].label}`
          + (target === 'SENT' && tracking.trim() ? ` · Tracking ${tracking.trim()}` : ''),
      });
      // Parent closes this dialog and refreshes the list, so `submitting` is
      // deliberately left true — the component unmounts on the next commit.
      onSaved();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Update failed' });
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark As {STATUS_META[target].label}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-sm">
            <div className="font-medium">{claim.item_name}{claim.size ? ` · Size ${claim.size}` : ''}</div>
            <div className="text-muted-foreground">
              {technicianLabel(claim)} · Claim #{claim.id}
            </div>
          </div>

          {/* The transition, stated plainly — the operator confirms a move, not
              just a status value. */}
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
            <StatusChip tone={STATUS_META[claim.status].tone} size="sm">
              {STATUS_META[claim.status].label}
            </StatusChip>
            <span className="text-muted-foreground">→</span>
            <StatusChip tone={STATUS_META[target].tone} size="sm">
              {STATUS_META[target].label}
            </StatusChip>
          </div>

          {trackingShown && (
            <div>
              <Label className="block mb-1" htmlFor="claim-tracking" required={trackingRequired}>
                Tracking Reference
              </Label>
              <Input
                id="claim-tracking"
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
                placeholder="Courier AWB or tracking number"
                maxLength={120}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {trackingRequired
                  ? 'The technician sees this in the app to follow the parcel, so a dispatched claim needs one.'
                  : 'Already dispatched — correct the reference here if the courier issued a new one.'}
              </p>
              {trackingMissing && (
                <p className="mt-1 text-xs text-urgent">
                  Enter the tracking reference before marking this claim as sent.
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {submitting ? 'Updating…' : `Mark As ${STATUS_META[target].label}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Reject — the exit from the pipeline, and the only action on this page that
 * moves money.
 *
 * Two gates, and both earn their place:
 *   1. A REASON, required by the API (400 without it) and collected here so the
 *      operator writes it before the round-trip rather than after a red toast.
 *      It is also the only explanation the technician ever gets for a claim
 *      that vanished, so it is written as if they will read it — because they
 *      will.
 *   2. A CONFIRM, because rejecting refunds the points as a new ledger row and
 *      puts the unit back on the shelf. Both are correct and neither is
 *      undoable — a rejected claim is frozen (409 on any further change), so
 *      there is no "reject and then fix it".
 */
function RejectClaimDialog({
  claim,
  onClose,
  onSaved,
}: {
  claim: Claim;
  onClose: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const canSubmit = reason.trim() !== '' && !submitting;

  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: reason.trim() !== '',
    when: () => !submitting,
  });

  async function handleSubmit() {
    if (!canSubmit) return;
    const ok = await confirm({
      title: 'Reject This Claim?',
      description: `${technicianLabel(claim)} will not receive "${claim.item_name}". Rejecting refunds ${formatPoints(claim.points_spent)} points to their balance as a new ledger entry and returns the unit to stock. A rejected claim is final — it cannot be reopened or moved along afterwards.`,
      confirmLabel: 'Reject And Refund',
      variant: 'destructive',
    });
    if (!ok) return;

    setSubmitting(true);
    const toastId = showToast({ variant: 'loading', message: 'Rejecting Claim…' });
    try {
      const res = await api.patch<ClaimPatchResult>(`/admin/rewards/claims/${claim.id}`, {
        status: 'REJECTED',
        reject_reason: reason.trim(),
        // Round-tripped so a reference already on the row is not silently
        // nulled by the handler's unconditional write of this column.
        tracking_ref: claim.tracking_ref ?? null,
      });
      dismissToast(toastId);
      showToast({
        variant: 'success',
        /*
         * Quote the SERVER's `refunded` flag rather than assuming it. Whether
         * the points came back is the single thing ops needs confirmed here —
         * a bare "Claim Rejected" leaves them to guess, and guessing wrong
         * means a technician chasing a balance nobody checked.
         */
        message: res.refunded
          ? `Claim #${claim.id} Rejected · ${formatPoints(claim.points_spent)} Points Refunded · Item Returned To Stock`
          : `Claim #${claim.id} Rejected`,
      });
      onSaved();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Reject failed' });
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject Claim</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-sm">
            <div className="font-medium">{claim.item_name}{claim.size ? ` · Size ${claim.size}` : ''}</div>
            <div className="text-muted-foreground">
              {technicianLabel(claim)} · Claim #{claim.id}
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-tint p-2 text-xs text-warning-strong">
            <AlertTriangle className="size-4 shrink-0 mt-px" />
            <span>
              Rejecting refunds{' '}
              <strong>{formatPoints(claim.points_spent)} points</strong>{' '}
              to {technicianLabel(claim)} and returns the item to stock. This cannot be undone.
            </span>
          </div>

          <div>
            <Label className="block mb-1" htmlFor="claim-reject-reason" required>Reason</Label>
            <textarea
              id="claim-reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this claim cannot be fulfilled — the technician sees this"
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
              maxLength={255}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Required. This is the only explanation the technician gets, so write it for them.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button variant="destructive" onClick={handleSubmit} disabled={!canSubmit}>
              <Ban className="size-4 mr-1" />
              {submitting ? 'Rejecting…' : 'Reject Claim'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
