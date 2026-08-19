'use client';

import * as React from 'react';
import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SearchSelect } from '@/components/ui/search-select';
import { api, ApiError } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { fetchReasonsCached } from './jobActionReasons';
import type { JobComment } from './jobTypes';

/*
 * AddRemarksDialog — legacy "Job CheckOut Remarks" layout (refreshed
 * 2026-05-19). Mirrors the JobOutcomeDialog structure pixel-for-pixel:
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ Job CheckOut Remarks                                 │  ← dark band
 *   ├──────────────────────────────────────────────────────┤
 *   │ Open Due To *  ◉ By Customer  ○ Client …             │
 *   │ Reason *       [SearchSelect dropdown ▾]             │
 *   │ Remarks *      [textarea…]                           │
 *   │                       [Submit]      [Cancel]         │
 *   └──────────────────────────────────────────────────────┘
 *
 * Submit POSTs to /admin/jobs/:id/comments with:
 *   {
 *     comments:        "<ops remark>",  // ONLY the typed remark — the legacy
 *                                       // "[Open Due To: X · Reason: Y]" prefix
 *                                       // was dropped 2026-06-04; the reason lives
 *                                       // in enum_reason_id, joined back for display
 *     comment_on:      1,               // legacy "created" stage code
 *     enum_reason_id:  <id>             // picked from the reason dropdown
 *   }
 *
 * Reason list comes from GET /admin/jobs/comment-reasons, which reads
 * `action_taken_reason` WHERE action_type = 5 ("Job CheckOut Remarks" bucket,
 * ACTION_TYPE.ADD_REMARKS) AND user_type = the "Open Due To" radio
 * (Customer 1 / Client 2 / EasyFix 3 / Technician 4; default Client), status
 * active — refetched whenever the radio changes.
 */
const REMARK_DUE_TO_OPTIONS: Array<'Customer' | 'Client' | 'EasyFix' | 'Technician'> = [
  'Customer', 'Client', 'EasyFix', 'Technician',
];

export function AddRemarksDialog({ open, jobId, onClose, onSaved, currentUserName = 'You', onOptimisticAdd, onPendingFailed }: {
  open: boolean; jobId: number;
  onClose: () => void; onSaved: () => void;
  // Display name to stamp on the optimistic comment row. Defaults to "You"
  // when the parent doesn't have a resolved user (shouldn't happen in
  // practice — `useMe()` is available everywhere this dialog opens).
  currentUserName?: string;
  // Called the MOMENT Save is clicked (before the POST resolves) with a
  // fully-shaped JobComment row carrying a negative `id` (tempId). The
  // parent prepends it to its `pendingComments` list which the
  // JobCommentsTab renders at the top with a "Sending…" pill. Both this
  // and `onPendingFailed` are optional — when omitted the dialog falls
  // back to the legacy "wait for POST, then close" behaviour.
  onOptimisticAdd?: (row: JobComment & { _pending?: true }) => void;
  onPendingFailed?: (tempId: number) => void;
}) {
  const [dueTo, setDueTo] = useState<string>('Customer');
  const [reasonId, setReasonId] = useState<string>('');
  const [text, setText] = useState('');
  const [reasons, setReasons] = useState<Array<{ id: number; label: string }>>([]);
  const [reasonsLoading, setReasonsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset on each open.
  useEffect(() => {
    if (open) { setDueTo('Customer'); setReasonId(''); setText(''); setErr(null); }
  }, [open]);

  // Fetch the reason list filtered by Open-Due-To. Legacy CRM's dropdown
  // narrows dynamically as the operator switches the radio — each value maps to
  // action_taken_reason.user_type (Customer 1 / Client 2 / EasyFix 3 /
  // Technician 4) within the action_type = 5 "Job CheckOut Remarks" bucket. The
  // refetch resets the picked reason since a stale id from a different bucket
  // would render as an opaque number.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReasonsLoading(true);
    setReasonId('');
    // Module-level 60s cache (see fetchReasonsCached above) reduces
    // BE round-trips when the operator toggles the radio multiple times.
    fetchReasonsCached('/admin/jobs/comment-reasons', { dueTo: dueTo.toLowerCase() })
      .then((rows) => {
        if (cancelled) return;
        // AddRemarksDialog needs id as a non-null number; cached helper
        // returns id|null for compatibility with JobOutcomeDialog. Cast
        // here — comment-reasons never returns null ids by contract.
        setReasons((rows || []).filter((r) => r.id != null).map((r) => ({ id: Number(r.id), label: r.label })));
      })
      .catch(() => { if (!cancelled) setReasons([]); })
      .finally(() => { if (!cancelled) setReasonsLoading(false); });
    return () => { cancelled = true; };
  }, [open, dueTo]);

  const reasonOptions = React.useMemo(
    () => reasons.map((r) => ({ value: String(r.id), label: r.label })),
    [reasons],
  );

  async function go() {
    const remark = text.trim();
    if (!reasonId) { setErr('Please pick a reason.'); return; }
    if (!remark) { setErr('Please enter a remark before saving.'); return; }
    // Comment column stores ONLY the operator's typed remark (2026-06-04 —
    // dropped the legacy "[Open Due To: X · Reason: Y]" structured prefix
    // per ops). Reason is canonically in enum_reason_id below; the
    // Comments tab joins back to `tbl_enum_reason` for the label on render.
    const reasonLabel = reasons.find((r) => String(r.id) === reasonId)?.label || null;
    const payload = {
      comments: remark,
      comment_on: 1, // legacy "created" stage — see commentBody Joi schema
      enum_reason_id: Number(reasonId),
    };
    // Optimistic flow (2026-06-05). Stamp a pending row + close the dialog
    // immediately so the operator sees their comment at the top of the
    // Comments tab WHILE the POST is in flight. Negative `id` is the
    // sentinel so the parent can match it on success/failure callbacks.
    const tempId = -Date.now() - Math.floor(Math.random() * 1000);
    const optimistic: JobComment & { _pending?: true } = {
      id: tempId,
      job_id: jobId,
      comments: remark,
      comment_on: 1,
      stage: 'created',
      created_on: new Date().toISOString(),
      appointment_on: null,
      commented_by: null,
      user_name: currentUserName,
      efr_id: null,
      enum_reason_id: Number(reasonId),
      enum_desc: reasonLabel,
      _pending: true,
    };
    if (onOptimisticAdd) {
      // Optimistic-mode path: dialog closes synchronously; POST runs as a
      // background task; reconciliation happens inside JobCommentsTab.
      onOptimisticAdd(optimistic);
      api.post(`/admin/jobs/${jobId}/comments`, payload)
        .then(() => onSaved())
        .catch((e: unknown) => {
          onPendingFailed?.(tempId);
          const msg = e instanceof ApiError ? e.message : 'Failed to save remark';
          showToast({ variant: 'error', message: msg });
        });
      return;
    }
    // Legacy path — kept for any future caller that doesn't wire the
    // optimistic callbacks. Dialog stays open with a spinner until POST
    // resolves, then closes on success.
    setLoading(true); setErr(null);
    try {
      await api.post(`/admin/jobs/${jobId}/comments`, payload);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to save remark');
    } finally { setLoading(false); }
  }
  return (
    // Inline onOpenChange is intentional — this is a popup-style remark
    // dialog (not a full edit form). It already resets all state on open
    // and has an explicit Cancel button; there's no useFormDirtyGuard
    // wiring to preserve from the original (it lived inside JobModal,
    // which is whole-file exempt from this rule). Extracting it shouldn't
    // change behaviour, so we keep the same close path.
    // eslint-disable-next-line no-restricted-syntax
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* overflow-y-auto (not overflow-hidden): a long remarks history must stay
          scrollable. `auto` still clips to the rounded corners so the dark band
          keeps its clip, whereas `overflow-hidden` out-merges DialogContent's
          base scroll and re-clips at 85vh. */}
      <DialogContent className="!max-w-xl p-0 gap-0 overflow-x-hidden overflow-y-auto">
        {/* Dark-slate band header matching JobOutcomeDialog. */}
        <div className="px-6 py-4 bg-gradient-to-r from-ink-900 via-ink-700 to-ink-900 text-white flex items-center gap-2.5 shadow-[inset_0_-3px_0_0_rgba(14,165,233,0.85)]">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-info/20 ring-1 ring-info/40">
            <Pencil className="h-3.5 w-3.5 text-info-tint" />
          </span>
          <DialogTitle className="text-[15px] font-semibold tracking-tight">Job CheckOut Remarks</DialogTitle>
        </div>
        {/* Screen-reader-only description — required by Radix to satisfy
            aria-describedby. Without it, modern Radix emits a console
            warning AND nested dialogs (this one mounted inside JobModal)
            can be unreachable because the parent stays focus-trapped.
            Visible header above already conveys intent to sighted users,
            so we keep this off-screen rather than adding visual noise. */}
        <DialogDescription className="sr-only">
          Capture a remark with a reason for this job — saved to the job timeline and visible to ops.
        </DialogDescription>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-[150px_1fr] items-center gap-3">
            <label className="text-sm font-medium text-right">
              Open Due To<span className="text-urgent-strong">*</span>
            </label>
            <div className="flex flex-wrap items-center gap-4">
              {REMARK_DUE_TO_OPTIONS.map((opt) => (
                <label key={opt} className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="add-remarks-due-to"
                    value={opt}
                    checked={dueTo === opt}
                    onChange={() => setDueTo(opt)}
                    className="accent-gold"
                  />
                  {opt === 'Customer' ? 'By Customer' : opt}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-[150px_1fr] items-center gap-3">
            <label className="text-sm font-medium text-right">
              Reason<span className="text-urgent-strong">*</span>
            </label>
            <SearchSelect
              value={reasonId}
              onChange={setReasonId}
              options={reasonOptions}
              placeholder={reasonsLoading ? 'Loading reasons…' : 'Select Reason'}
              disabled={reasonsLoading}
              required
            />
          </div>
          <div className="grid grid-cols-[150px_1fr] items-start gap-3">
            <label className="text-sm font-medium text-right pt-2">
              Remarks<span className="text-urgent-strong">*</span>
            </label>
            <textarea
              required
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write Comment…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:border-foreground/40 resize-y"
              maxLength={2000}
            />
          </div>
          {err && <div className="text-sm text-urgent-strong text-right">{err}</div>}
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button
              onClick={go}
              disabled={loading || !reasonId || !text.trim()}
              className="bg-success hover:bg-success-strong text-white"
            >
              {loading ? 'Saving…' : 'Submit'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="bg-urgent hover:bg-urgent-strong text-white border-urgent hover:text-white"
              onClick={onClose}
            >
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
