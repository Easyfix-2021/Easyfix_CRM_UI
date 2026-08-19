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
 *       (b) "Apply to specific Job IDs" — operator pastes comma-or
 *           newline-separated IDs, max 500.
 *   - Reason is mandatory (audit trail on every per-row changeOwner
 *     call).
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
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  currentFilters: Record<string, string | number | undefined>;
  lockedFromOwnerId?: number | string | null;
  onApplied?: () => void;
}) {
  const lk = useLookup();
  const [fromOwner, setFromOwner] = useState<string>('');
  const [toOwner,   setToOwner]   = useState<string>('');
  const [reason,    setReason]    = useState<string>('');
  const [mode,      setMode]      = useState<'filters' | 'ids'>('filters');
  const [jobIdsText, setJobIdsText] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [report,   setReport]   = useState<Report | null>(null);

  // Reset everything when the dialog reopens — operators expect a
  // fresh form, not stale state from the previous transfer.
  // `fromOwner` is rehydrated from `lockedFromOwnerId` when present
  // so the locked-source flow doesn't require the operator to
  // re-pick the source they already chose upstream.
  useEffect(() => {
    if (open) {
      setFromOwner(lockedFromOwnerId != null ? String(lockedFromOwnerId) : '');
      setToOwner(''); setReason('');
      setMode('filters'); setJobIdsText('');
      setError(null); setReport(null); setSubmitting(false);
    }
  }, [open, lockedFromOwnerId]);

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
    if (mode === 'ids') {
      // Accept commas, newlines, spaces — anything non-digit splits.
      const parsed = Array.from(new Set(
        jobIdsText.split(/[^0-9]+/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
      ));
      if (parsed.length === 0) { setError('Paste at least one valid Job ID.'); return; }
      if (parsed.length > 500) { setError(`Too many Job IDs (${parsed.length}). Max 500 per transfer.`); return; }
      body.jobIds = parsed;
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

            {/* Mode picker — radio with two options. Default to
                "filters" because that's the legacy CRM default and
                matches the most common ops workflow (filter, then
                transfer). */}
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
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={mode === 'ids'}
                  onChange={() => setMode('ids')}
                />
                <span>Specific Job IDs</span>
              </label>
              {/* Textarea is always rendered (even when mode='filters')
                  so the dialog's vertical size doesn't jump when the
                  operator toggles the radio. The control is disabled
                  + visually de-emphasised when not in ids mode — same
                  affordance, no layout shift. */}
              <textarea
                className={`w-full h-24 mt-1 border border-input rounded-md px-3 py-2 text-sm font-mono transition-opacity ${
                  mode === 'ids' ? '' : 'opacity-50 cursor-not-allowed bg-muted/40'
                }`}
                placeholder="Paste comma- or newline-separated Job IDs (max 500)"
                value={jobIdsText}
                onChange={(e) => setJobIdsText(e.target.value)}
                disabled={mode !== 'ids'}
              />
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
