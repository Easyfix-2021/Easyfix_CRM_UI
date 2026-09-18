'use client';

/*
 * 4. City-Wise Open Job Report (dashboard #cityWise). A current snapshot of
 * open jobs, so the date filter does not apply. Avg Aging is the dashboard's
 * unweighted mean of each SPOC's mean.
 */

import type { CityRow } from '../types';
import { days1, num } from '../format';
import { LocalTable, SectionCard, emptyTableText, type Column, type SummaryProps } from './shared';

const CITY_COLUMNS: ReadonlyArray<Column<CityRow>> = [
  { key: 'city', label: 'City' },
  { key: 'open', label: 'Open Jobs', align: 'right', render: (r) => num(r.open) },
  { key: 'a02', label: '≤2 Days', align: 'right', render: (r) => num(r.a02) },
  { key: 'a35', label: '3–5 Days', align: 'right', render: (r) => num(r.a35) },
  { key: 'a68', label: '6–8 Days', align: 'right', render: (r) => num(r.a68) },
  { key: 'a9', label: '9+ Days', align: 'right', render: (r) => num(r.a9) },
  { key: 'avg_age', label: 'Avg Aging', align: 'right', render: (r) => days1(r.avg_age) },
];

export function CityWiseSection({ summary }: SummaryProps) {
  return (
    <SectionCard title="4. City-Wise Open Job Report" subtitle="Current snapshot of open jobs, not filtered by date.">
      <LocalTable
        rows={summary.cityWise}
        columns={CITY_COLUMNS}
        rowKey={(r) => r.city}
        emptyText={emptyTableText(summary, 'No Data For The Selected Filters')}
        pageSize={10}
      />
    </SectionCard>
  );
}
