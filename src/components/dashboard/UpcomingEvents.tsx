'use client';

import * as React from 'react';
import { Calendar } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useFetch } from '@/lib/hooks';
import type { Holiday } from '@/lib/notice-types';

/*
 * Upcoming Events rail — right column of the dashboard. Lists national
 * holidays falling in the next 7 days, grouped by date.
 *
 * Data source: /admin/holidays/upcoming?days=7, served by Nager.Date
 * with a 24h in-memory cache on the BE. Failure path = empty list +
 * empty-state message (BE returns `degraded: true` so we can surface
 * the cause, but we keep the UI quiet — operators don't need to debug
 * external APIs).
 *
 * Visual model (spec wireframe):
 *   ╭─────╮ ╔════════════════════════╗
 *   │ FRI │ ║ 🎉  Diwali             ║
 *   │22 May│╚════════════════════════╝
 *   ╰─────╯
 *   ╭─────╮ ╔════════════════════════╗
 *   │ MON │ ║ ⚠️ Eid-ul-Zuha (Restri…║
 *   │25 May│╚════════════════════════╝
 *
 * Date pill on the left, holiday cards on the right. v1 = holidays only;
 * birthdays / SLA deadlines deferred per plan.
 */

type Resp = { items: Holiday[]; degraded?: boolean };

/* Day-name pill — small circle with WEEKDAY · DD MONTH */
function DatePill({ date }: { date: string }) {
  const d = new Date(date + 'T00:00:00');
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const dayMonth = d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
  return (
    <div className="h-14 w-14 shrink-0 rounded-full bg-sky-500 text-white flex flex-col items-center justify-center text-[10px] font-semibold leading-tight">
      <span>{weekday}</span>
      <span className="text-[11px] font-bold">{dayMonth}</span>
    </div>
  );
}

/* Group holidays by date. Returns ordered date keys + their entries. */
function groupByDate(items: Holiday[]): Array<{ date: string; entries: Holiday[] }> {
  const map = new Map<string, Holiday[]>();
  for (const h of items) {
    const arr = map.get(h.date) || [];
    arr.push(h);
    map.set(h.date, arr);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => ({ date, entries }));
}

export function UpcomingEvents({ days = 7 }: { days?: number }) {
  const fetched = useFetch<Resp>(`/admin/holidays/upcoming?days=${days}`);
  const items = fetched.data?.items ?? [];
  const groups = groupByDate(items);

  return (
    <Card className="h-full">
      <CardContent className="p-0">
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Upcoming Events</h2>
        </div>

        {fetched.loading && (
          <div className="p-4 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="h-14 w-14 rounded-full bg-muted animate-pulse" />
                <div className="flex-1 h-9 rounded bg-muted animate-pulse" />
              </div>
            ))}
          </div>
        )}

        {!fetched.loading && groups.length === 0 && (
          <div className="p-6 text-center text-xs text-muted-foreground">
            No Upcoming Holidays
            <div className="mt-1 opacity-70">
              Within the next {days} day{days === 1 ? '' : 's'}
            </div>
          </div>
        )}

        {!fetched.loading && groups.length > 0 && (
          <ul className="p-3 space-y-3 max-h-[500px] overflow-y-auto">
            {groups.map((g) => (
              <li key={g.date} className="flex items-start gap-3">
                <DatePill date={g.date} />
                <div className="flex-1 min-w-0 space-y-1.5 pt-1">
                  {g.entries.map((h, i) => (
                    <div
                      key={`${h.name}-${i}`}
                      className="rounded-md bg-emerald-600 text-white px-3 py-2 text-[13px] font-medium shadow-sm flex items-center gap-2"
                      title={h.description || h.name}
                    >
                      <Calendar className="h-3.5 w-3.5 shrink-0 opacity-80" />
                      <span className="truncate">{h.name}</span>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
