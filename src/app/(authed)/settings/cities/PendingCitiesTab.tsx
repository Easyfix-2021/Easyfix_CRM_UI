'use client';

/*
 * Manage Cities › Pending Approval tab.
 *
 * WHY THIS EXISTS. Six backend paths create a tbl_city row automatically and
 * three of them need no login at all (public website booking, the technician
 * magic-link profile form, AI transcript extraction). Since 2026-09-09 those
 * paths insert the city PENDING (city_status = 2) instead of live, and
 * lib/city-status.js keeps a pending city out of every selection surface —
 * `/shared/lookup/cities` filters `city_status = 1`. Without this queue the
 * row is unreachable and the city is simply invisible.
 *
 * Wire contract (routes/admin/cities.js + services/city.service.js):
 *   GET  /admin/cities/pending?limit&offset  → { items, total }
 *   POST /admin/cities/:id/approve           → 2 → 1 (409 if already decided)
 *   POST /admin/cities/:id/reject { replacement_city_id } → MERGE, then 2 → 0
 *
 * REJECTION IS A MERGE, NOT A DELETE. By the time a city reaches this queue
 * rows already point at it — that is why it exists. The reject dialog below
 * therefore leads with the merge, makes the replacement mandatory, and hands
 * back the per-table `moved` breakdown as a receipt.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, GitMerge, Inbox, XCircle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { IconButton } from '@/components/ui/icon-button';
import { Label } from '@/components/ui/label';
import { CitySelect } from '@/components/ui/city-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { api, ApiError } from '@/lib/api';

/*
 * The queue row. `created_by_name` resolves to the technician (tbl_easyfixer)
 * or CRM user (tbl_user) who triggered the creation and is NULL where the
 * audit columns are absent or the row predates them — rendered as an em dash,
 * never as an invented "System".
 *
 * `pincode_count` here is UNFILTERED (every tbl_pincode row pointing at the
 * city), unlike the main list's serviceable-only count — the question in this
 * tab is "how much has already accreted onto this city".
 */
export type PendingCity = {
  city_id: number;
  city_name: string;
  state_id: number | null;
  state_name: string | null;
  district: string | null;
  tier: string | null;
  reference_pincode: string | null;
  city_status: number;
  created_by: number | null;
  created_by_type: 'technician' | 'user' | null;
  created_by_name: string | null;
  created_date: string | null;
  pincode_count: number;
};

export type PendingListResponse = { items: PendingCity[]; total: number };

/* POST /reject's success payload. `moved` is keyed `table.column`. */
type RejectResult = {
  city_id: number;
  merged_into_city_id: number;
  rows_moved: number;
  moved: Record<string, number>;
  audit_recorded: boolean;
};

/*
 * created_date is a DATETIME the backend already stores in IST wall-clock
 * (see the DATETIME-IST-storage convention). Sliced as a STRING, never parsed
 * into a Date — parsing and re-rendering would shift it by the browser's
 * offset. Same treatment as the Created By cell on the main list.
 */
function istStamp(v: string | null): string {
  return v ? String(v).replace('T', ' ').slice(0, 16) : '';
}

export function PendingCitiesTab({
  items, total, loading, error,
  page, pageSize, onPageChange, onPageSizeChange,
  onDecided,
}: {
  items: PendingCity[];
  total: number;
  loading: boolean;
  error: string | null;
  page: number;
  pageSize: TablePageSize;
  onPageChange: (next: number) => void;
  onPageSizeChange: (next: TablePageSize) => void;
  /* Refreshes BOTH lists — the queue AND the All Cities tab behind it. */
  onDecided: () => void;
}) {
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<number | null>(null);
  /*
   * Held as a COPY, not looked up out of `items`. onDecided() refreshes the
   * list underneath the open dialog, and a row read back from `items` would
   * vanish mid-merge and unmount the result panel with it.
   */
  const [rejecting, setRejecting] = useState<PendingCity | null>(null);

  async function handleApprove(c: PendingCity) {
    const ok = await confirm({
      title: 'Approve City?',
      description: (
        <>
          <span className="font-medium text-foreground">{c.city_name}</span>
          {c.state_name ? `, ${c.state_name}` : ''} becomes an Active city and starts
          appearing in every city picker across the CRM.
          {c.pincode_count > 0
            ? ` ${c.pincode_count} pincode(s) already point at it.`
            : ' No pincodes point at it yet.'}
        </>
      ),
      confirmLabel: 'Approve City',
      icon: <CheckCircle2 className="size-5" />,
      iconAccent: 'emerald',
    });
    if (!ok) return;
    setBusyId(c.city_id);
    try {
      await api.post(`/admin/cities/${c.city_id}/approve`);
      showToast({ variant: 'success', message: `${c.city_name} approved` });
      onDecided();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      /*
       * 409 = someone else already approved or rejected it while this page
       * was open; 404 = the row is gone. Neither is this operator's mistake,
       * so it is a warning rather than an error — and both mean the queue on
       * screen is stale, so refresh it either way.
       */
      const stale = err != null && (err.status === 409 || err.status === 404);
      showToast({
        variant: stale ? 'warning' : 'error',
        message: err?.message ?? 'Approve failed',
      });
      if (stale) onDecided();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-3 text-sm text-muted-foreground flex items-start gap-2">
          <Inbox className="size-4 shrink-0 mt-0.5 text-info" />
          <p>
            Cities created automatically — by a website booking, a technician&rsquo;s
            profile form, a pincode add, or transcript extraction. A pending city is
            invisible to every city picker in the CRM until it is approved.{' '}
            <span className="font-medium text-foreground">Approve</span> makes it
            selectable;{' '}
            <span className="font-medium text-foreground">Reject</span> merges everything
            attached to it into a city you choose, then retires it.
          </p>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {/*
            * Auto layout (no <colgroup>), matching Manage Zones. The main
            * Cities table needs `table-fixed` + measured percentages because
            * sorting reshuffles which content is widest on the visible page;
            * this queue has no sort, so there is nothing to stabilise and no
            * measured width plan to invent.
            *
            * Alignment classes carry `!` and appear on BOTH the th and the td:
            * `.data-table th` bakes in `text-left`, so a td-only class leaves
            * the header misaligned above its own column.
            */}
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-center">City ID</th>
                <th className="!text-left">City Name</th>
                <th className="!text-left">State</th>
                <th className="!text-left">District</th>
                <th className="!text-center">Reference Pincode</th>
                <th className="!text-center">Pincodes Attached</th>
                <th className="!text-left">Created By</th>
                <th className="!text-left">Created On</th>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">No cities are awaiting approval.</td></tr>
              )}
              {!loading && items.map((c) => (
                <tr key={c.city_id}>
                  <td className="!text-center font-mono text-xs">{c.city_id}</td>
                  <td className="!text-left font-medium">{c.city_name}</td>
                  <td className="!text-left">{c.state_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left">{c.district ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-center font-mono text-xs">
                    {c.reference_pincode ?? <span className="text-muted-foreground font-sans">—</span>}
                  </td>
                  <td className="!text-center">{c.pincode_count}</td>
                  {/*
                    * Same shape as the All Cities tab: a Tech/CRM badge plus the
                    * resolved name. When the audit columns are absent (or the row
                    * predates them) `created_by_type` is null and the cell is an
                    * em dash — the queue never invents an author.
                    */}
                  <td className="!text-left whitespace-nowrap">
                    {c.created_by_type ? (
                      <span className="inline-flex items-center gap-1">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${c.created_by_type === 'technician' ? 'bg-warning-tint text-warning-strong' : 'bg-ink-100 text-ink-700'}`}>
                          {c.created_by_type === 'technician' ? 'Tech' : 'CRM'}
                        </span>
                        {c.created_by_name || <span className="text-muted-foreground">#{c.created_by}</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="!text-left whitespace-nowrap font-mono text-xs">
                    {istStamp(c.created_date) || <span className="text-muted-foreground font-sans">—</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-0.5">
                      <IconButton
                        icon={CheckCircle2}
                        label="Approve City"
                        intent="success"
                        busy={busyId === c.city_id}
                        onClick={() => handleApprove(c)}
                      />
                      <IconButton
                        icon={XCircle}
                        label="Reject City"
                        intent="danger"
                        disabled={busyId === c.city_id}
                        onClick={() => setRejecting(c)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-3 py-2 border-t">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              loading={loading}
              onPageChange={onPageChange}
              onPageSizeChange={onPageSizeChange}
            />
          </div>
        </CardContent>
      </Card>

      <RejectCityDialog
        city={rejecting}
        onClose={() => setRejecting(null)}
        onMerged={onDecided}
      />
    </div>
  );
}

// ─── Reject = merge ──────────────────────────────────────────────────
/*
 * Two states in one dialog:
 *
 *   BEFORE — what the merge will do, the scope we actually know
 *            (`pincode_count` from the queue), and the mandatory replacement
 *            picker. Confirm stays disabled until a replacement is chosen.
 *   AFTER  — the receipt: total rows moved plus the per-table breakdown the
 *            endpoint returns, and whether the decision was audit-stamped.
 *
 * The scope line is deliberately partial. The queue payload carries a pincode
 * count and nothing else; addresses / technicians / clients / zone mappings are
 * only counted by the merge itself. Showing an invented total would be worse
 * than showing what we have and saying what we do not.
 */
function RejectCityDialog({
  city, onClose, onMerged,
}: {
  city: PendingCity | null;
  onClose: () => void;
  onMerged: () => void;
}) {
  const [replacementId, setReplacementId] = useState('');
  const [replacementName, setReplacementName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RejectResult | null>(null);

  useEffect(() => {
    if (!city) return;
    setReplacementId('');
    setReplacementName('');
    setSubmitting(false);
    setError(null);
    setResult(null);
  }, [city]);

  /*
   * Shared discard guard rather than an inline `onOpenChange` arrow — the
   * repo's own eslint `no-restricted-syntax` rule bans the arrow because it
   * silently bypasses this prompt. Dirty = a replacement is picked but the
   * merge has not run; once `result` exists there is nothing left to discard.
   */
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: () => !!replacementId && !result,
    when: () => !submitting,
  });

  // Biggest blast radius first — the number an operator needs to see is the
  // one at the top, not wherever MERGE_TARGETS happens to list it.
  const movedRows = useMemo(
    () => Object.entries(result?.moved ?? {}).sort((a, b) => b[1] - a[1]),
    [result],
  );

  async function handleReject() {
    if (!city || !replacementId) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post<RejectResult>(`/admin/cities/${city.city_id}/reject`, {
        replacement_city_id: Number(replacementId),
      });
      setResult(res);
      showToast({
        variant: 'success',
        message: `${city.city_name} merged into ${replacementName || `city #${res.merged_into_city_id}`}`
          + ` · ${res.rows_moved} row(s) moved`,
      });
      // Refresh both lists now; the receipt below stays on screen.
      onMerged();
    } catch (e) {
      /*
       * Every failure path in rejectCity() rolls the transaction back, so
       * "nothing was changed" is a statement of fact, not reassurance. The
       * server message is shown verbatim — on a 409 it names the table whose
       * city column could not be verified, which is the whole finding.
       */
      setError(e instanceof ApiError ? e.message : 'Reject failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (!city) return null;

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject &ldquo;{city.city_name}&rdquo;</DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <div className="rounded border border-success/40 bg-success-tint p-3 text-sm text-success-strong">
              <p className="font-semibold flex items-center gap-2">
                <CheckCircle2 className="size-4" /> Merge Complete
              </p>
              <p className="mt-1">
                {result.rows_moved} row(s) moved from city #{result.city_id} into city
                #{result.merged_into_city_id}
                {replacementName ? ` (${replacementName})` : ''}.
                {' '}City #{result.city_id} is now retired.
              </p>
            </div>

            <div>
              <p className="text-sm font-medium mb-1">Rows Moved, By Table</p>
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <th className="!text-left">Table &middot; Column</th>
                    <th className="!text-right">Rows Moved</th>
                  </tr>
                </thead>
                <tbody>
                  {movedRows.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="!text-center text-muted-foreground py-4">
                        No rows referenced this city.
                      </td>
                    </tr>
                  ) : movedRows.map(([key, n]) => (
                    <tr key={key}>
                      <td className="!text-left font-mono text-xs">{key}</td>
                      <td className="!text-right">{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!result.audit_recorded && (
              <p className="text-xs text-muted-foreground">
                The approval audit columns are not present on this database, so the
                decision was not stamped onto the city row. The merge itself completed.
              </p>
            )}

            <div className="flex justify-end pt-2">
              <Button onClick={onClose}>Close</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded border border-warning/40 bg-warning-tint p-3 text-sm text-warning-strong flex gap-2">
              <GitMerge className="size-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Rejecting Merges. It Does Not Delete.</p>
                <p className="mt-1">
                  Every address, pincode, technician, client and zone mapping pointing at
                  this city is repointed onto the replacement in one transaction, and
                  &ldquo;{city.city_name}&rdquo; is then retired. This cannot be undone
                  from the CRM.
                </p>
              </div>
            </div>

            <div className="rounded border p-3 text-sm space-y-1">
              <p>
                <span className="text-muted-foreground">Rejecting:</span>{' '}
                <span className="font-medium">{city.city_name}</span>
                {city.state_name ? `, ${city.state_name}` : ''}
                {' '}<span className="font-mono text-xs text-muted-foreground">#{city.city_id}</span>
              </p>
              <p>
                <span className="text-muted-foreground">Known scope:</span>{' '}
                <span className="font-medium">{city.pincode_count}</span> pincode(s)
                already attach to this city.
              </p>
              <p className="text-xs text-muted-foreground">
                Address, technician, client and zone-mapping rows are repointed too. The
                queue does not carry those counts — the exact per-table figures are
                reported here the moment the merge runs.
              </p>
            </div>

            <div>
              <Label className="block mb-1" required>Merge Into City</Label>
              <CitySelect
                value={replacementId}
                onChange={(id, name) => { setReplacementId(id); setReplacementName(name); }}
                placeholder="— Select the city to keep —"
                disabled={submitting}
                required
              />
              <p className="text-xs text-muted-foreground mt-1">
                Only Active cities are searchable, so a pending city — including this one
                — can never be picked as its own replacement.
              </p>
            </div>

            {error && (
              <div className="text-sm text-urgent flex items-start gap-1">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <span>{error} Nothing was changed.</span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <CancelButton onCancel={onClose} disabled={submitting} />
              <Button
                variant="destructive"
                onClick={handleReject}
                disabled={!replacementId || submitting}
              >
                {submitting
                  ? 'Merging…'
                  : replacementName
                    ? `Reject & Merge Into ${replacementName}`
                    : 'Reject & Merge'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
