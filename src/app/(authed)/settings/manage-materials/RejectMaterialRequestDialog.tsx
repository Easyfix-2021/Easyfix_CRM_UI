'use client';

/*
 * Reject flow for a Material Add Request — POST
 * /admin/material-requests/:id/reject with a required {reject_reason}.
 * Self-contained like DeleteReferencesDialog: owns its own mutation/toast,
 * the page only renders it with a request + onDone().
 */

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import type { MaterialRequestListItem } from './types';

export function RejectMaterialRequestDialog({
  open, onClose, request, onDone,
}: {
  open: boolean;
  onClose: () => void;
  request: MaterialRequestListItem | null;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setReason(''); setError(null); }
  }, [open]);

  async function submit() {
    if (!request) return;
    if (!reason.trim()) { setError('A reason is required.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/material-requests/${request.request_id}/reject`, { reject_reason: reason.trim() });
      showToast({ variant: 'success', message: 'Request rejected.' });
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Reject failed');
    } finally {
      setBusy(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: () => reason.trim() !== '', when: () => !busy });

  if (!open || !request) return null;

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject &quot;{request.material_name}&quot;?</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium block" htmlFor="reject-reason">
            Reason <span className="text-urgent">*</span>
          </label>
          <textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => { setReason(e.target.value); setError(null); }}
            className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
            placeholder="Shown to the technician in the app"
          />
          {error && (
            <div className="text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-3">
          <CancelButton onCancel={onClose} disabled={busy} />
          <Button variant="destructive" onClick={submit} disabled={busy || !reason.trim()}>
            {busy ? 'Rejecting…' : 'Reject'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
