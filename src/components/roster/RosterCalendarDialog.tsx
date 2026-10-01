'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { cn } from '@/lib/utils';
import {
  addDaysYmd, addMonthsYmd, endOfMonth, istTodayYmd, monthKey, startOfMonth, weekdayIndexMonday0,
} from './roster-dates';
import { shiftLabel } from './ShiftSelect';
import type { RosterResponse } from './types';

/*
 * Calendar view of ONE employee's roster — a Mon–Sun month grid. Read-only:
 * editing stays in the grid, where the dirty/save flow lives. Reads the same
 * GET /admin/roster the grid uses (one month ≤ the 62-day cap) for the grid's
 * current team and picks this member out — no second endpoint to drift from.
 */

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function RosterCalendarDialog({
  member, teamOf, anchor, onClose,
}: {
  member: { userId: number; name: string } | null;
  teamOf: string;
  /** Any date in the month to open on (the grid's current anchor). */
  anchor: string;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(() => startOfMonth(anchor));
  // Read-only view — nothing to lose, but every Dialog closes through the shared guard.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: () => false });
  useEffect(() => { if (member) setMonth(startOfMonth(anchor)); }, [member, anchor]);

  const from = month;
  const to = endOfMonth(month);
  const qs = new URLSearchParams({ from, to });
  if (teamOf) qs.set('teamOf', teamOf);
  const { data, loading, error } = useFetch<RosterResponse>(member ? `/admin/roster?${qs.toString()}` : null);

  const row = data?.members.find((m) => m.userId === member?.userId);
  const holidays = new Map((data?.holidays ?? []).map((h) => [h.date, h.name]));
  const today = istTodayYmd();

  // Leading blanks so the 1st lands under its weekday; then every day of the month.
  const lead = weekdayIndexMonday0(from);
  const days: string[] = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) days.push(d);
  const woCount = row ? days.filter((d) => row.days[d]?.type === 'WO').length : 0;
  // Approved full-day leave (locked) — Employee Hub leave, 2026-09-30. Excluded
  // from BOTH the Present and Week Off tallies below; it's neither.
  // By TYPE, not `locked`: a week off inside an approved leave is locked but stays WO.
  const leaveCount = row ? days.filter((d) => row.days[d]?.type === 'LV' || row.days[d]?.type === 'SL').length : 0;

  return (
    <Dialog open={member != null} onOpenChange={guardedOpenChange}>
      <DialogContent className="!max-w-[760px] w-[95vw]">
        <DialogHeader>
          <DialogTitle>{member?.name} · Roster Calendar</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={() => setMonth(addMonthsYmd(month, -1))} aria-label="Previous Month">
            <ChevronLeft className="size-4" />
          </Button>
          <div className="text-center">
            <div className="text-sm font-semibold">
              {MONTH_LONG[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}
            </div>
            {row && (
              <div className="text-xs text-muted-foreground">
                {days.length - woCount - leaveCount} Present · {woCount} Week Off
                {leaveCount > 0 && ` · ${leaveCount} Leave`}
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => setMonth(addMonthsYmd(month, 1))} aria-label="Next Month">
            <ChevronRight className="size-4" />
          </Button>
        </div>

        {error ? (
          <p className="text-sm text-urgent-strong">Could Not Load The Roster For {monthKey(month)}.</p>
        ) : (
          <div className="grid grid-cols-7 gap-1.5">
            {HEAD.map((h) => (
              <div key={h} className="text-center text-xs font-medium text-muted-foreground py-1">{h}</div>
            ))}
            {Array.from({ length: lead }).map((_, i) => <div key={`b${i}`} />)}
            {days.map((d) => {
              const c = row?.days[d];
              const hol = holidays.get(d);
              const planned = c?.source === 'ROSTER';
              return (
                <div
                  key={d}
                  title={hol ? `Holiday: ${hol}` : undefined}
                  className={cn(
                    'min-h-[72px] rounded-md border p-1.5 flex flex-col gap-1',
                    d === today ? 'border-primary' : 'border-border',
                    d < today && 'opacity-60',
                  )}
                >
                  <div className="text-xs font-semibold">{Number(d.slice(8))}</div>
                  {loading || !c ? (
                    <div className="h-5 rounded bg-muted animate-pulse" />
                  ) : c.type === 'LV' || c.type === 'SL' ? (
                    <span
                      title={`Approved ${c.type === 'SL' ? 'Sick Leave' : 'Leave'}${c.leave ? ` — Request #${c.leave.id}` : ''}`}
                      className="rounded px-1 text-xs font-medium text-center border bg-urgent-tint text-urgent-strong border-transparent"
                    >
                      {c.type === 'SL' ? 'Sick Leave' : 'On Leave'}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        'rounded px-1 text-xs font-medium text-center border',
                        c.type === 'PR' ? 'bg-success-tint text-success-strong' : 'bg-warning-tint text-warning-strong',
                        planned ? 'border-transparent' : 'border-dashed border-current bg-transparent',
                      )}
                    >
                      {c.type === 'PR' ? (c.shift ? shiftLabel(c.shift) : 'Present') : 'Week Off'}
                    </span>
                  )}
                  {/* Pending (any duration) or an approved half day — a locked
                      full-day leave is already the chip above. */}
                  {c?.leave && !c.locked && (
                    <span className={cn('truncate text-xs font-medium text-center', c.leave.status === 'PENDING' ? 'text-warning-strong' : 'text-info-strong')}>
                      {c.leave.status === 'PENDING' ? 'Requested' : `½ ${c.leave.kind}`}
                    </span>
                  )}
                  {hol && <span className="truncate rounded-full bg-urgent-tint text-urgent-strong px-1.5 text-xs font-medium text-center">Holiday</span>}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>Solid = Planned On Roster</span>
          <span>Dashed = From Weekly Working Days</span>
          <span>Outlined = Today</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
