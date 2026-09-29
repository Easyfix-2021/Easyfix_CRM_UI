'use client';

import * as React from 'react';
import { CalendarClock, Users } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useFetch } from '@/lib/hooks';
import { istNowWallClock } from '@/lib/utils';

/*
 * My Roster — dashboard full-width strip (own row above the cards), modelled on UpcomingEvents.tsx
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

/*
 * `count` days from today (7 on the dashboard, 14 on /profile), in a grid that
 * holds 7 per row at lg and wraps below. `showTeam` = the My Team Today block
 * (dashboard only — the profile page is about the viewer alone).
 */
export function MyRoster({ count = 7, showTeam = true }: { count?: number; showTeam?: boolean } = {}) {
  const fetched = useFetch<RosterMeResp>(`/admin/roster/me?days=${count}`);
  const days = fetched.data?.days ?? [];
  const todayKey = istNowWallClock().slice(0, 10);
  const team = showTeam ? fetched.data?.team ?? null : null;
  const nextWeekOff = fetched.data?.nextWeekOff ?? null;

  // Fails soft: no data (endpoint missing/erroring) and not loading →
  // render nothing rather than an empty card taking up rail space.
  if (!fetched.loading && days.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-3 flex flex-col lg:flex-row lg:items-stretch gap-3">
        {/* Own week — seven day tiles in a row; scrolls sideways on narrow
            screens instead of wrapping into a tall block. */}
        <div className="min-w-0 flex-1 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">My Roster</h2>
            </div>
            {nextWeekOff && (
              <span className="text-xs text-muted-foreground">
                Next Week Off: <span className="font-medium text-foreground">{formatDayLabel(nextWeekOff)}</span>
              </span>
            )}
          </div>

          {fetched.loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              {Array.from({ length: count }).map((_, i) => <div key={i} className="h-14 rounded-md bg-muted animate-pulse" />)}
            </div>
          ) : (
            <ul className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              {days.slice(0, count).map((day) => {
                const isToday = day.date === todayKey;
                const tone = day.holiday
                  ? 'bg-gold-strong dark:bg-gold-tint text-white'
                  : day.type === 'PR' ? 'bg-success-tint text-success-strong' : 'bg-warning-tint text-warning-strong';
                const status = day.holiday ? day.holiday.name : day.type === 'PR' ? 'Present' : 'Week Off';
                return (
                  <li
                    key={day.date}
                    title={day.holiday ? `${formatDayLabel(day.date)} · ${day.holiday.name}` : undefined}
                    className={`min-w-0 rounded-md border px-2 py-1.5 flex flex-col gap-1 ${isToday ? 'border-primary' : 'border-border'}`}
                  >
                    <span className={`text-xs ${isToday ? 'font-semibold' : 'text-muted-foreground'}`}>
                      {isToday ? 'Today' : formatDayLabel(day.date).split(' ')[0]} · {formatDayLabel(day.date).split(' ').slice(1).join(' ')}
                    </span>
                    <span className={`truncate rounded-full text-xs font-medium px-2 py-0.5 text-center ${tone}`}>
                      {status}{!day.holiday && day.type === 'PR' && day.shift ? ` · ${day.shift}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {team && (
          <div className="lg:w-72 shrink-0 lg:border-l lg:pl-3 border-t pt-3 lg:border-t-0 lg:pt-0 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">My Team Today</h3>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md bg-success-tint text-success-strong px-2 py-1 text-center">
                <div className="text-base font-semibold leading-tight">{team.onDuty}</div>
                <div className="text-xs">On Duty</div>
              </div>
              <div className="rounded-md bg-warning-tint text-warning-strong px-2 py-1 text-center">
                <div className="text-base font-semibold leading-tight">{team.weekOff}</div>
                <div className="text-xs">Week Off</div>
              </div>
            </div>
            {team.offToday.length > 0 && (
              <p className="text-xs text-muted-foreground truncate" title={team.offToday.map((u) => u.name).join(', ')}>
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
