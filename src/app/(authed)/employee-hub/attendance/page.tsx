'use client';

/*
 * Employee Hub → Attendance & Leaves — a self-service month calendar plus
 * the Request Leave flow. Every CRM user gets this page (no action-key
 * gate — see the leave-contract note "NO action-key gate on /admin/leave").
 *
 * "Present" here is PLANNED present from the roster, never a punch feed.
 * Layout: calendar (2/3) beside My Requests (1/3) on lg+, stacked below.
 */

import { useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarClock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { addMonthsYmd, istTodayYmd } from '@/components/roster/roster-dates';
import { LeaveCalendar, LeaveCalendarLegend } from '@/components/employee-hub/LeaveCalendar';
import { RequestLeaveDialog } from '@/components/employee-hub/RequestLeaveDialog';
import { MyRequestsTable } from '@/components/employee-hub/MyRequestsTable';
import type { LeaveMeResponse } from '@/components/employee-hub/leave-types';

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-3 text-center">
        <div className="text-xl font-semibold tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

export default function AttendancePage() {
  const [month, setMonth] = useState(() => istTodayYmd().slice(0, 7));
  const [requestOpen, setRequestOpen] = useState(false);

  const { data, loading, error, refetch } = useFetch<LeaveMeResponse>(`/admin/leave/me?month=${month}`);

  function nav(dir: 1 | -1) {
    setMonth((m) => addMonthsYmd(`${m}-01`, dir).slice(0, 7));
  }
  function refreshAll() {
    invalidateFetch((k) => k.startsWith('/admin/leave'));
    refetch();
  }

  const summary = data?.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <CalendarClock className="size-6" /> Attendance & Leaves
          </h1>
          <p className="text-sm text-muted-foreground">Your monthly attendance, and requesting leave.</p>
        </div>
        <Button onClick={() => setRequestOpen(true)}>Request Leave</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2">
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Button variant="outline" size="sm" onClick={() => nav(-1)} aria-label="Previous Month">
                <ChevronLeft className="size-4" />
              </Button>
              <div className="text-sm font-semibold">{MONTH_LONG[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}</div>
              <Button variant="outline" size="sm" onClick={() => nav(1)} aria-label="Next Month">
                <ChevronRight className="size-4" />
              </Button>
            </div>

            {error && <p className="text-sm text-urgent-strong">{error}</p>}

            <LeaveCalendar days={data?.days ?? []} today={data?.today ?? istTodayYmd()} loading={loading} />
            <LeaveCalendarLegend />
          </CardContent>
        </Card>

        <div className="min-w-0">
          <MyRequestsTable requests={data?.requests ?? []} loading={loading} onChanged={refreshAll} />
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <SummaryCard label="Total Days" value={summary.totalDays} />
          <SummaryCard label="Elapsed" value={summary.elapsed} />
          <SummaryCard label="Present" value={summary.plannedPresent} />
          <SummaryCard label="Leaves" value={summary.leaves} />
          <SummaryCard label="Week Offs & Holidays" value={summary.weekOffsAndHolidays} />
        </div>
      )}

      <RequestLeaveDialog
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        rules={data?.rules ?? null}
        onCreated={refreshAll}
      />
    </div>
  );
}
