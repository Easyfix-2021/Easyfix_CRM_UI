'use client';

/*
 * 2. Open Job Record — aging tiles plus the open-job detail table.
 *
 * The tiles read summary.openAging, which counts EVERY filtered open job; the
 * table is one server page of GET /open-jobs (sorted and paged on the server),
 * so the tiles never depend on the page on screen. Tile bands are 0–2 / 3–5 /
 * 6–9 / >9 days (sections 3 and 4 use 6–8 / 9+, as the dashboard does).
 * Open jobs are a current snapshot: the date filter does not apply.
 */

import { CircleCheck, Clock, FolderOpen, Hourglass, TriangleAlert } from 'lucide-react';
import { QS_COLORS, QS_SEMANTIC, QsKpiTile } from '@/components/quicksight/charts';
import { useFetch } from '@/lib/hooks';
import { openJobsKey } from '../api';
import type { OpenJobRow, OpenJobSortKey, OpenJobsPage } from '../types';
import { num } from '../format';
import {
  SectionCard,
  ServerPagedTable,
  emptyTableText,
  useServerTable,
  type Column,
  type PagedSectionProps,
} from './shared';

const OPEN_JOB_COLUMNS: ReadonlyArray<Column<OpenJobRow, OpenJobSortKey>> = [
  { key: 'jobId', label: 'Job ID', sticky: true },
  { key: 'vertical', label: 'Vertical' },
  { key: 'state', label: 'State' },
  { key: 'city', label: 'City' },
  { key: 'client', label: 'Client' },
  // The snapshot's aging is a number; the fixture's may be a string or null.
  { key: 'aging', label: 'Aging', align: 'right', render: (r) => num(Number(r.aging) || 0) },
  { key: 'pendingDueTo', label: 'Pending Due To', wrap: true },
  { key: 'pendingReason', label: 'Pending Reason', wrap: true },
  { key: 'pmoc', label: 'PMOC Name' },
];

export function OpenJobRecordSection({ summary, v, filters }: PagedSectionProps) {
  const table = useServerTable<OpenJobSortKey>(v, filters);
  const res = useFetch<OpenJobsPage>(openJobsKey(v, filters, table.paging));
  const aging = summary.openAging;

  return (
    <SectionCard title="2. Open Job Record" subtitle="Current snapshot of open jobs, not filtered by date.">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <QsKpiTile label="Open Jobs" value={num(aging.total)} accent={QS_SEMANTIC.info} icon={<FolderOpen className="size-5" />} />
        <QsKpiTile label="0–2 Days" value={num(aging.d0_2)} accent={QS_SEMANTIC.good} icon={<CircleCheck className="size-5" />} />
        <QsKpiTile label="3–5 Days" value={num(aging.d3_5)} accent={QS_COLORS[0]} icon={<Clock className="size-5" />} />
        <QsKpiTile label="6–9 Days" value={num(aging.d6_9)} accent={QS_SEMANTIC.warn} icon={<Hourglass className="size-5" />} />
        <QsKpiTile label=">9 Days" value={num(aging.d10p)} accent={QS_SEMANTIC.bad} icon={<TriangleAlert className="size-5" />} />
      </div>
      <ServerPagedTable
        columns={OPEN_JOB_COLUMNS}
        table={table}
        res={res}
        rowKey={(r, i) => `${r.jobId}-${i}`}
        emptyText={emptyTableText(summary, 'No Open Jobs For The Selected Filters')}
      />
    </SectionCard>
  );
}
