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
import { daysBetweenInclusive, formatYmdLabel } from './roster-dates';
import type { FillPatternResult, RosterMember } from './types';
import { ShiftSelect } from './ShiftSelect';

const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function FillPatternDialog({
  open,
  onOpenChange,
  members,
  defaultFrom,
  defaultTo,
  onApplied,
  initialUserIds = [],
  minDate,
  maxDate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editable members only — the caller already filters. */
  members: RosterMember[];
  defaultFrom: string;
  defaultTo: string;
  onApplied: (affectedUserIds: number[]) => void;
  /** Members pre-selected on open — e.g. from a row's "No Week Off" button. */
  initialUserIds?: number[];
  /** The editable window — past dates are locked, and the server rejects them too. */
  minDate: string;
  maxDate: string;
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
    setUserIds(initialUserIds);
    setFrom(defaultFrom);
    setTo(defaultTo);
    setWeekOffDays([]);
    setShiftStart('');
    setKeepManual(true);
    // initialUserIds is read on open only — a new array identity each render must not reset the form.
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

  /* Dates outside the editable window never reach the server: the inputs carry
     min/max (the picker greys those days out) and a typed date is caught here. */
  const rangeError =
    !from || !to ? 'Pick A From And To Date.'
    : from < minDate ? `From Can't Be Before ${formatYmdLabel(minDate)} — Past Dates Are Locked.`
    : to > maxDate ? `To Can't Be After ${formatYmdLabel(maxDate)}.`
    : from > to ? 'From Must Be On Or Before To.'
    : null;
  const canPreview = open && userIds.length > 0 && !rangeError;
  const { data: preview, loading: previewLoading, error: previewError } = usePostFetch<FillPatternResult>(
    canPreview ? '/admin/roster/fill-pattern?dryRun=1' : null,
    debouncedBody,
    { enabled: canPreview },
  );

  let previewText = '';
  if (rangeError) previewText = rangeError;
  else if (!canPreview) previewText = 'Pick At Least One Employee To See A Preview.';
  else if (previewLoading && !preview) previewText = 'Calculating Preview…';
  else if (previewError) previewText = previewError;
  else if (preview) {
    const days = daysBetweenInclusive(from, to);
    previewText = `Preview: ${days} Day${days === 1 ? '' : 's'} For ${preview.users} Employee${preview.users === 1 ? '' : 's'} · ${preview.wo} WO · ${preview.pr} PR · ${preview.keptManual} Individually Set Day${preview.keptManual === 1 ? '' : 's'} Kept`;
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
      showToast({ variant: 'success', message: 'Roster Updated' });
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
          <DialogTitle>Update Roster</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="mb-1 block">Employee(s)</Label>
            <SearchMultiSelect
              value={userIds}
              onChange={setUserIds}
              options={memberOptions}
              placeholder="Select Employee(s)"
              selectedLabel="Employees"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1 block">From</Label>
              <Input type="date" value={from} min={minDate} max={maxDate} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1 block">To</Label>
              <Input type="date" value={to} min={from && from > minDate ? from : minDate} max={maxDate} onChange={(e) => setTo(e.target.value)} />
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
            <ShiftSelect value={shiftStart} onChange={setShiftStart} placeholder="Each Employee's Default Shift" className="max-w-[240px]" title="Shift Start" />
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={keepManual} onChange={(e) => setKeepManual(e.target.checked)} />
              Don&apos;t Overwrite Days Set Individually
            </label>
            <p className="ml-6 text-xs text-muted-foreground">
              Days changed one by one on the grid or through Bulk Update stay as they are. Untick to overwrite them too.
            </p>
          </div>

          <p className="min-h-[1.25rem] text-xs text-muted-foreground">{previewText}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => guardedOpenChange(false)} disabled={applying}>Cancel</Button>
          <Button onClick={apply} disabled={applying || userIds.length === 0 || !!rangeError}>Update Roster</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
