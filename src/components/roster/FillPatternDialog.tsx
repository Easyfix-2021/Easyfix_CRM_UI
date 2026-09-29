'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import type { SearchOption } from '@/components/ui/search-select';
import { showToast, dismissToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { usePostFetch, useDebouncedValue } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { cn } from '@/lib/utils';
import { daysBetweenInclusive } from './roster-dates';
import type { FillPatternResult, RosterMember } from './types';

const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function FillPatternDialog({
  open,
  onOpenChange,
  members,
  defaultFrom,
  defaultTo,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editable members only — the caller already filters. */
  members: RosterMember[];
  defaultFrom: string;
  defaultTo: string;
  onApplied: (affectedUserIds: number[]) => void;
}) {
  const [userIds, setUserIds] = useState<Array<string | number>>([]);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [weekOffDays, setWeekOffDays] = useState<number[]>([]);
  const [shiftStart, setShiftStart] = useState('');
  const [keepManual, setKeepManual] = useState(true);
  const [applying, setApplying] = useState(false);

  // Reset the form to defaults every time the dialog is (re)opened.
  useEffect(() => {
    if (!open) return;
    setUserIds([]);
    setFrom(defaultFrom);
    setTo(defaultTo);
    setWeekOffDays([]);
    setShiftStart('');
    setKeepManual(true);
  }, [open, defaultFrom, defaultTo]);

  const memberOptions: SearchOption[] = useMemo(
    () => members.map((m) => ({ value: m.userId, label: m.name })),
    [members],
  );

  function toggleWeekOffDay(idx: number) {
    setWeekOffDays((prev) => (prev.includes(idx) ? prev.filter((d) => d !== idx) : [...prev, idx].sort()));
  }

  const rawBody = useMemo(() => ({
    userIds: userIds.map(Number),
    from,
    to,
    weekOffDays,
    shiftStart: shiftStart || undefined,
    keepManual,
  }), [userIds, from, to, weekOffDays, shiftStart, keepManual]);
  const debouncedBody = useDebouncedValue(rawBody, 400);

  const canPreview = open && userIds.length > 0 && !!from && !!to;
  const { data: preview, loading: previewLoading, error: previewError } = usePostFetch<FillPatternResult>(
    canPreview ? '/admin/roster/fill-pattern?dryRun=1' : null,
    debouncedBody,
    { enabled: canPreview },
  );

  let previewText = '';
  if (!canPreview) previewText = 'Pick At Least One Member To See A Preview.';
  else if (previewLoading && !preview) previewText = 'Calculating Preview…';
  else if (previewError) previewText = previewError;
  else if (preview) {
    const days = daysBetweenInclusive(from, to);
    previewText = `Preview: ${days} Day${days === 1 ? '' : 's'} For ${preview.users} Member${preview.users === 1 ? '' : 's'} · ${preview.wo} WO · ${preview.pr} PR · ${preview.keptManual} Hand-Edited Cell${preview.keptManual === 1 ? '' : 's'} Kept`;
  }

  async function apply() {
    if (userIds.length === 0) return;
    setApplying(true);
    const toastId = showToast({ variant: 'loading', message: 'Applying Pattern…' });
    try {
      await api.post('/admin/roster/fill-pattern', {
        userIds: userIds.map(Number), from, to, weekOffDays, shiftStart: shiftStart || undefined, keepManual,
      });
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Pattern Applied' });
      onApplied(userIds.map(Number));
      onOpenChange(false);
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Apply Failed' });
    } finally {
      setApplying(false);
    }
  }

  const isDirty = () => (
    userIds.length > 0 || weekOffDays.length > 0 || shiftStart !== ''
    || from !== defaultFrom || to !== defaultTo || !keepManual
  );
  const guardedOpenChange = useFormDirtyGuard(() => onOpenChange(false), {
    isDirty,
    when: () => !applying,
    title: 'Discard This Fill Pattern?',
    description: 'Your selections will be lost.',
  });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Fill From Pattern</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="mb-1 block">Members</Label>
            <SearchMultiSelect
              value={userIds}
              onChange={setUserIds}
              options={memberOptions}
              placeholder="Select Members"
              selectedLabel="Members"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1 block">From</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1 block">To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>

          <div>
            <Label className="mb-1 block">Week Off Day(s)</Label>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAY_SHORT.map((label, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => toggleWeekOffDay(idx)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs font-medium',
                    weekOffDays.includes(idx)
                      ? 'border-primary bg-primary text-white'
                      : 'border-input text-muted-foreground hover:bg-muted',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label className="mb-1 block">Shift Start (Optional)</Label>
            <Input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} className="max-w-[160px]" />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={keepManual} onChange={(e) => setKeepManual(e.target.checked)} />
            Keep Cells Already Edited By Hand
          </label>

          <p className="min-h-[1.25rem] text-xs text-muted-foreground">{previewText}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => guardedOpenChange(false)} disabled={applying}>Cancel</Button>
          <Button onClick={apply} disabled={applying || userIds.length === 0}>Apply Pattern</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
