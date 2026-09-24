'use client';

/*
 * Ops Desk (V3 Phase 3, spec 3.2) — the live operations desk from
 * proto.txt's `renderDesk()`, as a bounded, paginated CRM page.
 *
 * Band strip A–D with counts, a bounded list (GET /admin/ops-desk), and the
 * row actions the prototype wires: Price & Send Estimate / Send Back To Him
 * (additional-work reports), Bench Picked Up (help reports), Verify With
 * Customer (can't-complete / cancel claims — shared dialog with
 * /verification). Opening a job uses the existing JobRefLink + JobModalHost
 * (?jobId=&action=view) pattern, same as every other list page.
 *
 * RBAC: gated on isJobAppRequestResolve, same shape as the Issue Queue
 * preamble (fail-closed, bounce once `me` has settled) — this screen has no
 * second lock, so `canManage` is that one flag by construction.
 *
 * Polling: every 30s, ONLY while the tab is visible (perf standard — "poll
 * only while visible; stop on hidden/unmount"). useFetch's own
 * `refetchInterval` already no-ops on an undefined ms, so pollIntervalMs()
 * flipping to `undefined` when hidden is enough to stop it; no manual
 * setInterval/cleanup needed here.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, RefreshCw, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusChip } from '@/components/ui/StatusChip';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { api, ApiError, type OpsDeskItem, type OpsDeskBand } from '@/lib/api';
import { useFetch, useTabVisible, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { OPS_BANDS, OPS_BAND_LABEL, PENDING_ON_LABEL, formatOpsMoney, needsMeInLabel, pollIntervalMs } from '@/lib/ops-desk';
import { JobRefLink } from '@/components/job/JobRefLink';
import { JobModalHost } from '@/components/job/JobModalHost';
import { AuthImage } from '@/components/job/JobDocumentsCard';
import { VerifyWithCustomerDialog } from '@/components/job/VerifyWithCustomerDialog';
import { ScheduleVisitTwoDialog } from '@/components/job/ScheduleVisitTwoDialog';

const LIMIT_CAP = 200;
const POLL_MS = 30_000;

export default function OpsDeskPage() {
  const router = useRouter();
  const { me, loading: meLoading } = useMe();
  const canManage = hasAction(me, 'isJobAppRequestResolve');

  useEffect(() => {
    if (!meLoading && !canManage) router.replace('/dashboard');
  }, [meLoading, canManage, router]);

  const [band, setBand] = useState<OpsDeskBand | ''>('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);
  useEffect(() => { setPage(0); }, [band]);

  const tabVisible = useTabVisible();
  const limit = pageSizeToLimit(pageSize, LIMIT_CAP);
  const offset = pageSize === 'all' ? 0 : page * Number(pageSize);
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (band) qs.set('band', band);
  const listKey = canManage ? `/admin/ops-desk?${qs.toString()}` : null;

  const { data, loading, error, refetch } = useFetch<{ counts: Record<OpsDeskBand, number>; items: OpsDeskItem[]; total: number }>(
    listKey,
    { enabled: canManage, refetchInterval: pollIntervalMs(tabVisible, POLL_MS) },
  );
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const counts = data?.counts;

  function refreshList() {
    invalidateFetch((k) => k.startsWith('/admin/ops-desk'));
    refetch();
  }

  // Row dialogs — controlled by presence of a target item/report id, like the
  // rest of the codebase's row-action dialogs (JobDocumentsCard, admin-actions).
  const [priceTarget, setPriceTarget] = useState<OpsDeskItem | null>(null);
  const [returnTarget, setReturnTarget] = useState<OpsDeskItem | null>(null);
  const [verifyReportId, setVerifyReportId] = useState<number | null>(null);
  const [verifyJobTitle, setVerifyJobTitle] = useState<string | null>(null);
  // Schedule Visit 2 (V3 Phase 4, spec 4.3) — row action for waitingFor
  // 'schedule_visit2', same shared dialog the JobModal action bar opens.
  const [visitTwoTarget, setVisitTwoTarget] = useState<OpsDeskItem | null>(null);
  const confirm = useConfirm();
  const [benching, setBenching] = useState<number | null>(null);

  async function benchPickedUp(item: OpsDeskItem) {
    if (!item.report) return;
    const ok = await confirm({
      title: 'Bench Picked Up?',
      description: `Confirms the bench has taken ${item.technician?.name ?? 'the technician'}'s help request for Job #${item.jobId}.`,
      confirmLabel: 'Bench Picked Up',
    });
    if (!ok) return;
    setBenching(item.report.id);
    try {
      await api.resolveOpsDeskReport(item.report.id);
      showToast({ variant: 'success', message: 'Bench Picked Up' });
      refreshList();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed to resolve' });
    } finally {
      setBenching(null);
    }
  }

  if (meLoading || !canManage) {
    return <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <LayoutDashboard className="size-6" /> Ops Desk
          </h1>
          <p className="text-sm text-muted-foreground">
            Every job that needs something from the desk right now — priced, sent back, or verified with the customer.
          </p>
        </div>
        <Button variant="outline" onClick={refreshList}>
          <RefreshCw className="size-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* Band strip A–D — counts from the same response as the list, so the
          strip and the rows can never disagree about what's outstanding. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {OPS_BANDS.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setBand((cur) => (cur === b ? '' : b))}
            className={`rounded-lg border p-3 text-left transition-colors ${band === b ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/50'}`}
          >
            <div className="text-xs font-medium text-muted-foreground">Band {b}</div>
            <div className="text-sm font-semibold">{OPS_BAND_LABEL[b]}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{counts?.[b] ?? '—'}</div>
          </button>
        ))}
      </div>

      {error && (
        <Card><CardContent className="flex items-center gap-2 p-3 text-sm text-urgent">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="!text-left">Job</th>
                  <th className="!text-left">Client / Locality</th>
                  <th className="!text-left">Technician</th>
                  <th className="!text-left">Situation</th>
                  <th className="!text-center">Pending On</th>
                  <th className="!text-left">Start Proof</th>
                  <th className="!text-left">Money</th>
                  <th className="!text-center">Needs Me In</th>
                  <th className="!text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 && (
                  <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
                )}
                {!loading && rows.length === 0 && (
                  <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">
                    Nothing for the desk to do{band ? ` in Band ${band}` : ''} right now.
                  </td></tr>
                )}
                {rows.map((item) => (
                  <tr key={item.jobId} className="hover:bg-ink-50">
                    <td className="!text-left">
                      <JobRefLink jobId={item.jobId} className="font-medium text-primary hover:underline" />
                      <div className="text-xs text-muted-foreground">{item.title}</div>
                    </td>
                    <td className="!text-left">
                      <div>{item.clientName ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{item.locality ?? '—'}</div>
                    </td>
                    <td className="!text-left">
                      {item.technician ? `${item.technician.name ?? '—'} #${item.technician.efrId}` : '—'}
                    </td>
                    <td className="!text-left text-sm">
                      {item.situation}
                      {item.report?.proofImageIds && item.report.proofImageIds.length > 0 && (
                        <div className="mt-1 flex gap-1">
                          {item.report.proofImageIds.slice(0, 3).map((id) => (
                            <AuthImage
                              key={id}
                              url={`/admin/jobs/images/${id}/file`}
                              alt={`Proof #${id}`}
                              className="h-10 w-10 rounded border"
                            />
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="!text-center">
                      <StatusChip tone={item.pendingOn === 'easyfix' ? 'urgent' : item.pendingOn === 'client' ? 'info' : 'neutral'} size="sm">
                        {PENDING_ON_LABEL[item.pendingOn]}
                      </StatusChip>
                    </td>
                    <td className="!text-left text-xs">
                      {item.startProof === 'pin' ? 'PIN'
                        : item.startProof === 'pin_late' ? 'PIN (Late)'
                        : item.startProof === 'photos' ? 'Photos Only'
                        : '—'}
                    </td>
                    <td className="!text-left text-xs">{formatOpsMoney(item.money.client, item.money.tx)}</td>
                    <td className="!text-center text-xs">{needsMeInLabel(item.needsMeIn)}</td>
                    <td className="!text-right whitespace-nowrap space-x-1">
                      {item.report?.kind === 'additional_work' && item.report.status === 'open' && (
                        <>
                          <Button size="sm" onClick={() => setPriceTarget(item)}>Price &amp; Send Estimate</Button>
                          <Button size="sm" variant="outline" onClick={() => setReturnTarget(item)}>Send Back To Him</Button>
                        </>
                      )}
                      {item.report?.kind === 'help' && (
                        <Button size="sm" disabled={benching === item.report.id} onClick={() => benchPickedUp(item)}>
                          {benching === item.report.id ? 'Saving…' : 'Bench Picked Up'}
                        </Button>
                      )}
                      {(item.report?.kind === 'cant_complete' || item.report?.kind === 'cancel') && (
                        <Button size="sm" onClick={() => { setVerifyReportId(item.report!.id); setVerifyJobTitle(item.title); }}>
                          Verify With Customer
                        </Button>
                      )}
                      {item.waitingFor === 'schedule_visit2' && (
                        <Button size="sm" onClick={() => setVisitTwoTarget(item)}>Schedule Visit 2</Button>
                      )}
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
              loading={loading}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </div>
        </CardContent>
      </Card>

      <PriceEstimateDialog item={priceTarget} onClose={() => setPriceTarget(null)} onPriced={refreshList} />
      <SendBackDialog item={returnTarget} onClose={() => setReturnTarget(null)} onReturned={refreshList} />
      <VerifyWithCustomerDialog
        reportId={verifyReportId}
        jobTitle={verifyJobTitle}
        onClose={() => setVerifyReportId(null)}
        onResolved={refreshList}
      />
      <ScheduleVisitTwoDialog
        open={visitTwoTarget != null}
        jobId={visitTwoTarget?.jobId ?? null}
        jobTitle={visitTwoTarget?.title ?? null}
        onClose={() => setVisitTwoTarget(null)}
        onDone={refreshList}
      />
      <JobModalHost onSaved={refreshList} />
    </div>
  );
}

/*
 * Price & Send Estimate — client amount, TX amount, note. TX <= client is
 * validated here (UX) AND on the server (the contract's word); this copy just
 * saves the operator a round trip on the common mistake.
 */
function PriceEstimateDialog({ item, onClose, onPriced }: {
  item: OpsDeskItem | null;
  onClose: () => void;
  onPriced: () => void;
}) {
  const [clientAmount, setClientAmount] = useState('');
  const [txAmount, setTxAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (item) { setClientAmount(''); setTxAmount(''); setNote(''); }
  }, [item]);

  const client = Number(clientAmount);
  const tx = Number(txAmount);
  const validAmounts = clientAmount !== '' && txAmount !== '' && client > 0 && tx > 0 && tx <= client;

  async function submit() {
    if (!item?.report || !validAmounts) return;
    setBusy(true);
    try {
      await api.priceOpsDeskReport(item.report.id, { clientAmount: client, txAmount: tx, note: note || undefined });
      showToast({ variant: 'success', message: 'Estimate Sent' });
      onPriced();
      onClose();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed to send the estimate' });
    } finally {
      setBusy(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });

  return (
    <Dialog open={item != null} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Price &amp; Send Estimate{item ? ` · Job #${item.jobId}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Client Amount *</Label>
              <Input type="number" min={1} value={clientAmount} onChange={(e) => setClientAmount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>TX Amount *</Label>
              <Input type="number" min={1} value={txAmount} onChange={(e) => setTxAmount(e.target.value)} />
            </div>
          </div>
          {clientAmount !== '' && txAmount !== '' && tx > client && (
            <p className="text-xs text-urgent">TX amount cannot be more than the client amount.</p>
          )}
          <div className="space-y-1">
            <Label>Note</Label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Optional note for the client estimate"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:border-foreground/40 resize-y"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
          <Button onClick={submit} disabled={busy || !validAmounts}>{busy ? 'Sending…' : 'Send Estimate'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* Send Back To Him — one required note explaining what's missing. */
function SendBackDialog({ item, onClose, onReturned }: {
  item: OpsDeskItem | null;
  onClose: () => void;
  onReturned: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (item) setNote(''); }, [item]);

  async function submit() {
    if (!item?.report || !note.trim()) return;
    setBusy(true);
    try {
      await api.returnOpsDeskReport(item.report.id, note.trim());
      showToast({ variant: 'success', message: 'Sent Back To Him' });
      onReturned();
      onClose();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed to send back' });
    } finally {
      setBusy(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });

  return (
    <Dialog open={item != null} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send Back To Him{item ? ` · Job #${item.jobId}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 p-4">
          <div className="space-y-1">
            <Label>Note *</Label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              placeholder="What does he need to fix or re-send?"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:border-foreground/40 resize-y"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
          <Button onClick={submit} disabled={busy || !note.trim()}>{busy ? 'Sending…' : 'Send Back'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
