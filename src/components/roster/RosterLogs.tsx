'use client';

/*
 * Update Log + Action Log tabs — one component, `kind` picks the endpoint,
 * the columns and the row renderer. Both follow the Issue Queue's
 * Card > CardContent p-0 > table.data-table + border-t TablePagination
 * shape (admin-actions/issues/page.tsx).
 */

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { StatusChip } from '@/components/ui/StatusChip';
import { TablePagination, type TablePageSize, pageSizeToLimit, PAGE_SIZE_OPTIONS } from '@/components/ui/table-pagination';
import { useFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import type {
  RosterActionLogAction, RosterActionLogItem, RosterActionLogResponse,
  RosterUpdateLogItem, RosterUpdateLogResponse, RosterUpdateLogSource,
} from './types';

/* Same reasoning as the Issue Queue's ISSUE_PAGE_SIZES: 'All' renders as one
 * un-navigable page that lies past whatever the endpoint's own limit caps
 * at, so it's left out rather than offered and then silently capped. */
const LOG_LIMIT_CAP = 200;
const LOG_PAGE_SIZES = PAGE_SIZE_OPTIONS.filter((o) => o.value !== 'all');

const SOURCE_LABEL: Record<RosterUpdateLogSource, string> = {
  GRID: 'Grid', PATTERN: 'Pattern', COPY: 'Copy', RESET: 'Reset', EDIT_USER: 'Edit User',
};

function titleCaseAction(a: RosterActionLogAction | string): string {
  return a.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}

function dayTypeLabel(v: string | null): string {
  if (v === 'PR') return 'Present';
  if (v === 'WO') return 'Week Off';
  return v ?? '—';
}

function DayTypeChip({ type }: { type: string | null }) {
  if (type !== 'PR' && type !== 'WO') return <span className="text-muted-foreground">—</span>;
  return (
    <span className={type === 'PR' ? 'rounded px-1.5 py-0.5 bg-success-tint text-success-strong' : 'rounded px-1.5 py-0.5 bg-warning-tint text-warning-strong'}>
      {type}
    </span>
  );
}

function renderChange(item: RosterUpdateLogItem) {
  if (item.field === 'day_type') {
    if (item.newValue === null) return <span className="text-xs text-muted-foreground">→ Weekly Days</span>;
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium">
        <DayTypeChip type={item.oldValue} /> <span className="text-muted-foreground">→</span> <DayTypeChip type={item.newValue} />
      </span>
    );
  }
  if (item.field === 'shift_start' || item.field === 'pref.shift') {
    return <span className="text-xs">Shift {item.oldValue || '—'} → {item.newValue || '—'}</span>;
  }
  if (item.field === 'pref.working_days') {
    return <span className="text-xs">Working Days {item.oldValue ?? '—'} → {item.newValue ?? '—'}</span>;
  }
  if (item.field.startsWith('pref.')) {
    const day = item.field.slice('pref.'.length);
    const label = day.charAt(0).toUpperCase() + day.slice(1);
    return <span className="text-xs">{label}: {dayTypeLabel(item.oldValue)} → {dayTypeLabel(item.newValue)}</span>;
  }
  return <span className="text-xs">{item.oldValue ?? '—'} → {item.newValue ?? '—'}</span>;
}

export function RosterLogs({ kind }: { kind: 'updates' | 'actions' }) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  const limit = pageSizeToLimit(pageSize, LOG_LIMIT_CAP);

  const path = kind === 'updates' ? '/admin/roster/logs/updates' : '/admin/roster/logs/actions';
  const key = `${path}?page=${page + 1}&limit=${limit}`;
  const { data, loading, error } = useFetch<RosterUpdateLogResponse | RosterActionLogResponse>(key);
  const total = data?.total ?? 0;

  const columnCount = kind === 'updates' ? 6 : 6;

  return (
    <Card className="mt-2">
      <CardContent className="p-0">
        {error && (
          <div className="flex items-center gap-2 p-3 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {error}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            {kind === 'updates' ? (
              <thead>
                <tr>
                  <th className="!text-left">Changed On</th>
                  <th className="!text-left">Employee</th>
                  <th className="!text-center">Date</th>
                  <th className="!text-left">Change</th>
                  <th className="!text-left">By</th>
                  <th className="!text-center">Source</th>
                </tr>
              </thead>
            ) : (
              <thead>
                <tr>
                  <th className="!text-left">When</th>
                  <th className="!text-left">By</th>
                  <th className="!text-left">Action</th>
                  <th className="!text-left">Scope</th>
                  <th className="!text-center">Cells</th>
                  <th className="!text-center">Result</th>
                </tr>
              </thead>
            )}
            <tbody>
              {loading && (
                <tr><td colSpan={columnCount} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && (data?.items.length ?? 0) === 0 && (
                <tr><td colSpan={columnCount} className="!text-center text-muted-foreground py-6">No Entries Found.</td></tr>
              )}
              {!loading && kind === 'updates' && (data as RosterUpdateLogResponse | undefined)?.items.map((item) => (
                <tr key={item.id}>
                  <td className="!text-left text-xs">{formatDate(item.createdAt)}</td>
                  <td className="!text-left text-xs">{item.userName} <span className="text-muted-foreground">({item.empCode})</span></td>
                  <td className="!text-center text-xs">{item.rosterDate ?? '—'}</td>
                  <td className="!text-left">{renderChange(item)}</td>
                  <td className="!text-left text-xs">{item.changedByName}</td>
                  <td className="!text-center text-xs">{SOURCE_LABEL[item.source] ?? item.source}</td>
                </tr>
              ))}
              {!loading && kind === 'actions' && (data as RosterActionLogResponse | undefined)?.items.map((item) => (
                <tr key={item.id}>
                  <td className="!text-left text-xs">{formatDate(item.createdAt)}</td>
                  <td className="!text-left text-xs">{item.actorName}</td>
                  <td className="!text-left text-xs">{titleCaseAction(item.action)}</td>
                  <td className="!text-left text-xs">{item.scopeSummary}</td>
                  <td className="!text-center text-xs">{item.affectedCells}</td>
                  <td className="!text-center">
                    <StatusChip tone={item.statusCode >= 200 && item.statusCode < 300 ? 'success' : 'urgent'} size="sm">
                      {item.statusCode}
                    </StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t px-3 py-2">
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            pageSizeOptions={LOG_PAGE_SIZES}
            loading={loading}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
