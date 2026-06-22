'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';

// ─── Cancel With Reason dialog ──────────────────────────────────────
// Legacy `jobCancel.vm`. Reason picker comes from /api/shared/lookup/cancel-reasons
// (tbl_cancel_reason / job_cancel_reason_by_easyfixer_app per CLAUDE.md).
// PATCH /:id/status with status=6 + reasonId + comment.
export function CancelWithReasonDialog({ open, onClose, onSubmit }: {
  open: boolean; onClose: () => void;
  onSubmit: (reasonId: number, comment: string) => Promise<void>;
}) {
  const lk = useLookup();
  const [reasonId, setReasonId] = useState('');
  const [customReason, setCustomReason] = useState('');
  /*
   * `customMode` swaps the SearchSelect for a free-text input when the
   * operator can't find a matching DB reason. The cancel-reasons list
   * IS DB-sourced (tbl_cancel_reason / job_cancel_reason_by_easyfixer_app
   * — see CLAUDE.md table-name notes), so we don't pollute it with
   * ad-hoc entries. Instead, custom reasons are submitted with the
   * smallest valid reason_id as the FK (accounting buckets all "other"
   * cancellations under the same code) and the typed string is prepended
   * to the comment as `[Custom] <reason> — <operator comment>`, so the
   * audit trail still captures the operator's intent.
   */
  const [customMode, setCustomMode] = useState(false);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReasonId(''); setCustomReason(''); setCustomMode(false);
      setComment(''); setErr(null);
    }
  }, [open]);
  async function go() {
    let resolvedId: number;
    let resolvedComment = comment.trim();
    if (customMode) {
      if (!customReason.trim()) { setErr('Enter a custom reason'); return; }
      // Use the smallest reason id as the FK fallback. Audit detail
      // lives in the comment column, prefixed [Custom] for filtering.
      const fallback = (lk.cancelReasons[0]?.id) ?? 0;
      if (!fallback) { setErr('No cancel-reason rows seeded — ask ops to add one'); return; }
      resolvedId = fallback;
      resolvedComment = `[Custom] ${customReason.trim()}${resolvedComment ? ' — ' + resolvedComment : ''}`;
    } else {
      resolvedId = Number(reasonId);
      if (!resolvedId) { setErr('Cancel reason is required'); return; }
    }
    setLoading(true); setErr(null);
    try { await onSubmit(resolvedId, resolvedComment); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Cancel failed'); }
    finally { setLoading(false); }
  }
  return (
    // Inline onOpenChange is intentional — this popup-style cancel dialog
    // resets all state on open and has an explicit Back button; there is
    // no useFormDirtyGuard wiring to preserve from the original (it lived
    // inside JobModal, which is whole-file exempt from this rule).
    // eslint-disable-next-line no-restricted-syntax
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Cancel Job</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label className="text-sm font-medium">Cancellation Reason *</Label>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => { setCustomMode((m) => !m); setReasonId(''); setCustomReason(''); }}
              >
                {customMode ? 'Pick from list instead' : 'Reason not in list? Add custom'}
              </button>
            </div>
            {customMode ? (
              <Input
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Describe the cancellation reason…"
                maxLength={200}
              />
            ) : (
              /* SearchSelect — already searchable. Operator types to
                 filter; arrow keys + Enter to pick. */
              <SearchSelect
                value={reasonId}
                onChange={(v) => setReasonId(v)}
                options={lk.cancelReasons.map((r) => ({ value: r.id, label: r.reason }))}
                placeholder="Select a reason…"
              />
            )}
          </div>
          <div>
            <Label className="text-sm font-medium block mb-1">Comment (optional)</Label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
              placeholder="Additional context for the cancellation…"
              maxLength={500}
            />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={loading}>Back</Button>
            <Button variant="destructive" onClick={go} disabled={loading}>
              {loading ? 'Cancelling…' : 'Cancel Job'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
