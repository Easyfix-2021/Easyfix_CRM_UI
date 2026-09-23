'use client';

/*
 * Custom Reports — report view page.
 *
 *   BE base : /api/admin/quicksight/dynamic-reports/:id
 *   Gate    : ef-QuickSight (family) + isQuickSightDynamicReportView (per-report,
 *             same key the list page and the landing card use) — the BE also
 *             enforces per-report audience (owner/admin/roleIds) and 404s a
 *             report you can't see, which we treat the same as any other load
 *             error (there's nothing more specific to tell the operator).
 *
 * Data fetching is 3 independent `useFetch` calls (mandatory shared hooks —
 * never raw useEffect+api.get):
 *   - detail : GET /:id                      — name, columns, chart def, uploads…
 *   - rows   : GET /:id/rows?...             — the current page of the data table
 *   - chart  : GET /:id/chart?...            — only fired when the report has one
 *
 * `?uploadId=` in the URL drives "view an older upload" (Upload History →
 * View). It re-keys BOTH the rows and chart fetches; nothing else changes.
 * Page/sort/search state resets to page 1 whenever the viewed upload, sort or
 * search term changes (a new result set makes the old page number meaningless).
 *
 * Timestamps (`uploadedAt` etc.) are IST wall-clock strings from the BE —
 * rendered as-is, never re-parsed with `new Date()` (memory: IST date
 * rendering). Row cells are rendered verbatim by <ReportDataTable> for the
 * same reason.
 */

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft, Pencil, UploadCloud, FileSpreadsheet, FileText, Link2, Copy, RefreshCw,
  Trash2, UserCog, Loader2, Eye, Download as DownloadIcon, Lock, Globe, History,
} from 'lucide-react';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { useLookup } from '@/lib/use-lookup';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/StatusChip';
import { CancelButton } from '@/components/ui/cancel-button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SearchSelect } from '@/components/ui/search-select';
import { type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';

import { ReportEditorDialog } from '../ReportEditorDialog';
import { UploadDialog } from './UploadDialog';
import { TransferOwnerDialog } from './TransferOwnerDialog';
import { ReportDataTable } from './ReportDataTable';
import { ReportChart } from './ReportChart';
import { RetentionNote } from './retention-note';
import type { ReportDetail, RowsResponse, ChartResponse } from './types';

const FAMILY_KEY = 'ef-QuickSight';
const ACTION_KEY = 'isQuickSightDynamicReportView';
const API_BASE = '/admin/quicksight/dynamic-reports';

export default function CustomReportViewPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const router = useRouter();
  const searchParams = useSearchParams();

  const { me } = useMe();
  const flags = actionFlags(me, [FAMILY_KEY, ACTION_KEY]);
  const hasAccess = flags[FAMILY_KEY] && flags[ACTION_KEY];

  const uploadIdParam = searchParams.get('uploadId');
  const viewUploadId = uploadIdParam && /^\d+$/.test(uploadIdParam) ? Number(uploadIdParam) : null;

  const detailKey = hasAccess && Number.isFinite(id) ? `${API_BASE}/${id}` : null;
  const detail = useFetch<ReportDetail>(detailKey);
  const d = detail.data;

  // ── rows: server-paged / sorted / searched ──────────────────────────────
  const [page, setPage] = React.useState(0); // 0-indexed (TablePagination convention)
  const [pageSize, setPageSize] = React.useState<TablePageSize>(50);
  const [sortBy, setSortBy] = React.useState('');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('asc');
  const [qInput, setQInput] = React.useState('');
  const q = useDebouncedValue(qInput, 300);

  // A new result set (different upload / sort / search) makes the old page
  // number meaningless — jump back to page 1 rather than fetch a page past
  // the end of the new set.
  React.useEffect(() => { setPage(0); }, [viewUploadId, sortBy, sortDir, q]);

  const rowsKey = React.useMemo(() => {
    if (!hasAccess || !Number.isFinite(id)) return null;
    const qs = new URLSearchParams({
      page: String(page + 1), // BE is 1-indexed
      pageSize: String(pageSizeToLimit(pageSize, 500)),
      sortBy, sortDir,
    });
    if (q) qs.set('q', q);
    if (viewUploadId) qs.set('uploadId', String(viewUploadId));
    return `${API_BASE}/${id}/rows?${qs.toString()}`;
  }, [hasAccess, id, page, pageSize, sortBy, sortDir, q, viewUploadId]);
  const rows = useFetch<RowsResponse>(rowsKey);

  const chartKey = React.useMemo(() => {
    if (!hasAccess || !d?.chart || !Number.isFinite(id)) return null;
    return viewUploadId ? `${API_BASE}/${id}/chart?uploadId=${viewUploadId}` : `${API_BASE}/${id}/chart`;
  }, [hasAccess, d?.chart, id, viewUploadId]);
  const chart = useFetch<ChartResponse>(chartKey);

  const confirm = useConfirm();

  const [editing, setEditing] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [transferring, setTransferring] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);

  function setSort(key: string) {
    if (sortBy === key) setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(key); setSortDir('asc'); }
  }

  function setViewUploadId(next: number | null) {
    const usp = new URLSearchParams(searchParams.toString());
    if (next) usp.set('uploadId', String(next)); else usp.delete('uploadId');
    const qs = usp.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  }

  // invalidateFetch alone only evicts the module cache — it does not refetch
  // an already-mounted useFetch (memory: invalidateFetch ≠ refetch of a
  // mounted useFetch). Call each hook's own refetch() after any mutation.
  function refreshAll() {
    invalidateFetch((k) => k.startsWith(`${API_BASE}/${id}`));
    detail.refetch();
    rows.refetch();
    if (d?.chart) chart.refetch();
  }

  async function handleDownload(uploadId?: number) {
    if (!d) return;
    setDownloading(true);
    try {
      const target = uploadId ?? viewUploadId;
      const qs = target ? `?uploadId=${target}` : '';
      await downloadXlsx({ url: `${API_BASE}/${id}/download${qs}`, filename: `${d.name}.xlsx` });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed' });
    } finally {
      setDownloading(false);
    }
  }

  async function handleDownloadTemplate(format: 'xlsx' | 'csv') {
    if (!d) return;
    try {
      await downloadXlsx({ url: `${API_BASE}/${id}/template?format=${format}`, filename: `${d.name}-template.${format}` });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed' });
    }
  }

  async function handleArchive() {
    if (!d) return;
    const ok = await confirm({
      title: 'Archive This Report?',
      description: 'This report and its uploads will no longer be visible to anyone. This can’t be undone from here.',
      confirmLabel: 'Archive',
      variant: 'destructive',
    });
    if (!ok) return;
    setArchiving(true);
    try {
      await api.delete(`${API_BASE}/${id}`);
      invalidateFetch((k) => k.startsWith(API_BASE));
      showToast({ variant: 'success', message: 'Report archived.' });
      router.push('/quicksight/custom');
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not archive the report' }) });
    } finally {
      setArchiving(false);
    }
  }

  async function handleShareEnable() {
    setSharing(true);
    try {
      await api.post<{ shareToken: string }>(`${API_BASE}/${id}/share`);
      showToast({ variant: 'success', message: 'Public link enabled.' });
      refreshAll();
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not enable the public link' }) });
    } finally {
      setSharing(false);
    }
  }

  async function handleShareDisable() {
    setSharing(true);
    try {
      await api.delete(`${API_BASE}/${id}/share`);
      showToast({ variant: 'success', message: 'Public link disabled.' });
      refreshAll();
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not disable the public link' }) });
    } finally {
      setSharing(false);
    }
  }

  async function handleRegenerate() {
    const ok = await confirm({
      title: 'Regenerate The Public Link?',
      description: 'The current link will stop working immediately — anyone using it will need the new one.',
      confirmLabel: 'Regenerate',
    });
    if (ok) handleShareEnable();
  }

  function copyLink() {
    if (!d?.shareToken) return;
    const url = `${window.location.origin}/public/report/${d.shareToken}`;
    navigator.clipboard.writeText(url)
      .then(() => showToast({ variant: 'success', message: 'Link copied.' }))
      .catch(() => showToast({ variant: 'error', message: 'Could not copy the link.' }));
  }

  async function handleDeleteUpload(uploadId: number) {
    const ok = await confirm({
      title: 'Delete This Upload?',
      description: 'This upload will be permanently removed. This can’t be undone.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.delete(`${API_BASE}/${id}/uploads/${uploadId}`);
      showToast({ variant: 'success', message: 'Upload deleted.' });
      if (viewUploadId === uploadId) setViewUploadId(null);
      refreshAll();
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not delete this upload' }) });
    }
  }

  // ── Access / load states ────────────────────────────────────────────────
  const beDenied = !!detail.error && /permission|access|not found/i.test(detail.error);
  const accessDenied = !hasAccess || (beDenied && !d);

  if (accessDenied) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <Lock className="size-8 text-warning-strong" />
            <div className="space-y-1">
              <div className="text-base font-semibold">Access Denied</div>
              <p className="max-w-md text-sm text-muted-foreground">
                You don&apos;t have permission to view this report.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (detail.loading && !d) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card><CardContent className="flex items-center justify-center gap-2 p-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" /> Loading report…
        </CardContent></Card>
      </div>
    );
  }

  if (!d) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">
          {detail.error || 'This report could not be loaded.'}
        </CardContent></Card>
      </div>
    );
  }

  const viewingHistorical = viewUploadId != null && viewUploadId !== d.current?.id;
  const rowsData = rows.data;
  const tableColumns = rowsData?.columns ?? d.columns;

  return (
    <div className="space-y-4">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <FileSpreadsheet className="size-6 shrink-0" />
            <span className="truncate">{d.name}</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Owner: {d.ownerName ?? '—'}
            {d.current && <> · Last Upload: {d.current.uploadedAt} by {d.current.uploadedByName ?? '—'}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => handleDownload()} disabled={!d.current || downloading}>
            {downloading ? <Loader2 className="mr-1 size-4 animate-spin" /> : <DownloadIcon className="mr-1 size-4" />}
            Download
          </Button>
          {d.canEdit && (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="mr-1 size-4" /> Edit Report
              </Button>
              <Button variant="outline" onClick={() => handleDownloadTemplate('xlsx')}>
                <FileSpreadsheet className="mr-1 size-4" /> Template (XLSX)
              </Button>
              <Button variant="outline" onClick={() => handleDownloadTemplate('csv')}>
                <FileText className="mr-1 size-4" /> Template (CSV)
              </Button>
              <Button onClick={() => setUploading(true)}>
                <UploadCloud className="mr-1 size-4" /> Upload
              </Button>
              <Button variant="destructive" onClick={handleArchive} disabled={archiving}>
                {archiving ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Trash2 className="mr-1 size-4" />}
                Archive
              </Button>
            </>
          )}
          {d.isAdmin && (
            <Button variant="outline" onClick={() => setTransferring(true)}>
              <UserCog className="mr-1 size-4" /> Transfer Owner
            </Button>
          )}
        </div>
      </div>

      <RetentionNote />

      {d.canEdit && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2 text-sm">
              {d.shareToken ? <Globe className="size-4 text-success" /> : <Lock className="size-4 text-muted-foreground" />}
              <span className="font-medium">Public Link</span>
              <span className="text-xs text-muted-foreground">{"Anyone with this link can view and download — role restrictions don't apply."}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {d.shareToken ? (
                <>
                  <Button variant="outline" size="sm" onClick={copyLink}>
                    <Copy className="mr-1 size-4" /> Copy Link
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleRegenerate} disabled={sharing}>
                    <RefreshCw className="mr-1 size-4" /> Regenerate
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleShareDisable} disabled={sharing}>
                    Disable
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="sm" onClick={handleShareEnable} disabled={sharing}>
                  <Link2 className="mr-1 size-4" /> Enable Public Link
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {viewingHistorical && (
        <Card className="border-warning-strong/40 bg-warning-tint">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
            <span className="text-sm">Viewing upload of {d.uploads.find((u) => u.id === viewUploadId)?.uploadedAt ?? '—'}</span>
            <Button variant="outline" size="sm" onClick={() => setViewUploadId(null)}>Back To Current</Button>
          </CardContent>
        </Card>
      )}

      {d.chart && chart.data && <ReportChart data={chart.data} />}

      <ReportDataTable
        columns={tableColumns}
        rows={rowsData?.rows ?? []}
        total={rowsData?.total ?? 0}
        loading={rows.loading}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
        sortBy={sortBy}
        sortDir={sortDir}
        onSortChange={setSort}
        q={qInput}
        onSearchChange={setQInput}
      />

      <UploadHistory
        uploads={d.uploads}
        currentId={d.current?.id ?? null}
        viewingId={viewUploadId}
        canEdit={d.canEdit}
        onView={(uid) => setViewUploadId(uid === d.current?.id ? null : uid)}
        onDownload={(uid) => handleDownload(uid)}
        onDelete={handleDeleteUpload}
      />

      {editing && (
        <ReportEditorDialog
          mode="edit"
          report={d}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); refreshAll(); }}
        />
      )}
      {uploading && (
        <UploadDialog
          reportId={id}
          current={d.current}
          columnsChanged={d.columnsChanged}
          onClose={() => setUploading(false)}
          onUploaded={() => { setUploading(false); refreshAll(); }}
        />
      )}
      {transferring && (
        <TransferOwnerDialog
          reportId={id}
          currentOwnerId={d.ownerId}
          onClose={() => setTransferring(false)}
          onTransferred={() => { setTransferring(false); refreshAll(); }}
        />
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/quicksight/custom" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
      <ArrowLeft className="size-4" /> Custom Reports
    </Link>
  );
}

/* ── Upload History ───────────────────────────────────────────────────── */

function UploadHistory({
  uploads, currentId, viewingId, canEdit, onView, onDownload, onDelete,
}: {
  uploads: ReportDetail['uploads'];
  currentId: number | null;
  viewingId: number | null;
  canEdit: boolean;
  onView: (uploadId: number) => void;
  onDownload: (uploadId: number) => void;
  onDelete: (uploadId: number) => void;
}) {
  return (
    <div className="space-y-2">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <History className="size-4" /> Upload History
      </h2>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="data-table">
          <thead>
            <tr>
              <th className="!text-left">Date</th>
              <th className="!text-left">By</th>
              <th className="!text-left">Mode</th>
              <th className="!text-right">Rows</th>
              <th className="!text-right">+ Added</th>
              <th className="!text-left">File</th>
              <th className="!text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {uploads.length === 0 ? (
              <tr><td colSpan={7} className="text-center text-muted-foreground">No uploads yet.</td></tr>
            ) : (
              uploads.map((u) => (
                <tr key={u.id} className={u.id === viewingId ? 'bg-muted/50' : undefined}>
                  <td className="!text-left whitespace-nowrap">
                    {u.uploadedAt}
                    {u.isCurrent && <StatusChip tone="success" size="sm" className="ml-2">Current</StatusChip>}
                  </td>
                  <td className="!text-left">{u.uploadedByName ?? '—'}</td>
                  <td className="!text-left capitalize">{u.mode}</td>
                  <td className="!text-right">{u.rowCount.toLocaleString('en-IN')}</td>
                  <td className="!text-right">{u.addedRows.toLocaleString('en-IN')}</td>
                  <td className="!text-left truncate max-w-[220px]" title={u.originalName}>{u.originalName}</td>
                  <td className="!text-left">
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => onView(u.id)} title="View">
                        <Eye className="size-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onDownload(u.id)} title="Download">
                        <DownloadIcon className="size-4" />
                      </Button>
                      {canEdit && (
                        <Button variant="ghost" size="sm" onClick={() => onDelete(u.id)} title="Delete">
                          <Trash2 className="size-4 text-urgent" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Transfer Owner (Admin only) ──────────────────────────────────────── */
