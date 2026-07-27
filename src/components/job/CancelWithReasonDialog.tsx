'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { ApiError } from '@/lib/api';
import { fetchReasonsCached } from './jobActionReasons';

/*
 * Cancel With Reason dialog — reworked 2026-07-27 to mirror the Add Remarks flow.
 *
 * A "Cancellation Due To" radio (user_type) drives the reason list, read from
 * action_taken_reason WHERE action_type = 1 (the Cancel bucket) AND user_type =
 * the radio, via GET /admin/jobs/cancel-reasons?dueTo=… — the exact twin of Add
 * Remarks' /comment-reasons (action_type = 5). This replaces the deprecated
 * tbl_cancel_reason source, so the picked id is an action_taken_reason.id.
 *
 * onSubmit (wired in JobModal) PATCHes /:id/status with status=6 + reasonId +
 * comment; the BE then writes tbl_job (cancel_* columns + enum_reason_id) AND a
 * tbl_job_comment audit row (comment_on=1) — the same History timeline Add
 * Remarks writes to. Comment stays OPTIONAL (the BE synthesises "Job cancelled"
 * for the audit row when it's blank).
 */
const CANCEL_DUE_TO_OPTIONS: Array<'Customer' | 'Client' | 'EasyFix' | 'Technician'> = [
  'Customer', 'Client', 'EasyFix', 'Technician',
];

export function CancelWithReasonDialog({ open, onClose, onSubmit }: {
  open: boolean; onClose: () => void;
  onSubmit: (reasonId: number, comment: string) => Promise<void>;
}) {
  const [dueTo, setDueTo] = useState<string>('Customer');
  const [reasonId, setReasonId] = useState('');
  const [reasons, setReasons] = useState<Array<{ id: number; label: string }>>([]);
  const [reasonsLoading, setReasonsLoading] = useState(false);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setDueTo('Customer'); setReasonId(''); setComment(''); setErr(null); }
  }, [open]);

  // Reason list filtered by the "Cancellation Due To" radio → action_taken_reason
  // user_type (within the action_type=1 Cancel bucket). Refetch on radio change;
  // reset the picked reason since a stale id from another bucket would render blank.
  // Shared 60s module cache (fetchReasonsCached) so toggling the radio is instant.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReasonsLoading(true);
    setReasonId('');
    fetchReasonsCached('/admin/jobs/cancel-reasons', { dueTo: dueTo.toLowerCase() })
      .then((rows) => {
        if (cancelled) return;
        setReasons((rows || []).filter((r) => r.id != null).map((r) => ({ id: Number(r.id), label: r.label })));
      })
      .catch(() => { if (!cancelled) setReasons([]); })
      .finally(() => { if (!cancelled) setReasonsLoading(false); });
    return () => { cancelled = true; };
  }, [open, dueTo]);

  async function go() {
    const resolvedId = Number(reasonId);
    if (!resolvedId) { setErr('Cancellation Reason is required'); return; }
    setLoading(true); setErr(null);
    try { await onSubmit(resolvedId, comment.trim()); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Cancel failed'); }
    finally { setLoading(false); }
  }

  return (
    // Inline onOpenChange is intentional — this popup-style cancel dialog resets
    // all state on open and has an explicit Back button; there is no
    // useFormDirtyGuard wiring to preserve (it lived inside JobModal, which is
    // whole-file exempt from this rule).
    // eslint-disable-next-line no-restricted-syntax
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Cancel Job</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="block mb-1" required>Cancellation Due To</Label>
            <div className="flex flex-wrap items-center gap-4">
              {CANCEL_DUE_TO_OPTIONS.map((opt) => (
                <label key={opt} className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="cancel-due-to"
                    value={opt}
                    checked={dueTo === opt}
                    onChange={() => setDueTo(opt)}
                    className="accent-primary"
                  />
                  {opt}
                </label>
              ))}
            </div>
          </div>
          <div>
            <Label className="block mb-1" required>Cancellation Reason</Label>
            {/* SearchSelect — searchable: type to filter, arrow keys + Enter to pick. */}
            <SearchSelect
              value={reasonId}
              onChange={(v) => setReasonId(v)}
              options={reasons.map((r) => ({ value: String(r.id), label: r.label }))}
              placeholder={reasonsLoading ? 'Loading reasons…' : 'Select a reason…'}
              disabled={reasonsLoading}
            />
          </div>
          <div>
            <Label className="block mb-1">Comment (Optional)</Label>
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
            <Button variant="destructive" onClick={go} disabled={loading || !reasonId}>
              {loading ? 'Cancelling…' : 'Cancel Job'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
