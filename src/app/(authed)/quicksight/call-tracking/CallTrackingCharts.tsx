'use client';

/*
 * Graphical View for the QuickSight Call Tracking report.
 *
 * ⚠ THE CHARTS FOLLOW THE ACTIVE TAB, AND THE SERVER DECIDES WHAT THAT MEANS.
 *
 * This file used to aggregate everything itself out of the summary's `byUser`
 * rows. That had one population baked in — every call with a real caller — no
 * matter which table was on screen. An operator on the Inbound tab read a donut
 * and a trend built mostly from outbound job calls, with KPI tiles counting the
 * whole window: the picture and the rows under it were answering different
 * questions, and nothing on screen said so.
 *
 * The aggregates now come from POST /call-tracking/charts, which recomputes them
 * over the tab's own calls (see GRAIN_SCOPE in the service). Doing it there and
 * not here is not a preference:
 *   - `parties` and `steps` are per-CALL derivations. PARTY_ROLE compares the
 *     dialled number against the numbers on the job; the step is a per-row
 *     snapshot. The summary only ever carries them PRE-SUMMED against grains
 *     that no longer match the tab, so re-slicing them in the browser would mean
 *     re-deriving them from data that isn't in the response.
 *   - The row caps are gone and /summary is now a very large payload. A tab
 *     click must not refetch it to move a donut. /charts answers in kilobytes.
 *
 * So this file is pure presentation: it formats, it does not aggregate. The one
 * thing it still computes is `shortName`, which is typography.
 *
 * ⚠ COLOUR COLLISIONS: QS_COLORS[1..4] are byte-identical to
 * QS_SEMANTIC.good/warn/bad/info. The metric colours below are pinned once and
 * reused across every chart so a tile and its series always agree, and so no two
 * series in one chart can resolve to the same hex (the
 * local/no-duplicate-chart-series-color lint rule enforces that).
 */

import { PhoneCall, PhoneForwarded, Percent, Briefcase, Users, Timer } from 'lucide-react';

import {
  ChartCard, QsBarChart, QsDonut, QsLineChart, QsKpiTile, QS_COLORS, QS_SEMANTIC,
} from '@/components/quicksight/charts';

import { fmtTalkTime } from './duration';

/* The wire shape of POST /admin/quicksight/call-tracking/charts. */
export type ChartsTotals = {
  calls: number; connected: number; connectRate: number;
  totalDurationSecs: number; avgDurationSecs: number | null;
  uniqueJobs: number; uniqueCallers: number;
};
export type ChartsData = {
  grain: string;
  totals: ChartsTotals;
  byDay: Array<{ day: string; calls: number; connected: number; uniqueJobs: number }>;
  parties: Array<{ name: string; value: number }>;
  steps: Array<{ name: string; calls: number }>;
  callers: Array<{ name: string; calls: number; connected: number }>;
};

/*
 * What each donut slice in "Calls By Party" actually means.
 *
 * The backend derives the role by comparing the last 10 digits of the number
 * dialled against the four numbers hanging off the job, in this priority order
 * (services/quicksight/quicksight-call-tracking.service.js, PARTY_ROLE):
 *   customer_mob_no → additional_number → client_spoc → efr_no
 * falling back to two JOB-FREE arms (a customer matched by id AND number, then a
 * technician matched by number) for calls with no job attached. The labels below
 * must stay in step with that CASE.
 *
 * "Other" is the one operators query, and the honest definition is a negative:
 * the dialled number matched NONE of them (or was unusable).
 */
const PARTY_ROLE_HELP: Record<string, string> = {
  Customer: 'The customer number on the job (customer_mob_no) — or, on a call with no job, a customer whose id AND number both match.',
  Alternate: 'The job’s alternate contact number (additional_number).',
  'Client SPOC': 'The client’s single point of contact for the job (client_spoc).',
  Technician: 'The assigned technician’s number (efr_no) — or, on a call with no job, any technician whose number matches.',
  Other: 'The number dialled matched nothing we hold — e.g. the customer changed their number after the call, or that field was empty at the time. Open the count to see the name captured at call time.',
};

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
  data, loading, scopeLabel,
}: {
  data: ChartsData | null;
  /* True while the tab's aggregates are in flight. The previous tab's charts
     stay on screen, dimmed, rather than blanking — a flash of empty cards on
     every tab click reads as "no data", which is a different claim. */
  loading: boolean;
  /* The active tab's label, so the caption states what is being charted. */
  scopeLabel: string;
}) {
  // Nothing to draw — the report's own empty state already covers it.
  if (!data || data.totals.calls === 0) return null;

  const { totals } = data;
  const trend = data.byDay.map((d) => ({
    /*
     * Series keys are single lowercase words on purpose: the chart kit builds an
     * SVG gradient id from the key (`url(#qsarea-<key>)`), and a key containing
     * a space produces an invalid reference and an unfilled area.
     */
    day: fmtDayLabel(d.day),
    calls: d.calls,
    connected: d.connected,
    jobs: d.uniqueJobs,
  }));
  const callers = data.callers.map((c) => ({ ...c, name: shortName(c.name) }));

  return (
    <section className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink-900">Graphical View</h2>
        {/*
          * Naming the scope is not a nicety. These numbers no longer match the
          * window totals in the band below, and an unlabelled chart that
          * disagrees with the tile beside it reads as a bug.
          */}
        <span className="text-xs text-muted-foreground">
          {loading ? 'Updating…' : <>Current Filters · <span className="font-medium text-ink-700">{scopeLabel}</span> Only</>}
        </span>
      </div>

      {/* KPI row — the TAB's totals, straight off /charts. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <QsKpiTile label="Total Calls" value={fmt(totals.calls)} accent={C_CALLS} icon={<PhoneCall size={18} />} />
        <QsKpiTile label="Connected" value={fmt(totals.connected)} accent={C_CONNECTED} icon={<PhoneForwarded size={18} />} />
        <QsKpiTile label="Connect %" value={`${totals.connectRate}%`} accent={QS_COLORS[6]} icon={<Percent size={18} />} />
        <QsKpiTile label="Jobs Called On" value={fmt(totals.uniqueJobs)} accent={C_JOBS} icon={<Briefcase size={18} />} />
        {/*
          * Callers excludes the caller_id 0 sentinel, so on the Inbound tab this
          * correctly reads 0: nobody here placed those calls. A DISTINCT over the
          * raw column counted the sentinel as a person.
          */}
        <QsKpiTile label="Callers" value={fmt(totals.uniqueCallers)} accent={QS_COLORS[5]} icon={<Users size={18} />} />
        <QsKpiTile
          label={`Talk Time · Avg ${fmtTalkTime(totals.avgDurationSecs)}`}
          value={fmtTalkTime(totals.totalDurationSecs)}
          accent={C_STEPS}
          icon={<Timer size={18} />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {trend.length > 0 && (
          <ChartCard
            title="Calls Per Day"
            subtitle={`${scopeLabel} — Calls, Connected Calls And Distinct Jobs Called On, Oldest To Newest`}
            className="md:col-span-2"
          >
            <QsLineChart
              data={trend}
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

        {data.parties.length > 0 && (
          <ChartCard title="Calls By Party" subtitle="Who Was On The Other End Of The Call">
            {/* Default QS_COLORS rotation — role count is small and the palette's
                first N hues are already mutually distinct. */}
            <QsDonut data={data.parties} nameKey="name" valueKey="value" height={300} />
            {/* Legend key. Only roles PRESENT in this tab's window are listed, so
                it never describes a colour that isn't on the chart. */}
            <dl className="mt-3 space-y-1 border-t border-border pt-2 text-xs leading-snug text-muted-foreground">
              {data.parties.map((p) => (
                <div key={p.name} className="flex gap-1.5">
                  <dt className="shrink-0 font-medium text-ink-700">{p.name}:</dt>
                  <dd>{PARTY_ROLE_HELP[p.name] ?? 'A number we hold for this call.'}</dd>
                </div>
              ))}
            </dl>
          </ChartCard>
        )}

        {/*
          * Absent on the Inbound tab BY CONSTRUCTION, not by accident: "top
          * callers" means people who PLACED calls, and nobody here placed an
          * inbound one. The server returns an empty array rather than one bar
          * crediting the no-caller sentinel.
          */}
        {callers.length > 0 && (
          <ChartCard title="Top Callers" subtitle={`Most Calls Placed — ${scopeLabel}`}>
            <QsBarChart
              data={callers}
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

        {/*
          * Job calls only, on every tab — "which step of the job lifecycle" has
          * no answer for a call with no job. The old client-side version folded
          * those into an 'Unknown' bar that was really "these had no job at all",
          * a bar named for our ignorance rather than for what it counted.
          */}
        {data.steps.length > 0 && (
          <ChartCard
            title="Calls By Job Status At Call"
            subtitle="Which Step Of The Job Lifecycle The Calls Were Made From"
            className="md:col-span-2"
          >
            <QsBarChart
              data={data.steps}
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
