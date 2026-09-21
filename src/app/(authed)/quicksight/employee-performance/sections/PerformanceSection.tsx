'use client';

/*
 * 8. Performance — Jobs Completion and Revenue Generation (dashboard
 * #weeklyjobs / #weeklyrev). The dashboard's "— Week by Week" suffix is left
 * off: both cards show totals for the whole selection, not weekly figures.
 *
 * The exact figures stay visible as MiniStats above each chart (the dashboard
 * printed them as text). The revenue donut is Revenue vs what is left of the
 * full-month target, i.e. the dashboard's capped progress bar
 * (performance.revenueBarPct) drawn as a ring.
 */

import { useMemo } from 'react';
import { ChartCard, QS_SEMANTIC, QsDonut } from '@/components/quicksight/charts';
import { money, num, pct1 } from '../format';
import { MiniStat, SectionCard, type SummaryProps } from './shared';

const CHART_HEIGHT = 240;
const JOB_COLORS = [QS_SEMANTIC.good, QS_SEMANTIC.warn];
const REVENUE_COLORS = [QS_SEMANTIC.good, QS_SEMANTIC.neutral];

function ChartEmpty({ children }: { children: string }) {
  return (
    <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height: CHART_HEIGHT }}>
      {children}
    </div>
  );
}

export function PerformanceSection({ summary }: SummaryProps) {
  const p = summary.performance;
  const achievedPct = summary.kpis.targetAchieved;

  const jobsData = useMemo(
    () => [
      { name: 'Completed', value: p.completed },
      { name: 'Open', value: p.open },
    ],
    [p.completed, p.open],
  );

  // Whole rupees, so the chart tooltip never shows float noise.
  const revenueData = useMemo(
    () => [
      { name: 'Revenue', value: Math.round(p.revenue) },
      { name: 'Short Of Target', value: Math.round(Math.max(p.target - p.revenue, 0)) },
    ],
    [p.revenue, p.target],
  );

  return (
    <SectionCard title="8. Performance">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ChartCard title="Jobs Completion" subtitle="Completed Vs Open Jobs" className="shadow-none">
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <MiniStat label="Total Jobs" value={num(p.totalJobs)} />
              <MiniStat label="Completed" value={num(p.completed)} />
              <MiniStat label="Open" value={num(p.open)} />
            </div>
            {p.completed > 0 || p.open > 0 ? (
              <QsDonut data={jobsData} nameKey="name" valueKey="value" height={CHART_HEIGHT} colors={JOB_COLORS} />
            ) : (
              <ChartEmpty>No Jobs For The Selected Filters</ChartEmpty>
            )}
          </div>
        </ChartCard>

        <ChartCard title="Revenue Generation" subtitle="Revenue Vs Full-Month Target" className="shadow-none">
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <MiniStat label="Revenue" value={money(p.revenue)} />
              <MiniStat label="Target" value={money(p.target)} />
              <MiniStat label="Achieved" value={pct1(achievedPct)} />
            </div>
            {p.revenue > 0 || p.target > 0 ? (
              <QsDonut data={revenueData} nameKey="name" valueKey="value" height={CHART_HEIGHT} colors={REVENUE_COLORS} />
            ) : (
              <ChartEmpty>No Revenue For The Selected Filters</ChartEmpty>
            )}
          </div>
        </ChartCard>
      </div>
    </SectionCard>
  );
}
