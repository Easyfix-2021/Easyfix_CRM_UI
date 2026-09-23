'use client';

/*
 * Verification (V3 Phase 3, spec 3.6) — the audit queue: completed jobs
 * waiting for a person to check workmanship (job_status 3/5/10, no
 * verified_on) plus open can't-complete / cancel claims, oldest first.
 *
 * "Pass Audit" → POST /admin/jobs/:id/verify (useConfirm — it's a one-way
 * gate into the client-QC clock, sheet 14). A claim row opens the SAME
 * Verify-with-customer dialog the Ops Desk uses instead of Pass Audit,
 * per spec ("claims link to / open the same Verify dialog").
 *
 * RBAC + no-flash preamble copied from /ops-desk (both gate on the same
 * isJobAppRequestResolve action key).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, RefreshCw, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { api, ApiError, type VerificationItem, type VerificationResponse } from '@/lib/api';
import { toVerificationRows } from '@/lib/ops-desk';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { formatDate, statusLabel } from '@/lib/utils';
import { JobRefLink } from '@/components/job/JobRefLink';
import { JobModalHost } from '@/components/job/JobModalHost';
import { VerifyWithCustomerDialog } from '@/components/job/VerifyWithCustomerDialog';

const LIMIT_CAP = 200;

export default function VerificationPage() {
  const router = useRouter();
  const { me, loading: meLoading } = useMe();
  const canManage = hasAction(me, 'isJobAppRequestResolve');

  useEffect(() => {
    if (!meLoading && !canManage) router.replace('/dashboard');
  }, [meLoading, canManage, router]);

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);
  const limit = pageSizeToLimit(pageSize, LIMIT_CAP);
  const offset = pageSize === 'all' ? 0 : page * Number(pageSize);
  const listKey = canManage ? `/admin/verification?limit=${limit}&offset=${offset}` : null;

  const { data, loading, error, refetch } = useFetch<VerificationResponse>(
    listKey, { enabled: canManage },
  );
  const { rows, total } = toVerificationRows(data);

  function refreshList() {
    invalidateFetch((k) => k.startsWith('/admin/verification'));
    refetch();
  }

  const confirm = useConfirm();
  const [passing, setPassing] = useState<number | null>(null);
  const [verifyReportId, setVerifyReportId] = useState<number | null>(null);
  const [verifyJobTitle, setVerifyJobTitle] = useState<string | null>(null);

  async function passAudit(item: VerificationItem) {
    const ok = await confirm({
      title: 'Pass Audit?',
      description: `Job #${item.jobId} moves to client QC. This does not post the ledger — money reaches the wallet after the client's check.`,
      confirmLabel: 'Pass Audit',
    });
    if (!ok) return;
    setPassing(item.jobId);
    try {
      await api.verifyJob(item.jobId);
      showToast({ variant: 'success', message: 'Audit Passed — Sent To Client QC' });
      refreshList();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed to pass audit' });
    } finally {
      setPassing(null);
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
            <ShieldCheck className="size-6" /> Verification
          </h1>
          <p className="text-sm text-muted-foreground">
            Completed jobs waiting for an EasyFix audit, plus open can&apos;t-complete / cancel claims — oldest first.
          </p>
        </div>
        <Button variant="outline" onClick={refreshList}>
          <RefreshCw className="size-4 mr-1" /> Refresh
        </Button>
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
                  <th className="!text-left">Client</th>
                  <th className="!text-left">Technician</th>
                  <th className="!text-left">Status</th>
                  <th className="!text-left">Submitted</th>
                  <th className="!text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 && (
                  <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
                )}
                {!loading && rows.length === 0 && (
                  <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">Nothing waiting for verification.</td></tr>
                )}
                {rows.map((item) => (
                  <tr key={`${item.report ? 'c' : item.legacyCancelAsk ? 'l' : 'a'}-${item.jobId}`} className="hover:bg-ink-50">
                    <td className="!text-left">
                      <JobRefLink jobId={item.jobId} className="font-medium text-primary hover:underline" />
                      <div className="text-xs text-muted-foreground">{item.title}</div>
                    </td>
                    <td className="!text-left">{item.clientName ?? '—'}</td>
                    <td className="!text-left">
                      {item.technician ? `${item.technician.name ?? '—'} #${item.technician.efrId}` : '—'}
                    </td>
                    <td className="!text-left text-xs">
                      {item.report
                        ? `Claim · ${item.report.reasonText ?? item.report.kind}`
                        : item.legacyCancelAsk ? 'Cancel Request' : statusLabel(item.jobStatus)}
                    </td>
                    <td className="!text-left text-xs">{formatDate(item.submittedOn)}</td>
                    <td className="!text-right whitespace-nowrap">
                      {item.report ? (
                        <Button size="sm" onClick={() => { setVerifyReportId(item.report!.id); setVerifyJobTitle(item.title); }}>
                          Verify With Customer
                        </Button>
                      ) : item.legacyCancelAsk ? (
                        <JobRefLink jobId={item.jobId} className="text-sm font-medium text-primary hover:underline">
                          Open Job
                        </JobRefLink>
                      ) : (
                        <Button size="sm" disabled={passing === item.jobId} onClick={() => passAudit(item)}>
                          {passing === item.jobId ? 'Saving…' : 'Pass Audit'}
                        </Button>
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

      <VerifyWithCustomerDialog
        reportId={verifyReportId}
        jobTitle={verifyJobTitle}
        onClose={() => setVerifyReportId(null)}
        onResolved={refreshList}
      />
      <JobModalHost onSaved={refreshList} />
    </div>
  );
}
