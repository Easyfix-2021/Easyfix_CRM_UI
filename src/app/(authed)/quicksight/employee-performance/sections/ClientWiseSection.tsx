'use client';

/*
 * 3. Client Wise Open Job Report — the client table (dashboard #client) and the
 * pending-reason breakdown (#jobchart), stacked: at CRM density the 9- and
 * 7-column tables do not fit side by side.
 *
 * Column order is the dashboard's: the aging buckets sit between Total Jobs
 * and Open Jobs. Neither table follows the date filter — open-job figures are
 * a current snapshot, Total / Closed Jobs cover the whole upload period.
 * Pending reasons arrive sorted by Total, descending; the third click on a
 * header returns to that order.
 */

import type { ClientRow, PendingReasonRow } from '../types';
import { dec1, num } from '../format';
import { LocalTable, SectionCard, SubHeading, emptyTableText, type Column, type SummaryProps } from './shared';

const CLIENT_COLUMNS: ReadonlyArray<Column<ClientRow>> = [
  { key: 'client', label: 'Client Name' },
  { key: 'total', label: 'Total Jobs', align: 'right', render: (r) => num(r.total) },
  { key: 'a02', label: '≤2 Days', align: 'right', render: (r) => num(r.a02) },
  { key: 'a35', label: '3–5 Days', align: 'right', render: (r) => num(r.a35) },
  { key: 'a68', label: '6–8 Days', align: 'right', render: (r) => num(r.a68) },
  { key: 'a9', label: '9+ Days', align: 'right', render: (r) => num(r.a9) },
  { key: 'open', label: 'Open Jobs', align: 'right', render: (r) => num(r.open) },
  { key: 'completed', label: 'Closed Jobs', align: 'right', render: (r) => num(r.completed) },
  { key: 'avg_age', label: 'Avg Age', align: 'right', render: (r) => dec1(r.avg_age) },
];

const PENDING_COLUMNS: ReadonlyArray<Column<PendingReasonRow>> = [
  { key: 'dueTo', label: 'Pending Due To', wrap: true },
  { key: 'reason', label: 'Pending Reason', wrap: true },
  { key: 'a02', label: '≤2 Days', align: 'right', render: (r) => num(r.a02) },
  { key: 'a35', label: '3–5 Days', align: 'right', render: (r) => num(r.a35) },
  { key: 'a68', label: '6–8 Days', align: 'right', render: (r) => num(r.a68) },
  { key: 'a9', label: '9+ Days', align: 'right', render: (r) => num(r.a9) },
  { key: 'total', label: 'Total', align: 'right', render: (r) => num(r.total) },
];

export function ClientWiseSection({ summary }: SummaryProps) {
  return (
    <SectionCard
      title="3. Client Wise Open Job Report"
      subtitle="Not filtered by date: open-job counts are a current snapshot; Total and Closed Jobs cover the whole upload period."
    >
      <div className="space-y-2">
        <SubHeading>Clients</SubHeading>
        <LocalTable
          rows={summary.clients}
          columns={CLIENT_COLUMNS}
          rowKey={(r) => r.client}
          emptyText={emptyTableText(summary, 'No Data For The Selected Filters')}
          pageSize={10}
        />
      </div>
      <div className="space-y-2 pt-1">
        <SubHeading>Pending Reasons</SubHeading>
        <LocalTable
          rows={summary.pendingReasons}
          columns={PENDING_COLUMNS}
          rowKey={(r, i) => `${r.dueTo}␟${r.reason}␟${i}`}
          emptyText={emptyTableText(summary, 'No Open Jobs For The Selected Filters')}
          pageSize={10}
        />
      </div>
    </SectionCard>
  );
}
