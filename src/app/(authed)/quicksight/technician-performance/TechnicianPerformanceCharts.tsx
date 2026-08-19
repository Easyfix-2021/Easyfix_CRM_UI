'use client';

/*
 * Graphical View for the Technician Performance report.
 *
 * Pure presentation — derives every chart array (with useMemo) from the SAME
 * paginated rows the page already fetched. No new API calls. Uses ONLY the
 * shared QuickSight chart kit so this report stays visually consistent with
 * the other 10 native reports.
 *
 * Each technician row carries 3 period blocks; the "latest" period is the
 * FIRST entry of technicianPerformanceDataDateWise (matching the table's
 * left-to-right block order). Per-technician charts use that latest block so
 * the visuals line up with the leftmost numeric columns in the table.
 */

import { useMemo } from 'react';
import { Ticket, CheckCircle2, Layers, UserCheck } from 'lucide-react';
import {
  ChartCard,
  QsBarChart,
  QsDonut,
  QsKpiTile,
  QS_COLORS,
  QS_SEMANTIC,
} from '@/components/quicksight/charts';

type PeriodDateWise = {
  txTktCreated: number;
  txOpenOrder: number;
  txSdaPercentage: number | null;
  txTatPercentage: number | null;
  txCancelOrder: number;
  txSdaCount: number;
  txCompletedOrder: number;
  workedOrder: number;
  detailsFor: string;
  startDate: string;
  endDate: string;
};

type TechnicianRow = {
  txId: number | null;
  txName: string;
  txCity: string;
  stateName: string;
  txStatus: '0' | '1';
  txCurrentBalance: number;
  txTodayAttendance: string;
  txTomAttendance: string;
  technicianPerformanceDataDateWise: PeriodDateWise[];
};

const TOP_N = 8;

/* Shorten "Name - 123" style labels so bar axes stay readable. */
function shortName(name: string): string {
  const n = name.trim();
  return n.length > 18 ? `${n.slice(0, 17)}…` : n;
}

/* Map an attendance code to a friendly Title-Case bucket. */
function attBucket(code: string): 'Present' | 'Leave' | 'Absent' {
  if (code === 'P') return 'Present';
  if (code === 'L') return 'Leave';
  return 'Absent';
}

export function TechnicianPerformanceCharts({
  rows,
  periodLabel,
}: {
  rows: TechnicianRow[];
  /* Human label for the latest period block (drives the subtitle). */
  periodLabel: string;
}) {
  // Real technicians only (drop the synthetic txId=null "No Technician" row).
  const techs = useMemo(() => rows.filter((r) => r.txId != null), [rows]);

  // Latest period (first block) per technician + page-wide totals.
  const { kpis, ticketBars, qualityBars, attendance } = useMemo(() => {
    let totalTickets = 0;
    let totalCompleted = 0;
    let totalOpen = 0;
    let activeCount = 0;

    const withLatest = techs.map((t) => {
      const p = t.technicianPerformanceDataDateWise[0];
      const tickets = p?.txTktCreated ?? 0;
      const completed = p?.txCompletedOrder ?? 0;
      const open = p?.txOpenOrder ?? 0;
      totalTickets += tickets;
      totalCompleted += completed;
      totalOpen += open;
      if (t.txStatus === '1') activeCount += 1;
      return {
        name: shortName(t.txName),
        tickets,
        completed,
        open,
        sda: p?.txSdaPercentage,
        tat: p?.txTatPercentage,
      };
    });

    // Top-N by Tickets Assigned (descending), horizontal bars.
    const ticketBars = [...withLatest]
      .sort((a, b) => b.tickets - a.tickets)
      .slice(0, TOP_N)
      .map((t) => ({ name: t.name, tickets: t.tickets, completed: t.completed }));

    // Top-N by SDA% (those that have a value), grouped SDA% vs TAT%.
    const qualityBars = [...withLatest]
      .filter((t) => t.sda != null || t.tat != null)
      .sort((a, b) => (b.sda ?? 0) - (a.sda ?? 0))
      .slice(0, TOP_N)
      .map((t) => ({ name: t.name, sda: t.sda ?? 0, tat: t.tat ?? 0 }));

    // Today's attendance distribution (Present / Leave / Absent).
    const counts: Record<'Present' | 'Leave' | 'Absent', number> = {
      Present: 0,
      Leave: 0,
      Absent: 0,
    };
    techs.forEach((t) => {
      counts[attBucket(t.txTodayAttendance)] += 1;
    });
    const attendance = (['Present', 'Leave', 'Absent'] as const)
      .map((k) => ({ name: k, value: counts[k] }))
      .filter((d) => d.value > 0);

    const kpis = {
      technicians: techs.length,
      activeCount,
      totalTickets,
      totalCompleted,
      totalOpen,
    };

    return { kpis, ticketBars, qualityBars, attendance };
  }, [techs]);

  // Nothing meaningful to chart — render nothing (the table still shows below).
  if (techs.length === 0) return null;

  // Attendance donut colors keyed to semantic meaning (green/amber/red).
  const ATT_COLORS: Record<string, string> = {
    Present: QS_SEMANTIC.good,
    Leave: QS_SEMANTIC.warn,
    Absent: QS_SEMANTIC.bad,
  };
  const attendanceColors = attendance.map((d) => ATT_COLORS[d.name] ?? QS_COLORS[0]);

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink-900">Graphical View</h2>
        <span className="text-xs text-muted-foreground">Charts reflect the current page.</span>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <QsKpiTile
          label="Technicians (Active)"
          value={`${kpis.technicians} (${kpis.activeCount})`}
          accent={QS_COLORS[0]}
          icon={<UserCheck size={18} />}
        />
        <QsKpiTile
          label="Tickets Assigned"
          value={kpis.totalTickets.toLocaleString('en-IN')}
          accent={QS_COLORS[4]}
          icon={<Ticket size={18} />}
        />
        <QsKpiTile
          label="Completed Orders"
          value={kpis.totalCompleted.toLocaleString('en-IN')}
          accent={QS_SEMANTIC.good}
          icon={<CheckCircle2 size={18} />}
        />
        <QsKpiTile
          label="Open Orders In App"
          value={kpis.totalOpen.toLocaleString('en-IN')}
          accent={QS_SEMANTIC.warn}
          icon={<Layers size={18} />}
        />
      </div>

      {/* Chart grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {ticketBars.length > 0 && (
          <ChartCard
            title="Top Technicians By Tickets Assigned"
            subtitle={`Latest Period — ${periodLabel}`}
          >
            <QsBarChart
              data={ticketBars}
              xKey="name"
              layout="vertical"
              height={300}
              series={[
                { key: 'tickets', label: 'Tickets Assigned', color: QS_COLORS[0] },
                { key: 'completed', label: 'Completed Orders', color: QS_SEMANTIC.good },
              ]}
            />
          </ChartCard>
        )}

        {attendance.length > 0 && (
          <ChartCard
            title="Today's Attendance"
            subtitle="Present / Leave / Absent Across The Current Page"
          >
            <QsDonut
              data={attendance}
              nameKey="name"
              valueKey="value"
              height={300}
              colors={attendanceColors}
            />
          </ChartCard>
        )}

        {qualityBars.length > 0 && (
          <ChartCard
            title="SDA% Vs TAT% By Technician"
            subtitle={`Top By SDA% — Latest Period — ${periodLabel}`}
            className="md:col-span-2"
          >
            <QsBarChart
              data={qualityBars}
              xKey="name"
              height={300}
              series={[
                { key: 'sda', label: 'SDA%', color: QS_COLORS[5] },
                { key: 'tat', label: 'TAT%', color: QS_COLORS[6] },
              ]}
            />
          </ChartCard>
        )}
      </div>
    </section>
  );
}
