'use client';

import { useEffect, useState } from 'react';
import { Repeat } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { BULK_TRANSFER_MAX_JOBS as MAX_JOB_IDS } from '@/lib/utils';

/*
 * TransferJobOwnershipDialog — admin-only bulk-transfer of job_owner.
 *
 * Mirrors the legacy CRM "Transfer Job Ownership" flow:
 *   - Operator picks a FROM owner + TO owner.
 *   - Two scope modes:
 *       (a) "Apply to all jobs matching current filters" — calls the
 *           BE with `{ fromOwnerId, toOwnerId, filters }` and the
 *           backend reuses service.list() with the same RBAC scope
 *           the list endpoint uses (up to a 1000-row safety ceiling).
 *       (b) "Selected Jobs" — the rows the operator ticked on the
 *           Manage Jobs table, sent as `jobIds` (BE cap: 500).
 *   - Reason is mandatory (audit trail on every per-row changeOwner
 *     call).
 *
 * THE FREE-TEXT JOB-IDS BOX IS GONE (replaced 2026-08-20 by the table
 * checkboxes). It let an operator type ids for jobs they were not
 * looking at, so a transposed digit silently targeted a real,
 * unrelated job — and because the source-owner filter usually matched,
 * the BE happily transferred it. Nothing in it survives that the
 * checkbox flow does not do better: the ids now come from rows the
 * operator can see, terminal jobs are un-tickable at source, and the
 * confirmed set is echoed back below before submit. An operator working
 * from an external list narrows with the page's search/filter card and
 * ticks, which is one step longer and verifiable.
 *
 * TERMINAL JOBS: the table refuses to tick them and the BE refuses to
 * transfer them (NON_TRANSFERABLE_JOB_STATUSES in routes/admin/jobs.js).
 * Filters mode can still resolve terminal rows server-side; those come
 * back in the results table as "skipped" with the reason, which is why
 * the report view below renders reasons verbatim.
 *
 * The dialog shows a per-row results table on success — "transferred"
 * / "failed" / "skipped" with the BE's reason for each non-success.
 *
 * Gating:
 *   - The button that opens this dialog is gated to
 *     `isTransferJobOwnership` upstream.
 *   - BE re-enforces via `roleByName(['Admin'])` — defense in depth.
 */

type ResultRow = {
  jobId: number;
  status: 'transferred' | 'failed' | 'skipped';
  reason?: string;
  error?: string;
};

type Report = {
  summary: { total: number; transferred: number; failed: number; skipped: number };
  results: ResultRow[];
};

export function TransferJobOwnershipDialog({
  open,
  onClose,
  /*
   * Snapshot of the parent's current filter state — sent verbatim to
   * the BE when the operator picks "Apply to filtered jobs". The keys
   * mirror /admin/jobs's listQuery validator. Parent passes it on
   * every render; we copy on submit so changes after open don't shift
   * the target set under the operator's feet.
   */
  currentFilters,
  /*
   * Pre-locked source owner. When the dialog is opened from the
   * Manage Jobs filter card, the parent gates the open on the
   * Job Owner filter being set and passes that id through — From
   * Owner is then read-only inside the dialog. This eliminates the
   * common ops mistake of "I filtered the list but then picked a
   * different source owner in the dialog and wondered why nothing
   * transferred". Always == currentFilters.ownerId when set.
   */
  lockedFromOwnerId,
  /*
   * Job IDs the operator ticked on the Manage Jobs table. Already
   * filtered to non-terminal rows and capped at MAX_JOB_IDS by the
   * table's own selection logic — this dialog re-checks both anyway,
   * because a dialog that trusts its caller's invariants is one
   * refactor away from sending a 700-id request.
   */
  selectedJobIds = [],
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  currentFilters: Record<string, string | number | undefined>;
  lockedFromOwnerId?: number | string | null;
  selectedJobIds?: number[];
  onApplied?: () => void;
}) {
  const lk = useLookup();
  const [fromOwner, setFromOwner] = useState<string>('');
  const [toOwner,   setToOwner]   = useState<string>('');
  const [reason,    setReason]    = useState<string>('');
  const [mode,      setMode]      = useState<'filters' | 'selected'>('filters');
  const [submitting, setSubmitting] = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [report,   setReport]   = useState<Report | null>(null);

  const selectedCount = selectedJobIds.length;

  // Reset everything when the dialog reopens — operators expect a
  // fresh form, not stale state from the previous transfer.
  // `fromOwner` is rehydrated from `lockedFromOwnerId` when present
  // so the locked-source flow doesn't require the operator to
  // re-pick the source they already chose upstream.
  //
  // The mode DEFAULTS to whichever one the operator's actions already
  // implied: they ticked rows, so start on Selected Jobs; they ticked
  // nothing, so start on the filter set. Defaulting to 'filters' with a
  // live selection was the sharp edge — the operator sees "12 Selected"
  // on the button and transfers 900 filtered rows instead.
  useEffect(() => {
    if (open) {
      setFromOwner(lockedFromOwnerId != null ? String(lockedFromOwnerId) : '');
      setToOwner(''); setReason('');
      setMode(selectedCount > 0 ? 'selected' : 'filters');
      setError(null); setReport(null); setSubmitting(false);
    }
    // ⚠ DEPS ARE [open] ALONE, DELIBERATELY. This effect seeds the form when
    // the dialog opens; it must not re-run while it is already open.
    //
    // With selectedCount in the deps it did: a successful transfer calls
    // onApplied(), the page clears the ticked rows, selectedCount drops N→0,
    // this effect re-fired and setReport(null) DESTROYED the result table the
    // operator was meant to read. The transfer had worked, but the dialog
    // snapped back to a blank form — indistinguishable from nothing happening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    setError(null);
    if (!fromOwner || !toOwner) { setError('Pick both From and To owners.'); return; }
    if (fromOwner === toOwner)  { setError('From and To owners must be different.'); return; }
    if (!reason.trim() || reason.trim().length < 2) { setError('Reason is required (min 2 characters).'); return; }

    const body: Record<string, unknown> = {
      fromOwnerId: Number(fromOwner),
      toOwnerId:   Number(toOwner),
      reason:      reason.trim(),
    };
    if (mode === 'selected') {
      // De-dupe + re-validate rather than forwarding the prop blind: the BE's
      // Joi schema rejects the ENTIRE request on a bad id or an over-cap array,
      // so a single stray value would cost the operator all of their selection.
      const ids = Array.from(new Set(
        selectedJobIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
      ));
      if (ids.length === 0) { setError('Select at least one job on the Manage Jobs table.'); return; }
      if (ids.length > MAX_JOB_IDS) {
        setError(`Too many jobs selected (${ids.length}). Max ${MAX_JOB_IDS} per transfer.`);
        return;
      }
      body.jobIds = ids;
    } else {
      // Filters mode — strip undefined and trivially-empty values.
      const clean: Record<string, unknown> = {};
      Object.entries(currentFilters).forEach(([k, v]) => {
        if (v !== undefined && v !== '' && v !== null) clean[k] = v;
      });
      body.filters = clean;
    }

    setSubmitting(true);
    try {
      const r = await api.post<Report>('/admin/jobs/bulk-owner-transfer', body);
      setReport(r);
      if (r.summary.transferred > 0) onApplied?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Bulk transfer failed.');
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()} modal={false}>
      <DialogContent className="!max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat className="h-4 w-4 text-info-tint" /> Transfer Job Ownership
          </DialogTitle>
        </DialogHeader>

        {!report && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="!mb-1">
                  From Owner *
                  {lockedFromOwnerId != null && (
                    <span className="ml-1 text-xs text-muted-foreground font-normal">(locked — from filter)</span>
                  )}
                </Label>
                <SearchSelect
                  placeholder="Search & select source owner"
                  value={fromOwner}
                  onChange={setFromOwner}
                  options={lk.toOpts.adminUsers.map((u) => ({ value: String(u.value), label: String(u.label) }))}
                  disabled={lockedFromOwnerId != null}
                />
              </div>
              <div>
                <Label className="!mb-1">To Owner *</Label>
                <SearchSelect
                  placeholder="Search & select destination owner"
                  value={toOwner}
                  onChange={setToOwner}
                  options={lk.toOpts.adminUsers.map((u) => ({ value: String(u.value), label: String(u.label) }))}
                />
              </div>
            </div>

            <div>
              <Label className="!mb-1">Reason *</Label>
              <Input
                placeholder="Why is this transfer happening? (audit trail)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
              />
            </div>

            {/* Mode picker — radio with two options. Which one starts
                selected is decided by the operator's own actions (see
                the reset effect), not by a fixed default. */}
            <div className="border rounded-md p-3 space-y-2">
              <Label className="!mb-1">Apply To</Label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={mode === 'filters'}
                  onChange={() => setMode('filters')}
                />
                <span>All Jobs Matching Current Filters (up to 1,000 rows; pinned to From Owner)</span>
              </label>
              <label className={`flex items-center gap-2 text-sm ${selectedCount === 0 ? 'opacity-50' : ''}`}>
                <input
                  type="radio"
                  checked={mode === 'selected'}
                  onChange={() => setMode('selected')}
                  // Un-pickable with nothing ticked — choosing it would
                  // guarantee a validation error the operator can't fix
                  // from inside the dialog.
                  disabled={selectedCount === 0}
                />
                <span>
                  Selected Jobs ({selectedCount})
                  {selectedCount === 0 && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      — tick rows on the Manage Jobs table first
                    </span>
                  )}
                </span>
              </label>

              {/*
                * Echo the exact ids back before submit. This is the whole
                * point of moving off the typed box: the operator confirms
                * the set they are about to mutate, in the same dialog,
                * instead of finding out from the results table.
                */}
              {mode === 'selected' && selectedCount > 0 && (
                <div className="mt-1 max-h-24 overflow-y-auto rounded-md border border-input bg-muted/40 px-3 py-2 text-xs font-mono leading-5">
                  {selectedJobIds.map((id) => `#${id}`).join(', ')}
                </div>
              )}
              {mode === 'filters' && (
                <div className="mt-1 rounded-md border border-warning/30 bg-warning-tint px-3 py-2 text-xs text-warning-strong">
                  Completed, cancelled and enquiry jobs in the filter set are
                  refused by the server and will appear below as Skipped.
                </div>
              )}
            </div>

            {error && <div className="text-sm text-destructive">{error}</div>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
              <Button type="button" onClick={submit} disabled={submitting}>
                {submitting ? 'Transferring…' : 'Transfer Ownership'}
              </Button>
            </div>
          </div>
        )}

        {report && (
          <div className="space-y-3">
            <div className="text-sm font-medium">
              <span className="text-success-strong">{report.summary.transferred} Transferred</span>
              {' · '}
              <span className="text-urgent-strong">{report.summary.failed} Failed</span>
              {' · '}
              <span className="text-muted-foreground">{report.summary.skipped} Skipped</span>
              {' · '}
              <span>{report.summary.total} Total</span>
            </div>
            <div className="max-h-[40vh] overflow-y-auto border rounded-md">
              <table className="data-table">
                <thead><tr><th>Job ID</th><th>Status</th><th>Details</th></tr></thead>
                <tbody>
                  {report.results.map((r) => (
                    <tr key={r.jobId}>
                      <td className="font-mono">{r.jobId}</td>
                      <td>
                        <span className={
                          r.status === 'transferred' ? 'text-success-strong' :
                          r.status === 'failed'      ? 'text-urgent-strong' :
                                                       'text-muted-foreground'
                        }>
                          {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                        </span>
                      </td>
                      <td className="text-xs">{r.error || r.reason || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" onClick={onClose}>Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
