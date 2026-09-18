'use client';

/*
 * QuickSight — Employee Performance: "Upload Excel" and its check dialog.
 *
 * THE FLOW (owner decision, final — no Python, no .bat, no data.js):
 *   Download Template → fill the five MIS sheets → Upload Excel → pick the
 *   .xlsx → the backend checks every sheet and row WITHOUT saving
 *   (POST /live/upload?dryRun=true) → this dialog shows the report → Confirm →
 *   POST /live/upload?dryRun=false saves it in one transaction.
 *
 * The same shape as the Pincodes / Deep Skills upload pages (pick → automatic
 * dry-run → review → commit), in a Dialog because it belongs to a report tab:
 *
 *   - Verdict: errors BLOCK the save (Confirm stays disabled); warnings do not.
 *   - Sheets: one row per MIS sheet — rows read, errors, warnings; click a sheet
 *     to list its row-level issues (row, column, message).
 *   - What will change: per month, emp detail added / updated and target rows
 *     overwritten or replaced, rows that stay hidden (person not on that
 *     month's emp detail); and every stored TimeChamp / IVR DATE the file
 *     replaces (daily sheets replace a date wholesale).
 *
 * The server re-runs the whole check when saving (it never trusts this
 * preview), so a save can still come back blocked — the fresh report then
 * replaces the one on screen. 409 = someone else is saving; 503 = the upload
 * storage is not set up on this server yet (its message is shown as sent).
 *
 * Gating: the caller renders this only for isQuickSightEmployeePerformanceUpload.
 */

import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Info, Loader2, Upload, XCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/StatusChip';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { cn } from '@/lib/utils';
import { uploadUrl } from './api';
import { fmtDay, fmtMonth, num } from './format';
import { LocalTable, SubHeading, type Column } from './sections/shared';
import type {
  UploadCommitResult, UploadIssue, UploadMonthSummary, UploadOverwrite, UploadPreview, UploadSheetReport,
} from './types';

/* What each MIS sheet does on save (uploads.service.js write rules). */
const SHEET_RULE: Record<string, string> = {
  'target list': 'Monthly — sets each person’s target for the month',
  'emp detail': 'Monthly — adds or updates each person and team for the month',
  'Secondary spoc target list': 'Monthly — sets each person’s target for the month',
  'time champ data': 'Daily — replaces every date in the file',
  'ivr data record': 'Daily — replaces every date in the file',
};

const SOURCE_LABEL: Record<UploadOverwrite['source'], string> = {
  timechamp: 'time champ data',
  ivr: 'ivr data record',
};

type Phase = 'checking' | 'preview' | 'saving' | 'failed';
/* hint: what to do next, shown under the banner when there is no report to show. */
type Problem = { title: string; message: string; tone: 'urgent' | 'warning'; hint: string };

const MB = 1024 * 1024;

function fileSize(bytes: number): string {
  return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function detailsOf(err: ApiError): { code?: unknown; preview?: unknown } {
  return err.details && typeof err.details === 'object' ? err.details as { code?: unknown; preview?: unknown } : {};
}

function isPreview(value: unknown): value is UploadPreview {
  return !!value && typeof value === 'object'
    && Array.isArray((value as UploadPreview).sheets) && typeof (value as UploadPreview).blocking === 'boolean';
}

const FIX_FILE_HINT = 'Download the template, fill the five sheets and choose the file again.';

function problemOf(err: unknown, title: string): Problem {
  if (!(err instanceof ApiError)) {
    return { title, message: 'Something went wrong — please try again.', tone: 'urgent', hint: 'Choose the file again.' };
  }
  const { code } = detailsOf(err);
  if (err.status === 503 || code === 'QS_EP_STORAGE_MISSING') {
    return { title: 'Upload Storage Is Not Set Up Yet', message: err.message, tone: 'warning',
      hint: 'The file could not be checked or saved. Upload it again once the storage is set up; job and CRM numbers are not affected.' };
  }
  if (err.status === 409 || code === 'QS_EP_UPLOAD_BUSY') {
    return { title: 'Another Upload Is Being Saved', message: err.message, tone: 'warning', hint: 'Try again in a moment.' };
  }
  return { title, message: err.message, tone: 'urgent', hint: FIX_FILE_HINT };
}

/* The sheet whose issues open first: the first with errors, else with warnings. */
function firstSheetWithIssues(preview: UploadPreview): string | null {
  const hit = preview.sheets.find((s) => s.errorCount > 0) ?? preview.sheets.find((s) => s.warningCount > 0);
  return (hit ?? preview.sheets[0])?.name ?? null;
}

function savedMessage(saved: UploadCommitResult['saved']): string {
  const parts = [
    ['emp detail', saved.empDetail],
    ['target list', saved.primaryTargets],
    ['Secondary spoc target list', saved.secondaryTargets],
    ['time champ data', saved.timechamp],
    ['ivr data record', saved.ivr],
  ].filter(([, n]) => Number(n) > 0).map(([label, n]) => `${label} ${num(Number(n))}`);
  return parts.length ? `Upload saved — rows saved: ${parts.join(' · ')}` : 'Upload saved';
}

/**
 * The "Upload Excel" button, its hidden file input and the check dialog.
 * `onSaved` runs after a successful save (the caller refreshes the report).
 */
export function UploadExcelButton({ onSaved }: { onSaved: (result: UploadCommitResult) => void }) {
  const input = useRef<HTMLInputElement>(null);
  // Answers to an older pick (or a closed dialog) must not land on the current one.
  const attempt = useRef(0);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('checking');
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);

  const busy = phase === 'checking' || phase === 'saving';
  const hasRows = !!preview && preview.sheets.some((s) => s.rows > 0);
  const canConfirm = phase === 'preview' && !!preview && !preview.blocking && hasRows;

  const pickFile = () => input.current?.click();

  const showPreview = (next: UploadPreview) => {
    setPreview(next);
    setSheet(firstSheetWithIssues(next));
    setPhase('preview');
  };

  const check = async (picked: File) => {
    const id = ++attempt.current;
    setFile(picked);
    setOpen(true);
    setPreview(null);
    setProblem(null);
    setSheet(null);
    if (!/\.xlsx$/i.test(picked.name)) {
      setProblem({ title: 'This Is Not An .xlsx File', message: 'Only the filled .xlsx template is accepted.', tone: 'urgent', hint: FIX_FILE_HINT });
      setPhase('failed');
      return;
    }
    setPhase('checking');
    try {
      const fd = new FormData();
      fd.append('file', picked);
      const next = await api.post<UploadPreview>(uploadUrl(true), fd);
      if (attempt.current === id) showPreview(next);
    } catch (err) {
      if (attempt.current !== id) return;
      setProblem(problemOf(err, 'Couldn’t Check This File'));
      setPhase('failed');
    }
  };

  const onFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = ''; // picking the same file again (after fixing it) must still fire
    if (picked) void check(picked);
  };

  const save = async () => {
    if (!file || !canConfirm) return;
    const id = ++attempt.current;
    setPhase('saving');
    setProblem(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const result = await api.post<UploadCommitResult>(uploadUrl(false), fd);
      if (attempt.current !== id) return;
      showToast({ variant: 'success', message: savedMessage(result.saved) });
      setOpen(false);
      onSaved(result);
    } catch (err) {
      if (attempt.current !== id) return;
      // Blocked on the server's own re-check: its fresh report replaces this one.
      const { preview: fresh } = err instanceof ApiError ? detailsOf(err) : { preview: undefined };
      if (isPreview(fresh)) showPreview(fresh);
      else setPhase(preview ? 'preview' : 'failed');
      setProblem(problemOf(err, 'The Upload Was Not Saved'));
    }
  };

  // A save in flight cannot be abandoned; a checked, saveable file asks first.
  const close = () => {
    if (phase === 'saving') return;
    attempt.current += 1;
    setOpen(false);
  };
  const handleOpenChange = useFormDirtyGuard(close, {
    isDirty: () => canConfirm,
    when: () => phase !== 'saving',
    title: 'Discard This Upload?',
    description: 'The file has been checked, but nothing is saved until you confirm.',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep Reviewing',
  });

  const confirmTitle = phase !== 'preview' || !preview
    ? undefined
    : preview.blocking
      ? 'Fix the errors in the file and upload it again'
      : !hasRows
        ? 'The file has no rows to save'
        : undefined;

  return (
    <>
      <input ref={input} type="file" accept=".xlsx" className="hidden" onChange={onFilePicked} />
      {/* gap-1.5 like DownloadButton — the Button base class sets no gap itself. */}
      <Button size="sm" className="gap-1.5" onClick={pickFile} disabled={open && busy}>
        <Upload className="size-4" />Upload Excel
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        {/* Pinned pattern (settings/manage-roles): header and footer stay put, the body scrolls. */}
        <DialogContent className="max-w-5xl flex flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>Upload Employee Performance Excel</DialogTitle>
            <DialogDescription>
              {file ? `${file.name} · ${fileSize(file.size)}` : 'The filled template'}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {problem && <ProblemBanner problem={problem} />}

            {phase === 'checking' && (
              <StateMessage
                icon={<Loader2 className="size-7 animate-spin text-muted-foreground" />}
                title="Checking The File…"
                message="Every sheet and row is being checked. Nothing is saved yet."
              />
            )}

            {phase === 'failed' && !preview && (
              <StateMessage
                icon={<FileSpreadsheet className="size-7 text-muted-foreground" />}
                title="Nothing Was Saved"
                message={problem?.hint ?? FIX_FILE_HINT}
              />
            )}

            {preview && (phase === 'preview' || phase === 'saving') && (
              <PreviewReport
                preview={preview}
                hasRows={hasRows}
                sheet={sheet}
                onSheet={setSheet}
                dim={phase === 'saving'}
              />
            )}
          </div>

          <DialogFooter className="shrink-0 flex-wrap justify-between">
            <Button type="button" variant="outline" className="gap-1.5" onClick={pickFile} disabled={busy}>
              <FileSpreadsheet className="size-4" />Choose Another File
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={phase === 'saving'}>
                Cancel
              </Button>
              <Button type="button" className="gap-1.5" onClick={save} disabled={!canConfirm} title={confirmTitle}>
                {phase === 'saving'
                  ? <><Loader2 className="size-4 animate-spin" />Saving…</>
                  : <><CheckCircle2 className="size-4" />Confirm &amp; Save</>}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ── pieces ───────────────────────────────────────────────────────────────── */

function StateMessage({ icon, title, message }: { icon: ReactNode; title: string; message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {icon}
      <div className="text-sm font-semibold">{title}</div>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function ProblemBanner({ problem }: { problem: Problem }) {
  const urgent = problem.tone === 'urgent';
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
        urgent ? 'border-urgent/30 bg-urgent-tint text-urgent-strong' : 'border-warning/30 bg-warning-tint text-warning-strong',
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <div className="font-semibold">{problem.title}</div>
        <p className="break-words">{problem.message}</p>
      </div>
    </div>
  );
}

function Verdict({ preview, hasRows }: { preview: UploadPreview; hasRows: boolean }) {
  const errors = preview.errors.length + preview.sheets.reduce((n, s) => n + s.errorCount, 0);
  const warnings = preview.warnings.length + preview.sheets.reduce((n, s) => n + s.warningCount, 0);
  const warningText = warnings === 0
    ? 'No warnings.'
    : `${num(warnings)} ${warnings === 1 ? 'warning' : 'warnings'} — they do not stop the save.`;

  let tone: 'urgent' | 'warning' | 'success';
  let icon: ReactNode;
  let title: string;
  let text: string;
  if (preview.blocking) {
    tone = 'urgent';
    icon = <XCircle className="mt-0.5 size-5 shrink-0" aria-hidden />;
    title = `${num(errors)} ${errors === 1 ? 'Error Blocks' : 'Errors Block'} The Save`;
    text = `Nothing has been saved. Fix the rows listed below in Excel and upload the file again. ${warningText}`;
  } else if (!hasRows) {
    tone = 'warning';
    icon = <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />;
    title = 'The File Has No Rows To Save';
    text = 'Every sheet is empty. Fill at least one sheet of the template and upload it again.';
  } else {
    tone = 'success';
    icon = <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden />;
    title = 'Ready To Save';
    text = `No errors. ${warningText} Review what will change below, then confirm.`;
  }
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
        tone === 'urgent' && 'border-urgent/30 bg-urgent-tint text-urgent-strong',
        tone === 'warning' && 'border-warning/30 bg-warning-tint text-warning-strong',
        tone === 'success' && 'border-success/30 bg-success-tint text-success-strong',
      )}
    >
      {icon}
      <div className="min-w-0 space-y-0.5">
        <div className="font-semibold">{title}</div>
        <p>{text}</p>
      </div>
    </div>
  );
}

function PreviewReport({
  preview,
  hasRows,
  sheet,
  onSheet,
  dim,
}: {
  preview: UploadPreview;
  hasRows: boolean;
  sheet: string | null;
  onSheet: (name: string) => void;
  dim: boolean;
}) {
  const selected = preview.sheets.find((s) => s.name === sheet) ?? null;
  return (
    <div className={cn('space-y-4 transition-opacity', dim && 'opacity-60')} aria-busy={dim}>
      <Verdict preview={preview} hasRows={hasRows} />

      {(preview.errors.length > 0 || preview.warnings.length > 0) && (
        <div className="space-y-2">
          <SubHeading>File</SubHeading>
          <ul className="space-y-1 text-sm">
            {preview.errors.map((m, i) => (
              <li key={`e${i}`} className="flex items-start gap-2 text-urgent-strong">
                <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />{m}
              </li>
            ))}
            {preview.warnings.map((m, i) => (
              <li key={`w${i}`} className="flex items-start gap-2 text-warning-strong">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{m}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <SubHeading>Sheets</SubHeading>
        <SheetTable sheets={preview.sheets} selected={selected?.name ?? null} onSelect={onSheet} />
      </div>

      {selected && <SheetIssues sheet={selected} />}

      <ChangesReport months={preview.months} overwrites={preview.overwrites} />
    </div>
  );
}

function SheetTable({
  sheets,
  selected,
  onSelect,
}: {
  sheets: UploadSheetReport[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="data-table w-full">
        <thead>
          <tr>
            <th>Sheet</th>
            <th>On Save</th>
            <th className="!text-right">Rows</th>
            <th className="!text-right">Errors</th>
            <th className="!text-right">Warnings</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {sheets.map((s) => {
            const active = s.name === selected;
            return (
              <tr key={s.name} className={cn(active && 'bg-muted')}>
                <td className="whitespace-nowrap">
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm"
                    aria-pressed={active}
                    title="Show this sheet's issues"
                    onClick={() => onSelect(s.name)}
                  >
                    {s.name}
                  </button>
                </td>
                <td className="min-w-48 text-muted-foreground">{SHEET_RULE[s.name] ?? '—'}</td>
                <td className="!text-right tabular-nums">{s.present ? num(s.rows) : '—'}</td>
                <td className={cn('!text-right tabular-nums', s.errorCount > 0 && 'font-semibold text-urgent-strong')}>
                  {num(s.errorCount)}
                </td>
                <td className={cn('!text-right tabular-nums', s.warningCount > 0 && 'text-warning-strong')}>
                  {num(s.warningCount)}
                </td>
                <td className="whitespace-nowrap"><SheetStatus sheet={s} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SheetStatus({ sheet }: { sheet: UploadSheetReport }) {
  if (!sheet.present) return <StatusChip tone="urgent" size="sm">Missing</StatusChip>;
  if (sheet.errorCount > 0) return <StatusChip tone="urgent" size="sm">Blocked</StatusChip>;
  if (sheet.rows === 0) return <StatusChip tone="neutral" size="sm">Empty</StatusChip>;
  if (sheet.warningCount > 0) return <StatusChip tone="warning" size="sm">OK With Warnings</StatusChip>;
  return <StatusChip tone="success" size="sm">OK</StatusChip>;
}

const ISSUE_COLUMNS: ReadonlyArray<Column<UploadIssue>> = [
  { key: 'row', label: 'Row', align: 'right', render: (r) => (r.row == null ? '—' : num(r.row)) },
  { key: 'column', label: 'Column', render: (r) => r.column || '—' },
  { key: 'message', label: 'Message', wrap: true },
];

const issueKey = (r: UploadIssue, i: number) => `${r.row ?? 's'}-${r.column ?? ''}-${i}`;

/* Page a list only when it is longer than one page, so a short list has no pager. */
const PAGE = 10;
const pagedAt = (rows: readonly unknown[]) => (rows.length > PAGE ? PAGE : undefined);

function IssueList({
  kind,
  issues,
  count,
}: {
  kind: 'Errors' | 'Warnings';
  issues: UploadIssue[];
  count: number;
}) {
  if (count === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className={cn('text-sm font-semibold', kind === 'Errors' ? 'text-urgent-strong' : 'text-warning-strong')}>
        {kind} ({num(count)})
      </div>
      {count > issues.length && (
        <p className="text-xs text-muted-foreground">
          Showing the first {num(issues.length)} of {num(count)} — fix these and upload again to see the rest.
        </p>
      )}
      <LocalTable rows={issues} columns={ISSUE_COLUMNS} rowKey={issueKey} emptyText="None" pageSize={pagedAt(issues)} />
    </div>
  );
}

function SheetIssues({ sheet }: { sheet: UploadSheetReport }) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <SubHeading>Issues In “{sheet.name}”</SubHeading>
      {sheet.errorCount === 0 && sheet.warningCount === 0 ? (
        <p className="text-sm text-muted-foreground">No errors or warnings in this sheet.</p>
      ) : (
        <>
          <IssueList kind="Errors" issues={sheet.errors} count={sheet.errorCount} />
          <IssueList kind="Warnings" issues={sheet.warnings} count={sheet.warningCount} />
        </>
      )}
    </div>
  );
}

/* ── what will change ─────────────────────────────────────────────────────── */

function targetChange(t: UploadMonthSummary['primaryTargets']): string {
  if (t.inFile === 0) return 'No change';
  const parts = [`${num(t.inFile)} in file`];
  if (t.updated > 0) parts.push(`${num(t.updated)} overwrite saved rows`);
  if (t.replaced > 0) parts.push(`${num(t.replaced)} saved under another name replaced`);
  return parts.join(' · ');
}

function empDetailChange(e: UploadMonthSummary['empDetail']): string {
  if (e.inFile === 0) return `No change (${num(e.stored)} saved)`;
  return `${num(e.added)} new · ${num(e.updated)} updated · ${num(e.after)} after save`;
}

function hiddenChange(h: UploadMonthSummary['hiddenAfterUpload']): string {
  const parts = [
    [h.timechamp, 'time champ data'],
    [h.ivr, 'ivr data record'],
    [h.primaryTargets, 'target list'],
    [h.secondaryTargets, 'secondary targets'],
  ].filter(([n]) => Number(n) > 0).map(([n, label]) => `${label} ${num(Number(n))}`);
  return parts.length ? parts.join(' · ') : 'None';
}

function MonthTable({ months }: { months: UploadMonthSummary[] }) {
  if (months.length === 0) return <p className="text-sm text-muted-foreground">No months in this file.</p>;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="data-table w-full">
        <thead>
          <tr>
            <th>Month</th>
            <th>emp detail</th>
            <th>target list</th>
            <th>Secondary spoc target list</th>
            <th>Hidden Rows (Not On emp detail)</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => {
            const hidden = hiddenChange(m.hiddenAfterUpload);
            return (
              <tr key={m.month}>
                <td className="whitespace-nowrap font-medium">{fmtMonth(m.month)}</td>
                <td className="min-w-48">{empDetailChange(m.empDetail)}</td>
                <td className="min-w-48">{targetChange(m.primaryTargets)}</td>
                <td className="min-w-48">{targetChange(m.secondaryTargets)}</td>
                <td className={cn('min-w-48', hidden !== 'None' && 'text-warning-strong')}>{hidden}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const OVERWRITE_COLUMNS: ReadonlyArray<Column<UploadOverwrite>> = [
  { key: 'source', label: 'Sheet', render: (r) => SOURCE_LABEL[r.source] ?? r.source },
  { key: 'date', label: 'Date', render: (r) => fmtDay(r.date) },
  { key: 'storedRows', label: 'Saved Rows Replaced', align: 'right', render: (r) => num(r.storedRows) },
  { key: 'fileRows', label: 'Rows In File', align: 'right', render: (r) => num(r.fileRows) },
];

function ChangesReport({ months, overwrites }: { months: UploadMonthSummary[]; overwrites: UploadOverwrite[] }) {
  return (
    <div className="space-y-3">
      <SubHeading>What Will Change</SubHeading>
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <p>
          time champ data and ivr data record: each date in the file replaces that date only. emp detail and the two
          target lists: the people in the file are added or updated for their month; everyone else stays as saved.
          Rows for people who are not on that month’s emp detail are saved but stay hidden on the dashboard until they
          are added.
        </p>
      </div>

      <MonthTable months={months} />

      <div className="space-y-1.5">
        <div className="text-sm font-medium">Saved Dates This File Replaces</div>
        {overwrites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None — no time champ data or ivr data record date in this file has been saved before.
          </p>
        ) : (
          <LocalTable
            rows={overwrites}
            columns={OVERWRITE_COLUMNS}
            rowKey={(r) => `${r.source}-${r.date}`}
            emptyText="None"
            pageSize={pagedAt(overwrites)}
          />
        )}
      </div>
    </div>
  );
}
