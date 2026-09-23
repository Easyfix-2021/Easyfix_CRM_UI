'use client';

/*
 * Public Custom Report share page — `/public/report/<token>`.
 *
 * Auth model: the share token in the URL IS the entire credential — no
 * Authorization header, no localStorage token. We use the bare `publicFetch`
 * helper (never `@/lib/api`) so a staff CRM bearer sitting in localStorage on
 * a shared/public machine never leaks onto this unauthenticated route (same
 * reasoning as the job-completion / profile-update magic-link pages).
 *
 * Reuses <ReportDataTable> / <ReportChart> / <RetentionNote> from the authed
 * report view page — they're pure presentational components (props only, no
 * auth-dependent hooks), so they work here unchanged; only the DATA FETCHING
 * differs (publicFetch + local state instead of useFetch).
 */

import * as React from 'react';
import { useParams } from 'next/navigation';
import { FileSpreadsheet } from 'lucide-react';

import { publicFetch } from '@/lib/public-fetch';
import { useDebouncedValue } from '@/lib/hooks';
import { downloadXlsx } from '@/lib/download-xlsx';
import { FullPageMessage } from '@/components/public/FullPageMessage';
import { showToast, ToastHost } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';

import { ReportDataTable } from '../../../(authed)/quicksight/custom/[id]/ReportDataTable';
import { ReportChart } from '../../../(authed)/quicksight/custom/[id]/ReportChart';
import { RetentionNote } from '../../../(authed)/quicksight/custom/[id]/retention-note';
import type { PublicReportDetail, RowsResponse, ChartResponse } from '../../../(authed)/quicksight/custom/[id]/types';

type PageState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PublicReportDetail }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

export default function PublicCustomReportPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [state, setState] = React.useState<PageState>({ kind: 'loading' });

  React.useEffect(() => {
    let cancelled = false;
    publicFetch<PublicReportDetail>(`/public/dynamic-report/${encodeURIComponent(token)}`)
      .then((data) => { if (!cancelled) setState({ kind: 'ready', data }); })
      .catch((e: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (e.status === 404) setState({ kind: 'not_found' });
        else setState({ kind: 'error', message: e.message || 'Something went wrong.' });
      });
    return () => { cancelled = true; };
  }, [token]);

  // ── rows: server-paged / sorted / searched, same query shape as the authed page ──
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(50);
  const [sortBy, setSortBy] = React.useState('');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('asc');
  const [qInput, setQInput] = React.useState('');
  const q = useDebouncedValue(qInput, 300);
  React.useEffect(() => { setPage(0); }, [sortBy, sortDir, q]);

  const [rows, setRows] = React.useState<{ data: RowsResponse | null; loading: boolean }>({ data: null, loading: true });
  React.useEffect(() => {
    if (state.kind !== 'ready') return;
    let cancelled = false;
    setRows((r) => ({ data: r.data, loading: true }));
    const qs = new URLSearchParams({
      page: String(page + 1), // BE is 1-indexed
      pageSize: String(pageSizeToLimit(pageSize, 500)),
      sortBy, sortDir,
    });
    if (q) qs.set('q', q);
    publicFetch<RowsResponse>(`/public/dynamic-report/${encodeURIComponent(token)}/rows?${qs.toString()}`)
      .then((data) => { if (!cancelled) setRows({ data, loading: false }); })
      .catch(() => { if (!cancelled) setRows((r) => ({ data: r.data, loading: false })); });
    return () => { cancelled = true; };
  }, [state, token, page, pageSize, sortBy, sortDir, q]);

  const [chart, setChart] = React.useState<ChartResponse | null>(null);
  React.useEffect(() => {
    if (state.kind !== 'ready' || !state.data.chart) return;
    let cancelled = false;
    publicFetch<ChartResponse>(`/public/dynamic-report/${encodeURIComponent(token)}/chart`)
      .then((data) => { if (!cancelled) setChart(data); })
      .catch(() => { /* non-fatal: the table still renders without a chart */ });
    return () => { cancelled = true; };
  }, [state, token]);

  const [downloading, setDownloading] = React.useState(false);
  async function handleDownload() {
    if (state.kind !== 'ready') return;
    setDownloading(true);
    try {
      await downloadXlsx({
        url: `/public/dynamic-report/${encodeURIComponent(token)}/download`,
        filename: `${state.data.name}.xlsx`,
      });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed' });
    } finally {
      setDownloading(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <FullPageMessage title="Loading…" message="Fetching this report." />
      </div>
    );
  }
  if (state.kind === 'not_found') {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <FullPageMessage
          title="Link Not Available"
          message="This report link is not available. It may have been revoked, or the report archived."
        />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <FullPageMessage title="Something Went Wrong" message={state.message} retry />
      </div>
    );
  }

  const d = state.data;
  const columns = rows.data?.columns ?? d.columns;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <FileSpreadsheet className="size-6 shrink-0" />
          <span className="truncate">{d.name}</span>
        </h1>
        <Button variant="outline" onClick={handleDownload} disabled={!d.current || downloading}>
          {downloading ? 'Preparing…' : 'Download'}
        </Button>
      </div>

      <RetentionNote />

      {d.chart && chart && <ReportChart data={chart} />}

      <ReportDataTable
        columns={columns}
        rows={rows.data?.rows ?? []}
        total={rows.data?.total ?? 0}
        loading={rows.loading}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
        sortBy={sortBy}
        sortDir={sortDir}
        onSortChange={(key) => {
          if (sortBy === key) setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
          else { setSortBy(key); setSortDir('asc'); }
        }}
        q={qInput}
        onSearchChange={setQInput}
      />

      {/* ToastHost lives at the page root — the public layout doesn't mount
          one (only the authed layout does), same pattern as profile-update. */}
      <ToastHost />
    </div>
  );
}
