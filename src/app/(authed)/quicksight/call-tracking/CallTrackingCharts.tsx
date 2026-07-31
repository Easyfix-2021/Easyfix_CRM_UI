'use client';

/*
 * Graphical View for the QuickSight Call Tracking report.
 *
 * Pure presentation — every array is derived (with useMemo) from the SAME
 * /call-tracking/summary response the page already fetched. No extra API calls,
 * and only the shared QuickSight chart kit is used so this report reads as part
 * of the same family as the other native reports.
 *
 * Layout mirrors TechnicianPerformanceCharts / RegionPerformanceCharts:
 * "Graphical View" heading + a caption, a KPI tile row, then a 2-column chart
 * grid.
 *
 * ⚠ WHY THE BREAKDOWNS ARE AGGREGATED FROM byUser, NOT byJob
 * A call row can have a NULL job (an outbound call placed before it was tied to
 * a job). Such a call appears in byUser but has no byJob row, so summing
 * byJob[].parties / byJob[].steps would silently under-count and the donut would
 * disagree with the "Total Calls" tile. byUser is the grain that covers every
 * call, so the party + step breakdowns are summed from there.
 *
 * ⚠ PERCENTAGES ARE RECOMPUTED FROM SUMMED COUNTS, never averaged across rows —
 * averaging per-row connect rates would weight a 1-call day the same as a
 * 200-call day. The API returns raw `connected` counts precisely so this file
 * can divide sums.
 *
 * ⚠ COLOUR COLLISIONS: QS_COLORS[1..4] are byte-identical to
 * QS_SEMANTIC.good/warn/bad/info. The metric colours below are pinned once and
 * reused across every chart so a tile and its series always agree, and so no two
 * series in one chart can resolve to the same hex (the
 * local/no-duplicate-chart-series-color lint rule enforces that).
 */

import { useMemo } from 'react';
import { PhoneCall, PhoneForwarded, Percent, Briefcase, Users, Timer } from 'lucide-react';

import {
  ChartCard, QsBarChart, QsDonut, QsLineChart, QsKpiTile, QS_COLORS, QS_SEMANTIC,
} from '@/components/quicksight/charts';

import { fmtTalkTime } from './duration';

/*
 * Structural prop types — deliberately the MINIMUM this component reads, not a
 * copy of the page's full wire types. The page's richer row types are
 * structurally assignable, so the contract stays in one place (page.tsx) while
 * this module keeps zero coupling to the fields it never touches.
 */
type Totals = {
  calls: number; uniqueJobs: number; uniqueCallers: number;
  connected: number; connectRate: number;
  totalDurationSecs: number; avgDurationSecs: number | null;
};
type Party = { role: string; calls: number };
type Step = { status: number; label: string; calls: number };
type Day = { day: string; calls: number; connected: number; uniqueJobs: number };
type UserDay = {
  userId: number | null; userName: string;
  calls: number; connected: number;
  parties: Party[]; steps: Step[];
};

/* Keep the charts legible — past ~10 categories labels and slices collide. */
const TOP_N = 10;

/*
 * ONE colour per METRIC, shared by the tiles and every series that plots it.
 *   C_CALLS      indigo   — QS_COLORS[0], not aliased by any QS_SEMANTIC key
 *   C_CONNECTED  emerald  — the semantic "good" (a connected call IS the good
 *                           outcome, so the meaning palette is the right source)
 *   C_JOBS       sky      — QS_COLORS[4]; never drawn beside QS_SEMANTIC.info
 *                           (same hex) in any array below
 *   C_STEPS      orange   — QS_COLORS[7], single-series only
 */
const C_CALLS = QS_COLORS[0];
const C_CONNECTED = QS_SEMANTIC.good;
const C_JOBS = QS_COLORS[4];
const C_STEPS = QS_COLORS[7];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* 'YYYY-MM-DD' → "3 Jul" for an axis tick, built from parts (no Date/TZ math). */
function fmtDayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1] ?? ''}`;
}
const fmt = (n: number) => n.toLocaleString('en-IN');
/* Shorten long caller names so the horizontal bar axis stays readable. */
const shortName = (name: string) => (name.trim().length > 18 ? `${name.trim().slice(0, 17)}…` : name.trim());

export function CallTrackingCharts({
  totals, byDay, byUser,
}: {
  totals: Totals | undefined;
  byDay: Day[];
  byUser: UserDay[];
}) {
  const charts = useMemo(() => {
    /*
     * Daily trend — byDay is already gap-filled server-side and ordered
     * oldest → newest, so it maps straight onto a left-to-right time axis.
     *
     * Series keys are single lowercase words on purpose: the chart kit builds an
     * SVG gradient id from the key (`url(#qsarea-<key>)`), and a key containing a
     * space produces an invalid reference and an unfilled area. Display names
     * come from `label`.
     */
    const trend = byDay.map((d) => ({
      day: fmtDayLabel(d.day),
      calls: d.calls,
      connected: d.connected,
      jobs: d.uniqueJobs,
    }));

    // Party roles ("to whom") across every call in the window.
    const partyTotals = new Map<string, number>();
    // Job status at the moment of the call ("at which step").
    const stepTotals = new Map<string, number>();
    // Calls per CALLER — byUser is (day × user), so days collapse by identity.
    const callerTotals = new Map<string, { name: string; calls: number; connected: number }>();

    for (const r of byUser) {
      for (const p of r.parties) partyTotals.set(p.role, (partyTotals.get(p.role) ?? 0) + p.calls);
      for (const s of r.steps) stepTotals.set(s.label, (stepTotals.get(s.label) ?? 0) + s.calls);
      // userId is null for a call whose caller could not be resolved; key on the
      // name so those collapse into one "unknown caller" bar instead of N bars.
      const key = r.userId == null ? `name:${r.userName}` : `id:${r.userId}`;
      const acc = callerTotals.get(key) ?? { name: r.userName, calls: 0, connected: 0 };
      acc.calls += r.calls;
      acc.connected += r.connected;
      callerTotals.set(key, acc);
    }

    const parties = [...partyTotals.entries()]
      .map(([name, value]) => ({ name, value }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);

    const steps = [...stepTotals.entries()]
      .map(([name, calls]) => ({ name, calls }))
      .filter((d) => d.calls > 0)
      .sort((a, b) => b.calls - a.calls)
      .slice(0, TOP_N);

    const callers = [...callerTotals.values()]
      .sort((a, b) => b.calls - a.calls)
      .slice(0, TOP_N)
      .map((c) => ({ name: shortName(c.name), calls: c.calls, connected: c.connected }));

    return { trend, parties, steps, callers };
  }, [byDay, byUser]);

  // Nothing to draw — the report's own empty state already covers it.
  if (!totals || totals.calls === 0) return null;

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-slate-800">Graphical View</h2>
        <span className="text-xs text-muted-foreground">Charts reflect the current filters.</span>
      </div>

      {/* KPI row — window totals straight off the API (no client re-derivation). */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <QsKpiTile label="Total Calls" value={fmt(totals.calls)} accent={C_CALLS} icon={<PhoneCall size={18} />} />
        <QsKpiTile label="Connected" value={fmt(totals.connected)} accent={C_CONNECTED} icon={<PhoneForwarded size={18} />} />
        <QsKpiTile label="Connect %" value={`${totals.connectRate}%`} accent={QS_COLORS[6]} icon={<Percent size={18} />} />
        <QsKpiTile label="Jobs Called On" value={fmt(totals.uniqueJobs)} accent={C_JOBS} icon={<Briefcase size={18} />} />
        <QsKpiTile label="Callers" value={fmt(totals.uniqueCallers)} accent={QS_COLORS[5]} icon={<Users size={18} />} />
        <QsKpiTile
          label={`Talk Time · Avg ${fmtTalkTime(totals.avgDurationSecs)}`}
          value={fmtTalkTime(totals.totalDurationSecs)}
          accent={C_STEPS}
          icon={<Timer size={18} />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {charts.trend.length > 0 && (
          <ChartCard
            title="Calls Per Day"
            subtitle="Calls, Connected Calls And Distinct Jobs Called On — Oldest To Newest"
            className="md:col-span-2"
          >
            <QsLineChart
              data={charts.trend}
              xKey="day"
              area
              height={300}
              series={[
                { key: 'calls', label: 'Calls', color: C_CALLS },
                { key: 'connected', label: 'Connected', color: C_CONNECTED },
                { key: 'jobs', label: 'Unique Jobs', color: C_JOBS },
              ]}
            />
          </ChartCard>
        )}

        {charts.parties.length > 0 && (
          <ChartCard title="Calls By Party" subtitle="Who Was On The Other End Of The Call">
            {/* Default QS_COLORS rotation — role count is small and the palette's
                first N hues are already mutually distinct. */}
            <QsDonut data={charts.parties} nameKey="name" valueKey="value" height={300} />
          </ChartCard>
        )}

        {charts.callers.length > 0 && (
          <ChartCard title="Top Callers" subtitle={`Most Calls Placed — Top ${TOP_N}`}>
            <QsBarChart
              data={charts.callers}
              xKey="name"
              layout="vertical"
              height={300}
              series={[
                { key: 'calls', label: 'Calls', color: C_CALLS },
                { key: 'connected', label: 'Connected', color: C_CONNECTED },
              ]}
            />
          </ChartCard>
        )}

        {charts.steps.length > 0 && (
          <ChartCard
            title="Calls By Job Status At Call"
            subtitle="Which Step Of The Job Lifecycle The Calls Were Made From"
            className="md:col-span-2"
          >
            <QsBarChart
              data={charts.steps}
              xKey="name"
              height={300}
              series={[{ key: 'calls', label: 'Calls', color: C_STEPS }]}
            />
          </ChartCard>
        )}
      </div>
    </section>
  );
}
