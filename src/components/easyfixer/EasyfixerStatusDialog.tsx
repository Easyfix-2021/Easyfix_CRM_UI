'use client';

import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { showToast } from '@/components/ui/toast';

/*
 * EasyfixerStatusDialog — Deactivate / Reactivate a technician from the Manage
 * Easyfixers row action menu (PATCH /admin/easyfixers/:id/status).
 *
 * Deactivate: a required comment + optional reason code, and — for operators who
 * hold the Admin-only `isEasyfixerTempInactive` action (canScheduleReactivation)
 * — an optional "Auto-reactivate on <date>". Setting the date marks the tech
 * Temporarily Inactive; the daily easyfixer-auto-reactivation cron flips them
 * back to Active on/after that date. Blank date = a permanent deactivation.
 *
 * Reactivate: a simple confirm (the backend also clears any pending
 * auto-reactivation so the cron never re-processes the row).
 */

// IST 'YYYY-MM-DD' for the date input's min (tomorrow) — Intl parts, no UTC drift.
function istTomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

export function EasyfixerStatusDialog({
  open, easyfixer, canScheduleReactivation = false, onClose, onDone,
}: {
  open: boolean;
  easyfixer: { efr_id: number; efr_name: string; efr_status: number } | null;
  canScheduleReactivation?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const isInactive = easyfixer ? !Number(easyfixer.efr_status) : false;
  const [comment, setComment] = useState('');
  const [reactivationDate, setReactivationDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const minDate = istTomorrow();

  // Reset every field on each open so a prior attempt never leaks in.
  useEffect(() => {
    if (open) { setComment(''); setReactivationDate(''); setErr(null); }
  }, [open]);

  // Bulletproof "opens then instantly closes" fix (matches SendProfileUpdateLinkDialog):
  // Radix fires onOpenChange(false) from the SAME pointer interaction that opened
  // this dialog (launched from a DropdownMenu item), so the dialog dismisses in a
  // blink. Swallow ANY close within 400ms of opening; a real Esc / Cancel /
  // outside-click always arrives later. Deferring the open with setTimeout in the
  // parent is NOT enough on its own — the phantom close still fires.
  const openedAtRef = useRef(0);
  useEffect(() => { if (open) openedAtRef.current = Date.now(); }, [open]);
  function handleOpenChange(next: boolean) {
    if (!next && Date.now() - openedAtRef.current < 400) return;
    if (!next) onClose();
  }

  async function submit() {
    if (!easyfixer) return;
    if (!isInactive && !comment.trim()) { setErr('A comment is required to deactivate.'); return; }
    setLoading(true); setErr(null);
    try {
      const body: Record<string, unknown> = isInactive
        ? { active: true }
        : {
            active: false,
            ...(comment.trim() ? { comment: comment.trim() } : {}),
            ...(canScheduleReactivation && reactivationDate ? { reactivationDate } : {}),
          };
      await api.patch(`/admin/easyfixers/${easyfixer.efr_id}/status`, body);
      showToast({
        variant: 'success',
        message: isInactive
          ? 'Technician reactivated.'
          : reactivationDate
            ? `Technician set temporarily inactive — auto-reactivates ${reactivationDate}.`
            : 'Technician deactivated.',
      });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to update status');
    } finally {
      setLoading(false);
    }
  }

  return (
    // eslint-disable-next-line no-restricted-syntax
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isInactive ? 'Reactivate' : 'Deactivate'} Technician{easyfixer ? ` — ${easyfixer.efr_name}` : ''}
          </DialogTitle>
          <DialogDescription>
            {isInactive
              ? 'Set this technician back to Active and clear any pending auto-reactivation.'
              : 'Set this technician Inactive, with a reason and an optional auto-reactivation date.'}
          </DialogDescription>
        </DialogHeader>
        {isInactive ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This sets the technician back to Active and clears any pending auto-reactivation.
            </p>
            {err && <div className="text-sm text-red-600">{err}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
              <Button onClick={submit} disabled={loading}>{loading ? 'Reactivating…' : 'Reactivate'}</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-sm font-medium block mb-1">Comment *</Label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[70px]"
                placeholder="Why is this technician being deactivated…"
                maxLength={500}
              />
            </div>
            {canScheduleReactivation && (
              <div>
                <Label className="text-sm font-medium block mb-1">Auto-reactivate on (optional)</Label>
                <Input type="date" min={minDate} value={reactivationDate} onChange={(e) => setReactivationDate(e.target.value)} />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Leave blank for a permanent deactivation. If set, the technician is marked Temporarily Inactive and a daily job reactivates them on this date.
                </p>
              </div>
            )}
            {err && <div className="text-sm text-red-600">{err}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
              <Button onClick={submit} disabled={loading || !comment.trim()}>{loading ? 'Deactivating…' : 'Deactivate'}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
