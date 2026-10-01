'use client';

/*
 * Request Leave — Kind toggle (Leave / Sick Leave) fixes the date rules:
 *   LV: from >= rules.lvEarliest (today+2), multi-day allowed.
 *   SL: from = to = rules.slDate (today), single day only.
 * Duration halves are only selectable on a single-day request (from === to).
 * A live "N working days" preview runs every rule server-side via
 * POST /admin/leave/requests?dryRun=1 (same debounced-preview pattern as
 * FillPatternDialog's Update Roster preview) — its 400/409 message is shown
 * inline rather than only surfacing on Submit. Reason is mandatory on Submit
 * only — the dryRun preview deliberately runs without one.
 */

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { CancelButton } from '@/components/ui/cancel-button';
import { showToast, dismissToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { usePostFetch, useDebouncedValue } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { cn } from '@/lib/utils';
import type { LeaveDuration, LeaveKind, LeaveRules } from './leave-types';

const DURATIONS: LeaveDuration[] = ['FULL', 'FIRST_HALF', 'SECOND_HALF'];
const DURATION_LABEL: Record<LeaveDuration, string> = { FULL: 'Full Day', FIRST_HALF: 'First Half', SECOND_HALF: 'Second Half' };

export function RequestLeaveDialog({ open, onClose, rules, onCreated }: {
  open: boolean;
  onClose: () => void;
  rules: LeaveRules | null;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<LeaveKind>('LV');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [duration, setDuration] = useState<LeaveDuration>('FULL');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset to defaults every time the dialog (re)opens.
  useEffect(() => {
    if (!open || !rules) return;
    setKind('LV');
    setFromDate(rules.lvEarliest);
    setToDate(rules.lvEarliest);
    setDuration('FULL');
    setReason('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rules]);

  function onKindChange(next: LeaveKind) {
    setKind(next);
    setDuration('FULL');
    if (!rules) return;
    const fixed = next === 'SL' ? rules.slDate : rules.lvEarliest;
    setFromDate(fixed);
    setToDate(fixed);
  }

  const singleDay = !!fromDate && fromDate === toDate;
  // Half-day only makes sense on a single-day request — snap back to Full
  // Day the moment the range widens past one day.
  useEffect(() => {
    if (!singleDay && duration !== 'FULL') setDuration('FULL');
  }, [singleDay, duration]);

  const minDate = rules ? (kind === 'SL' ? rules.slDate : rules.lvEarliest) : '';

  const rawBody = useMemo(
    () => ({ kind, fromDate, toDate, duration, reason: reason.trim() || undefined }),
    [kind, fromDate, toDate, duration, reason],
  );
  const debouncedBody = useDebouncedValue(rawBody, 400);
  const canPreview = open && !!fromDate && !!toDate;
  const { data: preview, loading: previewLoading, error: previewError } = usePostFetch<{ days: number }>(
    canPreview ? '/admin/leave/requests?dryRun=1' : null,
    debouncedBody,
    { enabled: canPreview },
  );

  let previewText = '';
  if (!canPreview) previewText = 'Pick Dates To See The Working-Day Count.';
  else if (previewLoading && !preview) previewText = 'Calculating…';
  else if (previewError) previewText = previewError;
  else if (preview) previewText = `${preview.days} Working Day${preview.days === 1 ? '' : 's'}`;

  async function submit() {
    setSubmitting(true);
    const toastId = showToast({ variant: 'loading', message: 'Submitting Request…' });
    try {
      await api.post('/admin/leave/requests', { kind, fromDate, toDate, duration, reason: reason.trim() });
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Leave Requested' });
      onCreated();
      onClose();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Request Failed' });
    } finally {
      setSubmitting(false);
    }
  }

  const isDirty = () => {
    if (!rules) return reason.trim() !== '';
    const fixed = kind === 'SL' ? rules.slDate : rules.lvEarliest;
    return reason.trim() !== '' || duration !== 'FULL' || kind !== 'LV' || fromDate !== fixed || toDate !== fixed;
  };
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty, when: () => !submitting });
  const canSubmit = !!fromDate && !!toDate && !!reason.trim() && !previewError && !submitting;

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Request Leave</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="mb-1 block">Kind</Label>
            <div className="inline-flex rounded-md border overflow-hidden">
              <button
                type="button"
                onClick={() => onKindChange('LV')}
                className={cn('px-3 py-1.5 text-sm font-medium', kind === 'LV' ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted')}
              >
                Leave
              </button>
              <button
                type="button"
                onClick={() => onKindChange('SL')}
                className={cn('px-3 py-1.5 text-sm font-medium', kind === 'SL' ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted')}
              >
                Sick Leave
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {kind === 'LV'
                ? `Leave Needs At Least 2 Days' Notice — Earliest Date Is ${rules?.lvEarliest ?? '—'}. Multi-Day Requests Are Allowed.`
                : `Sick Leave Is For Today Only (${rules?.slDate ?? '—'}).`}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1 block">From</Label>
              <Input
                type="date"
                value={fromDate}
                min={minDate}
                disabled={kind === 'SL'}
                onChange={(e) => {
                  const v = e.target.value;
                  setFromDate(v);
                  if (toDate < v) setToDate(v);
                }}
              />
            </div>
            <div>
              <Label className="mb-1 block">To</Label>
              <Input
                type="date"
                value={toDate}
                min={fromDate || minDate}
                disabled={kind === 'SL'}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label className="mb-1 block">Duration</Label>
            <div className="inline-flex rounded-md border overflow-hidden">
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  disabled={d !== 'FULL' && !singleDay}
                  onClick={() => setDuration(d)}
                  className={cn(
                    'px-3 py-1.5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed',
                    duration === d ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  {DURATION_LABEL[d]}
                </button>
              ))}
            </div>
            {!singleDay && <p className="mt-1 text-xs text-muted-foreground">First/Second Half Only Applies To A Single-Day Request.</p>}
          </div>

          <div>
            <Label className="mb-1 block">Reason <span className="text-urgent">*</span></Label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              placeholder="Enter A Reason For The Leave"
              required
              aria-required="true"
              className="min-h-[70px] w-full rounded border bg-background px-2 py-1 text-sm"
            />
          </div>

          <p className={cn('min-h-[1.25rem] text-xs', previewError ? 'text-urgent-strong' : 'text-muted-foreground')}>{previewText}</p>
        </div>

        <DialogFooter>
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button onClick={submit} disabled={!canSubmit}>{submitting ? 'Submitting…' : 'Submit'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
