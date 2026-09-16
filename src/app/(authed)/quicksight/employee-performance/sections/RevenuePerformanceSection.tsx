'use client';

/*
 * 1. Revenue Performance — the daily revenue table and, beside it, the small
 * Productivity table (dashboard #revtable / #revProd). Both are date-wise and
 * bounded by the snapshot's dates, so they scroll instead of paging. Side by
 * side from 2xl (together they need ~1,050px at CRM density), stacked below.
 */

import type { DailyRevenueRow, ProductivityRow } from '../types';
import { fmtDay, hours2, money, num, pct1 } from '../format';
import { LocalTable, SectionCard, SubHeading, type Column, type SummaryProps } from './shared';

const REVENUE_COLUMNS: ReadonlyArray<Column<DailyRevenueRow>> = [
  { key: 'date', label: 'Date', render: (r) => fmtDay(r.date) },
  { key: 'target', label: 'Target', align: 'right', render: (r) => money(r.target) },
  { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => money(r.revenue) },
  { key: 'completed', label: 'Closed Jobs', align: 'right', render: (r) => num(r.completed) },
  { key: 'pct', label: '% Achieved', align: 'right', render: (r) => pct1(r.pct) },
  { key: 'due', label: 'Due', align: 'right', render: (r) => money(r.due) },
];

const PRODUCTIVITY_COLUMNS: ReadonlyArray<Column<ProductivityRow>> = [
  { key: 'date', label: 'Date', render: (r) => fmtDay(r.date) },
  { key: 'working', label: 'Working Hrs', align: 'right', render: (r) => hours2(r.working) },
  { key: 'productive', label: 'Productive Hrs', align: 'right', render: (r) => hours2(r.productive) },
  { key: 'positive', label: 'Positive Productivity', align: 'right', render: (r) => num(r.positive) },
];

export function RevenuePerformanceSection({ summary }: SummaryProps) {
  return (
    <SectionCard title="1. Revenue Performance">
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <SubHeading>Daily Revenue</SubHeading>
          <LocalTable
            rows={summary.daily}
            columns={REVENUE_COLUMNS}
            rowKey={(r) => r.date}
            emptyText="No Data For The Selected Filters"
            scroll
          />
        </div>
        <div className="min-w-0 space-y-2">
          <SubHeading>Productivity</SubHeading>
          <LocalTable
            rows={summary.productivity}
            columns={PRODUCTIVITY_COLUMNS}
            rowKey={(r) => r.date}
            emptyText="No Data For The Selected Filters"
            scroll
          />
        </div>
      </div>
    </SectionCard>
  );
}
