'use client';

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { formatDate, formatEasyfixerName } from '@/lib/utils';

/*
 * EasyfixerClientMappingModal — lists every client this easyfixer is
 * mapped to via tbl_client_easyfixer_mapping. BE contract:
 *
 *   GET /admin/easyfixers/:id/mapped-clients?limit=&offset=
 *     → { items: MappedClient[]; total; limit; offset }
 *
 * Same shape + UI conventions as the Transactions modal — both modals
 * stay visually aligned for a consistent "drill into a single easyfixer"
 * affordance from the Manage Easyfixers row Action cell.
 */
type MappedClient = {
  client_id: number;
  client_name: string;
  mapped_at: string | null;
  status: number | string | null;
};

type Resp = { items: MappedClient[]; total: number; limit: number; offset: number };

function statusLabel(s: MappedClient['status']): { label: string; tone: string } {
  // The BE returns either a numeric flag (1/0) or a literal string. Render
  // both gracefully so a contract change doesn't break the column.
  if (s == null || s === '') return { label: '—', tone: 'text-muted-foreground' };
  const n = Number(s);
  if (Number.isFinite(n)) {
    return n
      ? { label: 'Active', tone: 'bg-emerald-100 text-emerald-700' }
      : { label: 'Inactive', tone: 'bg-slate-100 text-slate-600' };
  }
  return { label: String(s), tone: 'bg-slate-100 text-slate-600' };
}

export function EasyfixerClientMappingModal({
  open,
  onClose,
  easyfixerId,
  easyfixerName,
}: {
  open: boolean;
  onClose: () => void;
  easyfixerId: number | null;
  easyfixerName: string | null;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);

  // Read-only modal — no form input; guard short-circuits straight to
  // onClose. Satisfies the project's no-restricted-syntax ESLint rule.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  const limit = pageSizeToLimit(pageSize, 1000);

  const listKey = useMemo(() => {
    if (!open || !easyfixerId) return null;
    const offset = page * (pageSize === 'all' ? limit : Number(pageSize));
    const p = new URLSearchParams();
    p.set('limit', String(limit));
    p.set('offset', String(offset));
    return `/admin/easyfixers/${easyfixerId}/mapped-clients?${p.toString()}`;
  }, [open, easyfixerId, page, pageSize, limit]);

  const { data, loading, error } = useFetch<Resp>(listKey);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const headerTitle =
    easyfixerName
      ? `Mapped Clients — ${formatEasyfixerName(easyfixerName)}`
      : 'Mapped Clients';

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-3xl w-[min(95vw,800px)] h-[75vh] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="!mx-0 !mt-0 px-6 py-4 mb-0">
          <DialogTitle>{headerTitle}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto px-4 py-3">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Client Id</th>
                <th>Client Name</th>
                <th>Mapped At</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={4} className="text-center py-8 text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && error && (
                <tr>
                  <td colSpan={4} className="text-center py-8 text-rose-600">
                    {error}
                  </td>
                </tr>
              )}
              {!loading && !error && items.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center py-8 text-muted-foreground">
                    No Clients Mapped Yet.
                  </td>
                </tr>
              )}
              {!loading && !error && items.map((m) => {
                const st = statusLabel(m.status);
                return (
                  <tr key={m.client_id}>
                    <td className="text-xs text-muted-foreground tabular-nums">{m.client_id}</td>
                    <td className="font-medium">{m.client_name}</td>
                    <td className="text-xs whitespace-nowrap text-muted-foreground">{m.mapped_at ? formatDate(m.mapped_at) : '—'}</td>
                    <td>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${st.tone}`}>
                        {st.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-2 border-t bg-background">
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(0);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
