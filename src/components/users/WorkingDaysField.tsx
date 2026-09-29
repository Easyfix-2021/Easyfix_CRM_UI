'use client';

import Link from 'next/link';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/*
 * Working Days — the day-card control for Add/Edit User's "Working Days"
 * section. Presentational only: the parent (manage-users/page.tsx) owns the
 * state and the all-week-off submit guard, so this file stays a few lines
 * wired into the form rather than a second place attendance_preference logic
 * lives. Matches the API contract's day keys exactly (roster-api-contract.md)
 * — 'PR' = Present, 'WO' = Week Off — so the parent can spread `days` straight
 * into the attendance_preference payload.
 */

export type DayKey = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
export type DayType = 'PR' | 'WO';
export type WorkingDays = Record<DayKey, DayType>;

export const ALL_WORKING_DAYS: WorkingDays = {
  monday: 'PR', tuesday: 'PR', wednesday: 'PR', thursday: 'PR',
  friday: 'PR', saturday: 'PR', sunday: 'PR',
};

// Weekday index 0 = Monday … 6 = Sunday, per the contract.
export const WORKING_DAYS_ORDER: Array<{ key: DayKey; short: string; full: string }> = [
  { key: 'monday',    short: 'Mon', full: 'Monday' },
  { key: 'tuesday',   short: 'Tue', full: 'Tuesday' },
  { key: 'wednesday', short: 'Wed', full: 'Wednesday' },
  { key: 'thursday',  short: 'Thu', full: 'Thursday' },
  { key: 'friday',    short: 'Fri', full: 'Friday' },
  { key: 'saturday',  short: 'Sat', full: 'Saturday' },
  { key: 'sunday',    short: 'Sun', full: 'Sunday' },
];

export function WorkingDaysField({
  days, onToggle, shiftStart, onShiftStart,
}: {
  days: WorkingDays;
  onToggle: (key: DayKey) => void;
  shiftStart: string;
  onShiftStart: (v: string) => void;
}) {
  const workingCount = WORKING_DAYS_ORDER.filter((d) => days[d.key] === 'PR').length;
  const offDays = WORKING_DAYS_ORDER.filter((d) => days[d.key] === 'WO');

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm font-medium">Working Days</p>
        <div className="flex items-center gap-2">
          <span className="text-xs rounded-full bg-info-tint text-info-strong px-2 py-0.5 font-medium">
            {workingCount} Working Days
          </span>
          {offDays.length > 0 ? (
            <span className="text-xs rounded-full bg-warning-tint text-warning-strong px-2 py-0.5 font-medium">
              Week Off: {offDays.map((d) => d.short).join(', ')}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">No Week Off</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        {WORKING_DAYS_ORDER.map((d) => {
          const present = days[d.key] === 'PR';
          return (
            <button
              key={d.key}
              type="button"
              aria-pressed={present}
              aria-label={d.full}
              onClick={() => onToggle(d.key)}
              className={cn(
                'flex h-14 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-full text-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                // --sidebar is a fixed-lightness chrome token (same value in
                // both themes), so `bg-sidebar text-white` stays readable in
                // dark mode — unlike an ink-* surface, which inverts and would
                // pair a near-white fill with white text at night.
                present ? 'bg-sidebar text-white' : 'bg-warning-tint text-warning-strong',
              )}
            >
              <span>{d.short}</span>
              <span className="text-xs font-normal opacity-80 leading-none">{present ? 'Present' : 'Week Off'}</span>
            </button>
          );
        })}
      </div>

      <div className="text-sm text-info-strong bg-info-tint border border-info/30 rounded p-2 flex items-start gap-2">
        <Info className="size-4 mt-0.5 shrink-0" />
        <span>
          For employees on Roster, keep all 7 days selected and manage their Week Off from{' '}
          <Link href="/team-roster" className="underline underline-offset-2 font-medium">Team Roster</Link>.
        </span>
      </div>

      <div className="max-w-[220px]">
        <Label className="block mb-1">Default Shift (Optional)</Label>
        <Input type="time" value={shiftStart} onChange={(e) => onShiftStart(e.target.value)} />
      </div>
    </div>
  );
}
