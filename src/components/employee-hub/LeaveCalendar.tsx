'use client';

/*
 * Month calendar (Mon–Sun) for /employee-hub/attendance. Read-only — the
 * only write surface on this page is the Request Leave dialog.
 *
 * Day chip: P / W / HO / LV / SL. LV/SL only ever appears for an APPROVED
 * FULL-day leave (the day's own `type`); a half-day or pending leave keeps
 * the planned P and rides as a short note underneath (`leave` on the day).
 */

import { cn } from '@/lib/utils';
import { weekdayIndexMonday0 } from '@/components/roster/roster-dates';
import type { LeaveCalendarDay } from './leave-types';

const HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function chipInfo(day: LeaveCalendarDay): { code: string; cls: string; title: string } {
  if (day.holiday) return { code: 'HO', cls: 'bg-gold-tint text-gold-strong', title: `Holiday: ${day.holiday}` };
  if (day.type === 'LV') return { code: 'LV', cls: 'bg-urgent-tint text-urgent-strong', title: 'Approved Leave' };
  if (day.type === 'SL') return { code: 'SL', cls: 'bg-urgent-tint text-urgent-strong', title: 'Approved Sick Leave' };
  if (day.type === 'PR') return { code: 'P', cls: 'bg-success-tint text-success-strong', title: 'Present' };
  return { code: 'W', cls: 'bg-warning-tint text-warning-strong', title: 'Week Off' };
}

/** Note under the chip: pending (any duration) or an approved half day only — a full-day approved leave is already the LV/SL chip itself. */
function noteInfo(day: LeaveCalendarDay): { text: string; cls: string } | null {
  if (!day.leave) return null;
  if (day.leave.status === 'PENDING') return { text: 'Requested', cls: 'text-warning-strong' };
  if (day.leave.status === 'APPROVED' && day.leave.duration !== 'FULL') {
    return { text: `½ ${day.leave.kind}`, cls: 'text-info-strong' };
  }
  return null;
}

export function LeaveCalendar({ days, today, loading }: {
  days: LeaveCalendarDay[];
  today: string;
  loading: boolean;
}) {
  if (days.length === 0) {
    return <div className="py-10 text-center text-sm text-muted-foreground">{loading ? 'Loading…' : 'No Data For This Month.'}</div>;
  }
  const lead = weekdayIndexMonday0(days[0].date);

  return (
    <div className="grid grid-cols-7 gap-1">
      {HEAD.map((h) => (
        <div key={h} className="text-center text-xs font-medium text-muted-foreground py-0.5">{h}</div>
      ))}
      {Array.from({ length: lead }).map((_, i) => <div key={`b${i}`} />)}
      {days.map((day) => {
        const chip = chipInfo(day);
        const note = noteInfo(day);
        return (
          <div
            key={day.date}
            title={chip.title}
            className={cn(
              'min-h-[52px] min-w-0 rounded-md border p-1 flex flex-col gap-0.5',
              day.date === today ? 'border-primary' : 'border-border',
              day.date < today && 'opacity-75',
            )}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-semibold">{Number(day.date.slice(8))}</span>
              <span className={cn('rounded px-1 text-xs font-medium text-center', chip.cls)}>{chip.code}</span>
            </div>
            {note && <span className={cn('truncate text-xs font-medium whitespace-nowrap', note.cls)}>{note.text}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function LeaveCalendarLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-1 pt-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5"><span className="rounded bg-success-tint text-success-strong px-1.5 py-0.5 font-medium">P</span> Present</span>
      <span className="flex items-center gap-1.5"><span className="rounded bg-warning-tint text-warning-strong px-1.5 py-0.5 font-medium">W</span> Week Off</span>
      <span className="flex items-center gap-1.5"><span className="rounded bg-gold-tint text-gold-strong px-1.5 py-0.5 font-medium">HO</span> Holiday</span>
      <span className="flex items-center gap-1.5"><span className="rounded bg-urgent-tint text-urgent-strong px-1.5 py-0.5 font-medium">LV</span> / <span className="rounded bg-urgent-tint text-urgent-strong px-1.5 py-0.5 font-medium">SL</span> Approved Leave</span>
      <span className="flex items-center gap-1.5"><span className="font-medium text-warning-strong">Requested</span> Pending Request</span>
      <span className="flex items-center gap-1.5"><span className="font-medium text-info-strong">½ LV</span> Approved Half-Day Leave</span>
    </div>
  );
}
