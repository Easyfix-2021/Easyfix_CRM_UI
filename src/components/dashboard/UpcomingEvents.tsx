'use client';

import * as React from 'react';
import { Calendar, Megaphone } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useFetch } from '@/lib/hooks';
import { NoticeDetailModal } from '@/components/notice/NoticeDetailModal';
import type { Holiday, Notice } from '@/lib/notice-types';

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
type NoticeResp = { items: Notice[] };

/*
 * The rail shows two kinds of thing on the same timeline: national holidays
 * (external, read-only) and NOTICES that carry an `event_date` — a notice about
 * a specific day (a celebration, a maintenance window). Ops asked for the two
 * together so "what's coming up" is one list rather than two places to look.
 *
 * A notice earns its place purely by having `event_date` set; there is no
 * guessing a date out of the title. See the Event Date field in ComposeWizard.
 */
type RailEntry =
  | { kind: 'holiday'; key: string; label: string; title?: string }
  | { kind: 'notice'; key: string; label: string; title?: string; notice: Notice };

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

/* Group dated entries by date. Returns ordered date keys + their entries. */
function groupByDate(items: Array<{ date: string; entry: RailEntry }>): Array<{ date: string; entries: RailEntry[] }> {
  const map = new Map<string, RailEntry[]>();
  for (const it of items) {
    const arr = map.get(it.date) || [];
    arr.push(it.entry);
    map.set(it.date, arr);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => ({ date, entries }));
}

/* Local YYYY-MM-DD. Deliberately NOT toISOString() — that converts to UTC and
 * would roll an IST evening back to the previous day, dropping today's events
 * out of the window. */
function localDateKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function UpcomingEvents({ days = 7 }: { days?: number }) {
  const fetched = useFetch<Resp>(`/admin/holidays/upcoming?days=${days}`);
  /*
   * SAME cache key the dashboard's NoticeStrip already uses, so this adds no
   * extra round-trip — lib/hooks dedupes and shares the response. The rail just
   * re-reads the notices that are already on the page.
   */
  const noticesFetched = useFetch<NoticeResp>('/admin/notices/active?surface=crm&limit=20');
  const [openNotice, setOpenNotice] = React.useState<Notice | null>(null);

  const holidayEntries = (fetched.data?.items ?? []).map((h) => ({
    date: h.date,
    entry: { kind: 'holiday' as const, key: `h-${h.date}-${h.name}`, label: h.name, title: h.description || h.name },
  }));

  /* Event notices inside the same window: today → today + `days`. Past events
   * drop off on their own the day after they happen. */
  const today = localDateKey(new Date());
  const horizon = (() => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return localDateKey(d);
  })();
  const noticeEntries = (noticesFetched.data?.items ?? [])
    .filter((n) => {
      if (!n.event_date) return false;
      const key = String(n.event_date).slice(0, 10);
      return key >= today && key <= horizon;
    })
    .map((n) => ({
      date: String(n.event_date).slice(0, 10),
      entry: { kind: 'notice' as const, key: `n-${n.notice_id}`, label: n.title, title: n.title, notice: n },
    }));

  const groups = groupByDate([...holidayEntries, ...noticeEntries]);

  return (
    /*
     * Flex-column layout so the scrollable event list claims the
     * vertical space left after the title bar — matching whatever
     * height the parent grid cell allocates. The dashboard pairs this
     * card with the 2×4 funnel-card grid on the left; with the
     * grid's default `items-stretch`, the parent cell now matches
     * the funnel grid's height and the list scrolls when events
     * exceed it. Removing the old `max-h-[500px]` cap on the inner
     * `ul` keeps the cap responsive to the actual cell height instead
     * of a fixed pixel number.
     */
    <Card className="h-full flex flex-col">
      <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
        <div className="px-4 py-3 border-b flex items-center gap-2 shrink-0">
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
            No Upcoming Events
            <div className="mt-1 opacity-70">
              Within the next {days} day{days === 1 ? '' : 's'}
            </div>
          </div>
        )}

        {!fetched.loading && groups.length > 0 && (
          <ul className="p-3 space-y-3 flex-1 min-h-0 overflow-y-auto">
            {groups.map((g) => (
              <li key={g.date} className="flex items-start gap-3">
                <DatePill date={g.date} />
                <div className="flex-1 min-w-0 space-y-1.5 pt-1">
                  {g.entries.map((e) => (
                    e.kind === 'notice' ? (
                      /* Event notices are sky + clickable — the colour split
                         tells ops at a glance which rows are ours (and
                         actionable) versus external holidays. */
                      <button
                        key={e.key}
                        type="button"
                        onClick={() => setOpenNotice(e.notice)}
                        className="w-full rounded-md bg-sky-600 hover:bg-sky-700 text-white px-3 py-2 text-[13px] font-medium shadow-sm flex items-center gap-2 text-left transition-colors"
                        title={e.title}
                      >
                        <Megaphone className="h-3.5 w-3.5 shrink-0 opacity-80" />
                        <span className="truncate">{e.label}</span>
                      </button>
                    ) : (
                      <div
                        key={e.key}
                        className="rounded-md bg-emerald-600 text-white px-3 py-2 text-[13px] font-medium shadow-sm flex items-center gap-2"
                        title={e.title}
                      >
                        <Calendar className="h-3.5 w-3.5 shrink-0 opacity-80" />
                        <span className="truncate">{e.label}</span>
                      </div>
                    )
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Clicking an event notice opens the same themed card the rest of the
          CRM uses; onRead refreshes the shared active-notices key so the
          strip's unread counter clears at the same time. */}
      <NoticeDetailModal
        notice={openNotice}
        open={openNotice !== null}
        onClose={() => setOpenNotice(null)}
        onRead={() => noticesFetched.refetch()}
      />
    </Card>
  );
}
