'use client';

/*
 * 6. Zonal Manager Breakdown — the zonal manager table (dashboard #zmBreakdown)
 * and Current TX Performance (#txpanel) with its unassigned-jobs note.
 *
 * Zonal rows arrive sorted by revenue, descending (at most a handful of
 * managers, so no paging). The TX table is one server page of
 * GET /technicians. The Unassigned count follows Vertical (SPOC level) and
 * Employee only — not Zonal Manager or dates — exactly as the dashboard.
 */

import { Info } from 'lucide-react';
import { useFetch } from '@/lib/hooks';
import { techniciansKey } from '../api';
import type { TechnicianRow, TechnicianSortKey, TechniciansPage, ZonalRow } from '../types';
import { days1, money, num } from '../format';
import {
  LocalTable,
  SectionCard,
  ServerPagedTable,
  SubHeading,
  dash,
  emptyTableText,
  useServerTable,
  type Column,
  type PagedSectionProps,
} from './shared';

const ZONAL_COLUMNS: ReadonlyArray<Column<ZonalRow>> = [
  { key: 'zonalManager', label: 'Zonal Manager' },
  { key: 'open', label: 'Open Jobs', align: 'right', render: (r) => num(r.open) },
  { key: 'closed', label: 'Closed Jobs', align: 'right', render: (r) => num(r.closed) },
  { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => money(r.revenue) },
];

const TX_COLUMNS: ReadonlyArray<Column<TechnicianRow, TechnicianSortKey>> = [
  { key: 'txId', label: 'TX ID', sticky: true, render: (r) => dash(r.txId) },
  { key: 'txName', label: 'Current TX Name', render: (r) => dash(r.txName) },
  { key: 'total', label: 'Total Jobs', align: 'right', render: (r) => num(r.total) },
  { key: 'closed', label: 'Closed Jobs', align: 'right', render: (r) => num(r.closed) },
  { key: 'open', label: 'Open Jobs', align: 'right', render: (r) => num(r.open) },
  { key: 'avgAging', label: 'Avg Open Aging', align: 'right', render: (r) => days1(r.avgAging) },
];

/* 'all verticals' is the server's sentinel; anything else is the selected names. */
function scopeLabel(scope: string): string {
  return scope === 'all verticals' ? 'All Verticals' : scope;
}

export function ZonalSection({ summary, v, filters }: PagedSectionProps) {
  const table = useServerTable<TechnicianSortKey>(v, filters);
  const res = useFetch<TechniciansPage>(techniciansKey(v, filters, table.paging));

  return (
    <SectionCard title="6. Zonal Manager Breakdown">
      {/* Side by side from 2xl; the TX table gets the wider share (6 columns vs 4). */}
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <SubHeading>Zonal Managers</SubHeading>
            <span className="text-xs text-muted-foreground">Showing: {scopeLabel(summary.zonal.scope)}</span>
          </div>
          <LocalTable
            rows={summary.zonal.rows}
            columns={ZONAL_COLUMNS}
            rowKey={(r) => r.zonalManager}
            emptyText={emptyTableText(summary, 'No Data For The Selected Vertical')}
          />
        </div>

        <div className="min-w-0 space-y-2">
          <SubHeading>Current TX Performance</SubHeading>
          <ServerPagedTable
            columns={TX_COLUMNS}
            table={table}
            res={res}
            rowKey={(r, i) => `${r.spoc}|${r.txName}|${r.txId}|${i}`}
            emptyText={emptyTableText(summary, 'No TX Data For The Selected Filters')}
          />
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <p>
              <span className="font-semibold text-foreground">Unassigned Jobs: {num(summary.unassigned)}.</span>{' '}
              These are jobs under the selected Primary SPOC that currently have no Current TX assignment.
              They are not included in technician / TX job counts.
            </p>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
