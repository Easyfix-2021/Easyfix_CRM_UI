'use client';

/*
 * DeletedRecordsDialog — lists archived (hard-deleted) Easyfixers / Users and
 * lets an authorised operator restore one. Restore is OTP-gated:
 *
 *   1. Click "Restore" on a row → POST /restore/request-otp { archiveId }.
 *   2. Inline OTP step appears for that row → POST /restore/confirm { archiveId, otp }.
 *   3. Success → toast + refetch() the list.
 *
 * The list itself is read via useFetch (GET) per the no-raw-api.get-in-useEffect
 * rule. Restore mutations are api.post inside click handlers (allowed). An
 * optional type filter (All | Easyfixer | User) re-keys the useFetch URL.
 */

import { useState } from 'react';
import { Trash2, RotateCcw } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { showToast } from '@/components/ui/toast';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/utils';

type TypeFilter = 'all' | 'easyfixer' | 'user';

type DeletedRow = {
  id: number;
  entity_type: 'easyfixer' | 'user';
  entity_id: number;
  entity_label: string;
  deletion_reason: string | null;
  deleted_by_name: string | null;
  deleted_at: string;
};

type DeletedList = { items: DeletedRow[]; total: number; limit: number; offset: number };

export function DeletedRecordsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);

  // Row currently in the OTP step (archiveId), and its OTP buffer.
  const [otpRow, setOtpRow] = useState<number | null>(null);
  const [otp, setOtp] = useState('');
  const [busyRow, setBusyRow] = useState<number | null>(null);

  const typeQs = filter === 'all' ? '' : `type=${filter}&`;
  // BE Joi cap on the deleted list is 200 — pass it explicitly so "All" maps to
  // the endpoint's real ceiling (not pageSizeToLimit's 1000 default).
  const limit = pageSizeToLimit(pageSize, 200);
  const offset = page * (pageSize === 'all' ? 0 : Number(pageSize));
  // Only fetch while the dialog is open (key=null defers the request). The key
  // includes limit+offset, so changing page/size refetches.
  const key = open ? `/admin/entity-deletion/deleted?${typeQs}limit=${limit}&offset=${offset}` : null;
  const { data, loading, error, refetch } = useFetch<DeletedList>(key);

  function handleClose() {
    setOtpRow(null);
    setOtp('');
    setBusyRow(null);
    setPage(0);
    onClose();
  }

  function changeFilter(f: TypeFilter) {
    if (f === filter) return;
    setFilter(f);
    setPage(0);
    setOtpRow(null);
    setOtp('');
  }

  async function startRestore(archiveId: number) {
    setBusyRow(archiveId);
    try {
      const r = await api.post<{ delivered: boolean; expiresAt: string; message: string }>(
        '/admin/entity-deletion/restore/request-otp',
        { archiveId },
      );
      showToast({ variant: 'success', message: r.message || 'OTP Sent.' });
      setOtpRow(archiveId);
      setOtp('');
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed To Send OTP' });
    } finally {
      setBusyRow(null);
    }
  }

  async function confirmRestore(archiveId: number) {
    if (otp.trim().length < 4) {
      showToast({ variant: 'error', message: 'Enter The 4-Digit OTP' });
      return;
    }
    setBusyRow(archiveId);
    try {
      await api.post<{ entityType: string; id: number; label: string; message: string }>(
        '/admin/entity-deletion/restore/confirm',
        { archiveId, otp: otp.trim() },
      );
      showToast({ variant: 'success', message: 'Record restored.' });
      setOtpRow(null);
      setOtp('');
      refetch();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed To Restore' });
    } finally {
      setBusyRow(null);
    }
  }

  const items = data?.items ?? [];

  // This dialog is a read-only browser (no editable form), so close paths
  // never need a discard prompt — `isDirty: false` makes the guard close
  // immediately while still satisfying the shared-handler lint rule. We do
  // hold off while a restore OTP step is mid-flight.
  const guardedOpenChange = useFormDirtyGuard(handleClose, {
    isDirty: false,
    when: () => busyRow === null,
  });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4" />
            Deleted Records
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 p-4">
          {/* Type filter */}
          <div className="inline-flex rounded-md border border-input overflow-hidden">
            {([
              ['all', 'All'],
              ['easyfixer', 'Easyfixer'],
              ['user', 'User'],
            ] as const).map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                onClick={() => changeFilter(val)}
                className={
                  'px-3 py-1.5 text-sm font-medium transition-colors ' +
                  (filter === val
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background text-foreground hover:bg-muted')
                }
              >
                {lbl}
              </button>
            ))}
          </div>

          {loading && (
            <div className="rounded border bg-muted/40 p-4 text-sm text-muted-foreground text-center">
              Loading deleted records…
            </div>
          )}
          {error && (
            <div className="rounded border border-urgent/30 bg-urgent-tint p-3 text-sm text-urgent-strong">
              {error}
            </div>
          )}

          {!loading && !error && items.length === 0 && (
            <div className="rounded border bg-muted/40 p-6 text-sm text-muted-foreground text-center">
              No Deleted Records.
            </div>
          )}

          {!loading && !error && items.length > 0 && (
            <div className="max-h-[55vh] overflow-y-auto rounded border">
              <table className="data-table w-full text-sm">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Type</th>
                    <th className="px-3 py-2 text-left font-medium">Label</th>
                    <th className="px-3 py-2 text-left font-medium">Reason</th>
                    <th className="px-3 py-2 text-left font-medium">Deleted By</th>
                    <th className="px-3 py-2 text-left font-medium">Deleted On</th>
                    <th className="px-3 py-2 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id} className="border-t align-top">
                      <td className="px-3 py-2 capitalize">{row.entity_type}</td>
                      <td className="px-3 py-2">{row.entity_label}</td>
                      <td className="px-3 py-2 text-muted-foreground">{row.deletion_reason || '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground">{row.deleted_by_name || '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{formatDate(row.deleted_at)}</td>
                      <td className="px-3 py-2 text-right">
                        {otpRow === row.id ? (
                          <div className="flex items-center justify-end gap-2">
                            <Input
                              type="text"
                              inputMode="numeric"
                              maxLength={4}
                              value={otp}
                              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))}
                              placeholder="OTP"
                              className="h-8 w-20 tracking-[0.3em] text-center"
                            />
                            <Button
                              size="sm"
                              onClick={() => confirmRestore(row.id)}
                              disabled={busyRow === row.id || otp.trim().length < 4}
                            >
                              {busyRow === row.id ? 'Restoring…' : 'Confirm'}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => { setOtpRow(null); setOtp(''); }}
                              disabled={busyRow === row.id}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => startRestore(row.id)}
                            disabled={busyRow === row.id}
                          >
                            <RotateCcw className="mr-1 h-3.5 w-3.5" />
                            {busyRow === row.id ? 'Sending…' : 'Restore'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && !error && data && data.total > 0 && (
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={data.total}
              onPageChange={setPage}
              onPageSizeChange={(ps) => { setPageSize(ps); setPage(0); }}
            />
          )}

          <div className="flex justify-end pt-1">
            <Button variant="outline" onClick={handleClose}>Close</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
