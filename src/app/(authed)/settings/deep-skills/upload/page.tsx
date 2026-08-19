'use client';

/*
 * Bulk Deep Skill Upload
 * ──────────────────────
 * Operators upload an .xlsx of Service Category → Service Type → Deep
 * Skill (+ options + tag words), see a dry-run preview, then commit.
 *
 * Backend contract:
 *   POST /api/admin/deep-skills/bulk-upload           (preview)
 *   POST /api/admin/deep-skills/bulk-upload?commit=true (commit)
 *   Multipart `file` (single .xlsx).
 *
 * UX mirrors the established `jobs/upload` page:
 *   step 1 — pick file (immediately fires dry-run)
 *   step 2 — review summary + per-row table
 *   step 3 — commit (confirm dialog) → success card
 */

import { Fragment, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { UploadCloud, FileSpreadsheet, ArrowLeft, CheckCircle2, Download, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { StatusChip } from '@/components/ui/StatusChip';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

// ─── Response shape (mirrors the BE contract) ────────────────────────
type RowStatus = 'ok' | 'skip' | 'error';

type BulkUploadRow = {
  rowNumber: number;
  category: string;
  type: string;
  skill: string;
  options: string[];
  tagWords: string;
  status: RowStatus;
  errors: string[];
};

type BulkUploadSummary = {
  totalRows: number;
  willCreate: number;
  willSkip: number;
  errors: number;
  categoriesNew: number;
  typesNew: number;
  skillsNew: number;
  optionsNew: number;
};

/*
 * BulkUploadCommitted (2026-06-10 shape update). After the case-
 * insensitive matching refactor, the BE now returns the full
 * { id, name } objects for newly-created categories and types — not
 * bare strings. The FE renders the names with `.map(x => x.name).join(...)`.
 *
 * Old shape: categoriesCreated: string[] (caused `[object Object]`
 * console output because the original `.join(', ')` stringified the
 * raw objects).
 */
type BulkUploadCommitted = {
  categoriesCreated: Array<{ id: number; name: string }>;
  typesCreated: Array<{ id: number; name: string; catId?: number }>;
  skillsCreated: number;
  optionsCreated: number;
};

type BulkUploadResponse = {
  mode: 'preview' | 'commit';
  summary: BulkUploadSummary;
  rows: BulkUploadRow[];
  committed?: BulkUploadCommitted;
};

// ─── Status → StatusChip tone mapping ───────────────────────────────
const STATUS_TONE: Record<RowStatus, 'emerald' | 'slate' | 'red'> = {
  ok: 'emerald',
  skip: 'slate',
  error: 'red',
};
const STATUS_LABEL: Record<RowStatus, string> = {
  ok: 'OK',
  skip: 'Skip',
  error: 'Error',
};

export default function DeepSkillsBulkUploadPage() {
  const { me } = useMe();
  const confirm = useConfirm();
  // Reuse the existing action flag — same one that gates Add Deep Skill.
  const can = actionFlags(me, ['isDeepSkillAddNew']);

  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BulkUploadResponse | null>(null);
  const [committed, setCommitted] = useState<BulkUploadResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-row table pagination — preview tables can run 100+ rows.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  // Template download in-flight indicator — disables the button so a
  // double-click doesn't fire two parallel fetches. (The per-row
  // view-raw expansion state lives inside PreviewRowsTable below.)
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);

  // ─── Permission gate ──────────────────────────────────────────────
  if (me && !can.isDeepSkillAddNew) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Bulk Upload Deep Skills</h1>
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-sm text-muted-foreground">
              You don&apos;t have permission to upload deep skills.
            </p>
            <Link
              href="/settings/deep-skills"
              className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Manage Deep Skills
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ─── Handlers ─────────────────────────────────────────────────────
  async function runPreview(picked: File) {
    setLoading(true);
    setError(null);
    setPreview(null);
    setCommitted(null);
    setPage(0);
    try {
      const fd = new FormData();
      fd.append('file', picked);
      const res = await api.post<BulkUploadResponse>(
        '/admin/deep-skills/bulk-upload',
        fd,
      );
      setPreview(res);
    } catch (e) {
      setError(formatApiError(e, { fallback: 'Preview failed' }));
    } finally {
      setLoading(false);
    }
  }

  function handlePick(picked: File | null) {
    if (!picked) return;
    setFile(picked);
    void runPreview(picked);
  }

  /*
   * Template download (2026-06-06). Hits the new BE endpoint
   * GET /admin/deep-skills/upload-template which streams a blank
   * .xlsx in the exact ops shape (decorative row 1 + column-header
   * row 2 with the parser-anchor strings + example placeholder row).
   *
   * Plain `<a href download>` won't work because the endpoint is
   * gated by the admin-group middleware that reads the JWT from the
   * `Authorization` header — anchor links don't carry custom headers.
   * The standard CRM pattern (see JobImageTile in JobModal.tsx) is
   * fetch → blob → object URL → synthetic anchor click → revoke.
   */
  async function downloadTemplate() {
    if (downloadingTemplate) return;
    setDownloadingTemplate(true);
    setError(null);
    try {
      const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5100/api';
      const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
      const res = await fetch(`${base}/admin/deep-skills/upload-template`, {
        method: 'GET',
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        throw new Error(`Template download failed (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'deep-skills-bulk-upload-template.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a tick so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Template download failed');
    } finally {
      setDownloadingTemplate(false);
    }
  }

  function resetAll() {
    setFile(null);
    setPreview(null);
    setCommitted(null);
    setError(null);
    setPage(0);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function commitUpload() {
    if (!file || !preview) return;
    const ok = await confirm({
      title: 'Commit Upload?',
      description: `This will create ${preview.summary.willCreate} skill${
        preview.summary.willCreate === 1 ? '' : 's'
      } (${preview.summary.categoriesNew} new categories, ${preview.summary.typesNew} new types, ${preview.summary.optionsNew} new options). Continue?`,
      confirmLabel: 'Commit',
    });
    if (!ok) return;

    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.post<BulkUploadResponse>(
        '/admin/deep-skills/bulk-upload?commit=true',
        fd,
      );
      setCommitted(res);
      showToast({ variant: 'success', message: 'Upload committed' });
    } catch (e) {
      setError(formatApiError(e, { fallback: 'Commit failed' }));
    } finally {
      setLoading(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bulk Upload Deep Skills</h1>
          <p className="text-sm text-muted-foreground">
            Upload an .xlsx of Service Category → Service Type → Deep Skill (+
            options + tag words). Pick a file to see a dry-run preview, then
            commit.
          </p>
        </div>
        <Link
          href="/settings/deep-skills"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Manage Deep Skills
        </Link>
      </div>

      {/* ─── Step 1 — Picker ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Choose Spreadsheet</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">.xlsx File (row 1 = header, data from row 2)</Label>
              <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="block text-sm"
                  onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
                  disabled={loading}
                />
                {/* Download Template — always visible so operators can
                    grab the canonical .xlsx shape BEFORE picking a
                    file. Mirrors the jobs/upload UX pattern; fetches
                    via authenticated request (not a plain anchor link)
                    so the admin-group guard doesn't 401. */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={downloadTemplate}
                  disabled={downloadingTemplate}
                  title="Download a blank .xlsx in the expected column shape"
                >
                  <Download className="h-3.5 w-3.5 mr-1" />
                  {downloadingTemplate ? 'Preparing…' : 'Download Template'}
                </Button>
                {/* "Pick Another File" button removed 2026-06-06 —
                    the native <input type="file"> Choose-File button
                    already lets the operator re-pick at any time;
                    the duplicate Button was redundant chrome.
                    `resetAll` is still wired to the "Upload Another
                    File" button in the success step below. */}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Columns: Service Category · Service Type · Deep Skill · Options
                (comma-separated) · Tag Words
              </p>
            </div>
            {file && (
              <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                <FileSpreadsheet className="h-3.5 w-3.5" /> {file.name}
              </div>
            )}
            {loading && !preview && !committed && (
              <div className="text-sm text-muted-foreground">Validating…</div>
            )}
            {error && <div className="text-sm text-destructive">{error}</div>}
          </div>
        </CardContent>
      </Card>

      {/* ─── Step 4 — Committed result ────────────────────────────── */}
      {committed && committed.committed && (
        <Card>
          <CardHeader>
            <CardTitle>
              <span className="inline-flex items-center gap-1.5 text-success-strong">
                <CheckCircle2 className="h-5 w-5" /> Upload Committed
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <Stat
                label="Categories Created"
                v={committed.committed.categoriesCreated.length}
                tint="bg-success-tint text-success-strong"
              />
              <Stat
                label="Types Created"
                v={committed.committed.typesCreated.length}
                tint="bg-success-tint text-success-strong"
              />
              <Stat
                label="Skills Created"
                v={committed.committed.skillsCreated}
                tint="bg-success-tint text-success-strong"
              />
              <Stat
                label="Options Created"
                v={committed.committed.optionsCreated}
                tint="bg-success-tint text-success-strong"
              />
            </div>
            {committed.committed.categoriesCreated.length > 0 && (
              <div className="mb-2 text-xs">
                <span className="font-medium">New Categories:</span>{' '}
                <span className="text-muted-foreground">
                  {committed.committed.categoriesCreated.map((c) => `${c.name} (Id: ${c.id})`).join(', ')}
                </span>
              </div>
            )}
            {committed.committed.typesCreated.length > 0 && (
              <div className="mb-3 text-xs">
                <span className="font-medium">New Types:</span>{' '}
                <span className="text-muted-foreground">
                  {committed.committed.typesCreated.map((t) => `${t.name} (Id: ${t.id})`).join(', ')}
                </span>
              </div>
            )}
            <div className="flex gap-2 pt-2 border-t">
              <Link href="/settings/deep-skills">
                <Button size="sm">
                  <ArrowLeft className="h-4 w-4 mr-1" /> Back to Manage Deep Skills
                </Button>
              </Link>
              <Button type="button" variant="outline" size="sm" onClick={resetAll}>
                <UploadCloud className="h-4 w-4 mr-1" /> Upload Another File
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Step 2 + 3 — Preview + Commit ────────────────────────── */}
      {preview && !committed && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>
                Preview ·{' '}
                <span className="text-sm font-normal text-muted-foreground">
                  Dry run — no changes saved yet
                </span>
              </CardTitle>
              <Button
                type="button"
                onClick={commitUpload}
                disabled={loading || preview.summary.willCreate === 0}
                size="sm"
              >
                <UploadCloud className="h-4 w-4 mr-1" />
                {loading ? 'Committing…' : 'Commit Upload'}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <PreviewSummary summary={preview.summary} />
            <PreviewRowsTable
              rows={preview.rows}
              page={page}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(s) => {
                setPageSize(s);
                setPage(0);
              }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Summary tiles ──────────────────────────────────────────────────
function PreviewSummary({ summary }: { summary: BulkUploadSummary }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
      <Stat label="Total Rows" v={summary.totalRows} tint="bg-ink-100" />
      <Stat
        label="Will Create"
        v={summary.willCreate}
        tint="bg-success-tint text-success-strong"
      />
      <Stat
        label="Will Skip"
        v={summary.willSkip}
        tint="bg-ink-100 text-ink-700"
      />
      <Stat
        label="Errors"
        v={summary.errors}
        tint={summary.errors > 0 ? 'bg-urgent-tint text-urgent-strong' : 'bg-ink-100'}
      />
      <Stat
        label="Categories New"
        v={summary.categoriesNew}
        tint="bg-info-tint text-info-strong"
      />
      <Stat
        label="Types New"
        v={summary.typesNew}
        tint="bg-info-tint text-info-strong"
      />
    </div>
  );
}

function Stat({
  label,
  v,
  tint,
}: {
  label: string;
  v: number | string;
  tint: string;
}) {
  return (
    <div className={`rounded-lg p-3 ${tint}`}>
      <div className="text-2xl font-semibold tabular-nums">{v}</div>
      <div className="text-xs opacity-80">{label}</div>
    </div>
  );
}

// ─── Row table ──────────────────────────────────────────────────────
function PreviewRowsTable({
  rows,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  rows: BulkUploadRow[];
  page: number;
  pageSize: TablePageSize;
  onPageChange: (p: number) => void;
  onPageSizeChange: (s: TablePageSize) => void;
}) {
  const effectiveLimit =
    pageSize === 'all' ? Math.max(rows.length, 1) : pageSizeToLimit(pageSize);
  const totalPages = Math.max(1, Math.ceil(rows.length / effectiveLimit));
  const safePage = Math.min(page, totalPages - 1);
  const visible = rows.slice(
    safePage * effectiveLimit,
    safePage * effectiveLimit + effectiveLimit,
  );
  /*
   * Per-row "view raw" toggle (2026-06-06). Tracks the rowNumber of
   * the currently-expanded preview row so long Joi error messages
   * don't get visually truncated in the narrow Errors cell. Only one
   * row open at a time so the table stays compact; clicking the same
   * chevron a second time collapses it. State lives inside this
   * child so the parent doesn't re-render on every chevron click.
   */
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  return (
    <>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="!text-right">Row #</th>
              <th>Category</th>
              <th>Type</th>
              <th>Skill</th>
              <th>Options</th>
              <th>Tag Words</th>
              <th className="!text-center">Status</th>
              <th>Errors</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center py-8 text-muted-foreground">
                  No rows parsed from the spreadsheet
                </td>
              </tr>
            )}
            {visible.map((r) => {
              const hasErrors = r.errors && r.errors.length > 0;
              const isExpanded = expandedRow === r.rowNumber;
              // Show the chevron when there's ANY detail worth expanding
              // — errors (the primary case) OR a skip-reason in the
              // errors[] array (BE uses errors[] for both classes).
              const canExpand = hasErrors;
              return (
                <Fragment key={r.rowNumber}>
                  <tr>
                    <td className="!text-right tabular-nums text-xs">{r.rowNumber}</td>
                    <td>{r.category || '—'}</td>
                    <td>{r.type || '—'}</td>
                    <td className="font-medium">{r.skill || '—'}</td>
                    <td className="text-xs">
                      <OptionsCell options={r.options} />
                    </td>
                    <td className="text-xs">{r.tagWords || '—'}</td>
                    <td className="!text-center">
                      <StatusChip tone={STATUS_TONE[r.status]}>
                        {STATUS_LABEL[r.status]}
                      </StatusChip>
                    </td>
                    <td className={cn(
                      'text-xs',
                      r.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
                    )}>
                      {canExpand ? (
                        <button
                          type="button"
                          onClick={() => setExpandedRow(isExpanded ? null : r.rowNumber)}
                          className="inline-flex items-center gap-1 hover:underline text-left"
                          aria-expanded={isExpanded}
                          title={isExpanded ? 'Hide full details' : 'Show full row details'}
                        >
                          {isExpanded
                            ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                            : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                          <span className="truncate max-w-[18rem]">
                            {r.errors.join(', ')}
                          </span>
                        </button>
                      ) : ''}
                    </td>
                  </tr>
                  {/*
                    * View-raw detail sub-row (2026-06-06). When the
                    * operator clicks the chevron we render an inset
                    * panel BELOW the data row showing the full per-
                    * row report — handy when Joi error messages run
                    * 200+ chars and would otherwise truncate at the
                    * cell width. colSpan covers all 8 columns so the
                    * panel stretches edge-to-edge for easy reading.
                    */}
                  {isExpanded && (
                    <tr key={`${r.rowNumber}-detail`} className="bg-muted/40">
                      <td colSpan={8} className="py-3 px-4 text-xs">
                        <dl className="grid grid-cols-1 md:grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5">
                          <dt className="font-semibold text-muted-foreground">Row #</dt>
                          <dd className="tabular-nums">{r.rowNumber}</dd>
                          <dt className="font-semibold text-muted-foreground">Category</dt>
                          <dd>{r.category || '(empty)'}</dd>
                          <dt className="font-semibold text-muted-foreground">Type</dt>
                          <dd>{r.type || '(empty)'}</dd>
                          <dt className="font-semibold text-muted-foreground">Skill</dt>
                          <dd>{r.skill || '(empty)'}</dd>
                          <dt className="font-semibold text-muted-foreground">Options</dt>
                          <dd>
                            {r.options && r.options.length > 0
                              ? r.options.join(' · ')
                              : '(none)'}
                          </dd>
                          <dt className="font-semibold text-muted-foreground">Tag Words</dt>
                          <dd>{r.tagWords || '(empty)'}</dd>
                          <dt className="font-semibold text-muted-foreground">Errors</dt>
                          <dd className="text-destructive">
                            <ul className="list-disc list-inside space-y-0.5">
                              {r.errors.map((msg, i) => (
                                <li key={i} className="whitespace-pre-wrap break-words">{msg}</li>
                              ))}
                            </ul>
                          </dd>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-1 py-2 border-t mt-2">
        <TablePagination
          page={safePage}
          pageSize={pageSize}
          total={rows.length}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      </div>
    </>
  );
}

// Truncated options cell — show first 3 then "+N" overflow.
function OptionsCell({ options }: { options: string[] }) {
  if (!options || options.length === 0) return <span>—</span>;
  const head = options.slice(0, 3);
  const overflow = options.length - head.length;
  return (
    <span>
      {head.join(', ')}
      {overflow > 0 && (
        <span className="ml-1 text-muted-foreground">+{overflow}</span>
      )}
    </span>
  );
}
