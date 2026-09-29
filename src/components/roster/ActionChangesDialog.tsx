'use client';

/*
 * Opens from a Logs-tab action row's "N Employee(s)" link (RosterLogs.tsx).
 * Fetches the per-employee change rows for ONE action, on demand — never on
 * Logs-tab open (contract: GET /admin/roster/logs/updates?actionId=&page=&limit=).
 *
 * Columns: Date · Employee · Change. `renderChange` is the same function
 * RosterLogs uses for its own rows — imported, not re-implemented.
 */

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TablePagination, type TablePageSize, pageSizeToLimit, PAGE_SIZE_OPTIONS } from '@/components/ui/table-pagination';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { renderChange } from './RosterLogs';
import type { RosterUpdateLogResponse } from './types';

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
  const key = open ? `/admin/roster/logs/updates?actionId=${actionId}&page=${page + 1}&limit=${limit}` : null;
  const { data, loading, error } = useFetch<RosterUpdateLogResponse>(key);
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
                <th className="!text-center">Date</th>
                <th className="!text-left">Employee</th>
                <th className="!text-left">Change</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={3} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {error && (
                <tr><td colSpan={3} className="!text-center text-urgent py-6">{error}</td></tr>
              )}
              {!loading && !error && (data?.items.length ?? 0) === 0 && (
                <tr><td colSpan={3} className="!text-center text-muted-foreground py-6">No Entries Found.</td></tr>
              )}
              {!loading && data?.items.map((item) => (
                <tr key={item.id}>
                  <td className="!text-center text-xs">{item.rosterDate ?? '—'}</td>
                  {/* "<EmpCode> · <Name>" — empCode is null for most users; never render "Name ()". */}
                  <td className="!text-left text-xs">
                    {item.empCode ? `${item.empCode} · ` : ''}{item.userName}
                  </td>
                  <td className="!text-left">{renderChange(item)}</td>
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
