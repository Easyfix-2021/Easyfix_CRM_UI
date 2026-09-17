'use client';

/*
 * 5. Client-Wise TAT & SDA Report (dashboard #tat). Each figure is the plain
 * mean of the selected SPOCs' percentages for that client, over the whole
 * upload period (not filtered by date).
 */

import type { TatSdaRow } from '../types';
import { pct1 } from '../format';
import { LocalTable, SectionCard, type Column, type SummaryProps } from './shared';

const TAT_SDA_COLUMNS: ReadonlyArray<Column<TatSdaRow>> = [
  { key: 'client', label: 'Client Name' },
  { key: 'tat', label: 'Average TAT', align: 'right', render: (r) => pct1(r.tat) },
  { key: 'sda', label: 'Average SDA', align: 'right', render: (r) => pct1(r.sda) },
];

export function TatSdaSection({ summary }: SummaryProps) {
  return (
    <SectionCard title="5. Client-Wise TAT & SDA Report" subtitle="Whole upload period, not filtered by date.">
      <LocalTable
        rows={summary.tatSda}
        columns={TAT_SDA_COLUMNS}
        rowKey={(r) => r.client}
        emptyText="No Data For The Selected Filters"
        pageSize={10}
      />
    </SectionCard>
  );
}
