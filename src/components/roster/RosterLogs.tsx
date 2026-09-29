'use client';

/*
 * Logs tab — Actions ONLY (v2 contract: no Updates table on open). One row
 * per action, including denied/rejected/failed attempts. Clicking the
 * "N Employees" link inside a row's Summary opens ActionChangesDialog,
 * which fetches the per-employee change rows for that one action on demand.
 *
 * `renderChange` / `dayTypeLabel` / `DayTypeChip` are exported so
 * ActionChangesDialog reuses the exact same change-rendering logic instead
 * of a second copy that can drift (contract item 7: "reuse the existing
 * renderChange logic from RosterLogs").
 */

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { TablePagination, type TablePageSize, pageSizeToLimit, PAGE_SIZE_OPTIONS } from '@/components/ui/table-pagination';
import { useFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import { ActionChangesDialog } from './ActionChangesDialog';
import type { RosterActionLogAction, RosterActionLogResponse, RosterUpdateLogItem } from './types';

/* Same reasoning as the Issue Queue's ISSUE_PAGE_SIZES: 'All' renders as one
 * un-navigable page that lies past whatever the endpoint's own limit caps
 * at, so it's left out rather than offered and then silently capped. */
const LOG_LIMIT_CAP = 200;
const LOG_PAGE_SIZES = PAGE_SIZE_OPTIONS.filter((o) => o.value !== 'all');

/* FE-owned verb map (contract §logs/actions) — COPY_MONTH is old rows only,
 * the endpoint that produced it is gone. */
const ACTION_VERB: Record<RosterActionLogAction, string> = {
  SAVE_GRID: 'Updated',
  FILL_PATTERN: 'Updated',
  COPY_MONTH: 'Updated',
  RESET: 'Reset To Weekly Days',
  NOTIFY: 'Notified',
  EXPORT: 'Exported',
  WORKING_DAYS: 'Working Days Changed',
};
function actionVerb(a: string): string {
  return ACTION_VERB[a as RosterActionLogAction] ?? a;
}

/*
 * FE-owned status map (contract §logs/actions): 2xx → Success (green), 403 →
 * Denied (warning), other 4xx → Rejected, 5xx → Failed (urgent). The
 * contract doesn't name a tone for "Rejected" — it sits between Denied and
 * Failed in severity, so it renders neutral rather than borrowing either.
 */
function statusInfo(code: number): { label: string; tone: StatusChipTone } {
  if (code >= 200 && code < 300) return { label: 'Success', tone: 'success' };
  if (code === 403) return { label: 'Denied', tone: 'warning' };
  if (code >= 400 && code < 500) return { label: 'Rejected', tone: 'neutral' };
  if (code >= 500) return { label: 'Failed', tone: 'urgent' };
  return { label: String(code), tone: 'neutral' };
}

export function dayTypeLabel(v: string | null): string {
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

export function renderChange(item: Pick<RosterUpdateLogItem, 'field' | 'oldValue' | 'newValue'>) {
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

export function RosterLogs() {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  const limit = pageSizeToLimit(pageSize, LOG_LIMIT_CAP);
  const [openActionId, setOpenActionId] = useState<number | null>(null);

  const key = `/admin/roster/logs/actions?page=${page + 1}&limit=${limit}`;
  const { data, loading, error } = useFetch<RosterActionLogResponse>(key);
  const total = data?.total ?? 0;
  const columnCount = 4;

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
            <thead>
              <tr>
                <th className="!text-left">When</th>
                <th className="!text-left">By</th>
                <th className="!text-left">Summary</th>
                <th className="!text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={columnCount} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && (data?.items.length ?? 0) === 0 && (
                <tr><td colSpan={columnCount} className="!text-center text-muted-foreground py-6">No Entries Found.</td></tr>
              )}
              {!loading && data?.items.map((item) => {
                const status = statusInfo(item.statusCode);
                return (
                  <tr key={item.id}>
                    <td className="!text-left text-xs">{formatDate(item.createdAt)}</td>
                    <td className="!text-left text-xs">{item.actorName}</td>
                    <td className="!text-left text-xs">
                      {actionVerb(item.action)}
                      {/* A denied / failed attempt changed nobody — no link to an empty list. */}
                      {item.affectedUsers > 0 && (
                        <>
                          {' · '}
                          <button
                            type="button"
                            className="font-medium text-primary underline-offset-2 hover:underline"
                            onClick={() => setOpenActionId(item.id)}
                          >
                            {item.affectedUsers} {item.affectedUsers === 1 ? 'Employee' : 'Employees'}
                          </button>
                        </>
                      )}
                      {item.summary ? ` · ${item.summary}` : ''}
                    </td>
                    <td className="!text-center">
                      <StatusChip tone={status.tone} size="sm">{status.label}</StatusChip>
                    </td>
                  </tr>
                );
              })}
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
      <ActionChangesDialog actionId={openActionId} onClose={() => setOpenActionId(null)} />
    </Card>
  );
}
