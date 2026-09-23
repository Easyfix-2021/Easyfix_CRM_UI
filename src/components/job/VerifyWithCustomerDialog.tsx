'use client';

/*
 * VerifyWithCustomerDialog — the ONE outcome dialog for a can't-complete /
 * cancel claim (V3 Phase 3, spec 3.2 + 3.6). Opened from two places, per the
 * spec: the /ops-desk row action ("Verify With Customer") and the
 * /verification queue (a claim row links to this same dialog instead of
 * "Pass Audit") — one component so the two surfaces cannot drift.
 *
 * POST /admin/ops-desk/reports/:id/resolve { outcome: 'revisit'|'cancel', revisitOn? }
 *   revisit → reuses the existing reschedule path server-side.
 *   cancel  → reuses the existing setStatus 6 path server-side.
 */

import { useState } from 'react';
import { CalendarClock, XCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { istNowWallClock } from '@/lib/utils';

export function VerifyWithCustomerDialog({
  reportId,
  jobTitle,
  onClose,
  onResolved,
}: {
  /** Null closes the dialog (controlled-by-presence, same shape as JobModal's row dialogs). */
  reportId: number | null;
  jobTitle?: string | null;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [outcome, setOutcome] = useState<'revisit' | 'cancel'>('revisit');
  const [revisitOn, setRevisitOn] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (reportId == null) return;
    if (outcome === 'revisit' && !revisitOn) {
      showToast({ variant: 'error', message: 'Pick a revisit date' });
      return;
    }
    setBusy(true);
    try {
      await api.resolveOpsDeskReport(reportId, {
        outcome,
        ...(outcome === 'revisit' ? { revisitOn } : {}),
      });
      showToast({
        variant: 'success',
        message: outcome === 'revisit' ? 'Revisit Scheduled' : 'Job Cancelled',
      });
      onResolved();
      onClose();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed to resolve the claim' });
    } finally {
      setBusy(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });
  const todayIst = istNowWallClock().slice(0, 10);

  return (
    <Dialog open={reportId != null} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Verify With Customer{jobTitle ? ` · ${jobTitle}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            Confirm the outcome with the customer before this closes. His visit charge is already his either way.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setOutcome('revisit')}
              className={`flex items-center gap-2 rounded-md border p-3 text-sm ${outcome === 'revisit' ? 'border-primary bg-primary/5' : 'border-input'}`}
            >
              <CalendarClock className="size-4" /> Revisit
            </button>
            <button
              type="button"
              onClick={() => setOutcome('cancel')}
              className={`flex items-center gap-2 rounded-md border p-3 text-sm ${outcome === 'cancel' ? 'border-urgent bg-urgent-tint' : 'border-input'}`}
            >
              <XCircle className="size-4" /> Cancel
            </button>
          </div>
          {outcome === 'revisit' && (
            <div className="space-y-1">
              <Label>Revisit Date *</Label>
              <Input type="date" min={todayIst} value={revisitOn} onChange={(e) => setRevisitOn(e.target.value)} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
          <Button
            onClick={submit}
            disabled={busy || (outcome === 'revisit' && !revisitOn)}
            variant={outcome === 'cancel' ? 'destructive' : 'default'}
          >
            {busy ? 'Saving…' : outcome === 'revisit' ? 'Schedule Revisit' : 'Cancel Job'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
