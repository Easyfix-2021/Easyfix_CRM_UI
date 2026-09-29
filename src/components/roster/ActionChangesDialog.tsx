'use client';

/*
 * Opens from a Logs-tab action row's "N Employee(s)" link (RosterLogs.tsx).
 * Fetches ONE action's changes on demand — never on Logs-tab open — from
 * GET /admin/roster/logs/actions/:id/changes, which pages over DATES: one row
 * per date, one line per employee listing all of their changes that day
 * (owner, 2026-09-29). `renderChange` is RosterLogs' own renderer, imported.
 */

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TablePagination, type TablePageSize, pageSizeToLimit, PAGE_SIZE_OPTIONS } from '@/components/ui/table-pagination';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { renderChange } from './RosterLogs';
import { formatYmdLabel, weekdayShort } from './roster-dates';
import type { RosterActionChangesResponse } from './types';

const LOG_LIMIT_CAP = 200;
const LOG_PAGE_SIZES = PAGE_SIZE_OPTIONS.filter((o) => o.value !== 'all');

export function ActionChangesDialog({ actionId, onClose }: { actionId: number | null; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  const limit = pageSizeToLimit(pageSize, LOG_LIMIT_CAP);

  const open = actionId != null;
  // A new action opens on page 1, not wherever the previous one was left.
  useEffect(() => { if (open) setPage(0); }, [actionId, open]);
  // Null key until opened — a closed dialog fetches nothing.
  const key = open ? `/admin/roster/logs/actions/${actionId}/changes?page=${page + 1}&limit=${limit}` : null;
  const { data, loading, error } = useFetch<RosterActionChangesResponse>(key);
  const total = data?.total ?? 0;

  // Read-only detail view — nothing here is ever "dirty", but the repo lint
  // requires every <Dialog> close path to route through this guard.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: () => false });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Employee Changes</DialogTitle>
        </DialogHeader>

        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left w-40">Date</th>
                <th className="!text-left">Changes</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={2} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {error && (
                <tr><td colSpan={2} className="!text-center text-urgent py-6">{error}</td></tr>
              )}
              {!loading && !error && (data?.items.length ?? 0) === 0 && (
                <tr><td colSpan={2} className="!text-center text-muted-foreground py-6">No Entries Found.</td></tr>
              )}
              {!loading && data?.items.map((day) => (
                <tr key={day.rosterDate ?? 'weekly'} className="align-top">
                  <td className="!text-left text-xs font-medium whitespace-nowrap">
                    {day.rosterDate ? `${formatYmdLabel(day.rosterDate)} (${weekdayShort(day.rosterDate)})` : 'Weekly Days'}
                  </td>
                  <td className="!text-left">
                    <ul className="space-y-1.5">
                      {day.employees.map((e) => (
                        <li key={e.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          {/* "<EmpCode> · <Name>" — empCode is null for most users; never render "Name ()". */}
                          <span className="text-xs font-medium">{e.empCode ? `${e.empCode} · ` : ''}{e.userName}</span>
                          {e.changes.map((c, i) => <span key={i}>{renderChange(c)}</span>)}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t px-3 py-2 -mx-6 -mb-6">
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
      </DialogContent>
    </Dialog>
  );
}
