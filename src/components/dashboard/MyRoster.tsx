'use client';

import * as React from 'react';
import { CalendarClock, Users } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useFetch } from '@/lib/hooks';
import { istNowWallClock } from '@/lib/utils';

/*
 * My Roster — dashboard right-rail widget, modelled on UpcomingEvents.tsx
 * (same Card shape, self-contained fetch, fails soft). Data source:
 * GET /admin/roster/me?days=14 (see roster-api-contract.md). The endpoint
 * may 404 on a host without the Roster backend yet — useFetch leaves `data`
 * null on any error, so this widget quietly renders nothing rather than
 * taking the dashboard down with it.
 *
 * Dates are plain 'YYYY-MM-DD' strings (IST calendar days, not instants).
 * Labels are formatted via `new Date(ymd + 'T00:00:00')` — the same trick
 * UpcomingEvents' DatePill already uses — which parses as LOCAL time, never
 * `new Date(ymd)` alone (that parses as UTC midnight and can roll the day
 * back/forward a day depending on the viewer's offset).
 */

type RosterDay = {
  date: string;
  type: 'PR' | 'WO';
  shift: string | null;
  source: 'ROSTER' | 'WEEKLY';
  holiday: { name: string } | null;
};
type RosterTeam = {
  date: string;
  total: number;
  onDuty: number;
  weekOff: number;
  offToday: Array<{ userId: number; name: string }>;
};
type RosterMeResp = { days: RosterDay[]; nextWeekOff: string | null; team: RosterTeam | null };

function formatDayLabel(ymd: string): string {
  const d = new Date(ymd + 'T00:00:00');
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const dayMonth = d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
  return `${weekday} ${dayMonth}`;
}

const OFF_TODAY_VISIBLE = 3;

export function MyRoster() {
  const fetched = useFetch<RosterMeResp>('/admin/roster/me?days=14');
  const days = fetched.data?.days ?? [];
  const todayKey = istNowWallClock().slice(0, 10);
  const team = fetched.data?.team ?? null;
  const nextWeekOff = fetched.data?.nextWeekOff ?? null;

  // Fails soft: no data (endpoint missing/erroring) and not loading →
  // render nothing rather than an empty card taking up rail space.
  if (!fetched.loading && days.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">My Roster</h2>
        </div>

        {fetched.loading && (
          <div className="p-4 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-8 rounded bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {!fetched.loading && days.length > 0 && (
          <ul className="divide-y">
            {days.slice(0, 7).map((day) => {
              const isToday = day.date === todayKey;
              return (
                <li key={day.date} className="flex items-center justify-between gap-2 px-4 py-1.5 text-sm">
                  <span className={isToday ? 'font-medium' : 'text-muted-foreground'}>
                    {isToday ? `Today · ${formatDayLabel(day.date)}` : formatDayLabel(day.date)}
                  </span>
                  {day.holiday ? (
                    <span className="shrink-0 rounded-full bg-gold-strong dark:bg-gold-tint text-white text-xs font-medium px-2 py-0.5">
                      {day.holiday.name}
                    </span>
                  ) : day.type === 'PR' ? (
                    <span className="shrink-0 rounded-full bg-success-tint text-success-strong text-xs font-medium px-2 py-0.5">
                      Present{day.shift ? ` · ${day.shift}` : ''}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-warning-tint text-warning-strong text-xs font-medium px-2 py-0.5">
                      Week Off
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {nextWeekOff && (
          <div className="px-4 py-2 border-t text-xs text-muted-foreground">
            Next Week Off: <span className="font-medium text-foreground">{formatDayLabel(nextWeekOff)}</span>
          </div>
        )}

        {team && (
          <div className="px-4 py-3 border-t space-y-2">
            <div className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <h3 className="text-xs font-semibold">My Team Today</h3>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md bg-success-tint text-success-strong px-2 py-1.5 text-center">
                <div className="text-base font-semibold leading-tight">{team.onDuty}</div>
                <div className="text-xs">On Duty</div>
              </div>
              <div className="rounded-md bg-warning-tint text-warning-strong px-2 py-1.5 text-center">
                <div className="text-base font-semibold leading-tight">{team.weekOff}</div>
                <div className="text-xs">Week Off</div>
              </div>
            </div>
            {team.offToday.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Off Today: {team.offToday.slice(0, OFF_TODAY_VISIBLE).map((u) => u.name).join(', ')}
                {team.offToday.length > OFF_TODAY_VISIBLE && ` +${team.offToday.length - OFF_TODAY_VISIBLE} more`}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
