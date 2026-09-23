'use client';

/*
 * Custom Reports — list page.
 *
 *   BE      : GET /api/admin/quicksight/dynamic-reports
 *   Gate    : ef-QuickSight (family) + isQuickSightDynamicReportView
 *             (per-report — same key every other QuickSight report page
 *             gates its card + page on).
 *
 * Follows the same ReportPageScaffold + useFetch shape as every sibling
 * QuickSight report page (see quicksight/material-report/page.tsx) — the
 * "report body" here is just a table of reports instead of a table of rows.
 *
 * ROW ACTIONS (2026-09-23). Two icons up front + a kebab, per the row-action
 * convention: Edit = Pencil/primary, Archive = XCircle/danger (the app-wide
 * deactivate icon — never Trash2), both shared `IconButton`s. The longer tail
 * (Download Template, Upload, Transfer Owner) lives behind a MoreVertical
 * dropdown so the cell stays narrow.
 *
 * The list row carries only a SUMMARY, but the editor and upload dialogs need
 * the full definition (columns, chart, audience, columnsChanged). So those
 * items fetch `GET /:id` first and open the dialog with the result — which
 * also means the dialog mounts a network round trip after the menu closed,
 * well clear of the menu→dialog dismiss race (see EasyfixerActionMenu, and
 * `modal={false}` + `onCloseAutoFocus` below).
 */

import * as React from 'react';
import Link from 'next/link';
import { FileSpreadsheet, Plus, Pencil, XCircle, MoreVertical, Download, Upload as UploadIcon, UserCog, Loader2 } from 'lucide-react';

import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFetch } from '@/lib/hooks';
import { downloadXlsx } from '@/lib/download-xlsx';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { StatusChip } from '@/components/ui/StatusChip';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { ReportEditorDialog } from './ReportEditorDialog';
import { UploadDialog } from './[id]/UploadDialog';
import { TransferOwnerDialog } from './[id]/TransferOwnerDialog';
import type { Upload, ReportDetail } from './[id]/types';

const FAMILY_KEY = 'ef-QuickSight';
const ACTION_KEY = 'isQuickSightDynamicReportView';
const API_BASE = '/admin/quicksight/dynamic-reports';

type ReportListItem = {
  id: number;
  name: string;
  ownerId: number;
  ownerName: string | null;
  columnCount: number;
  hasChart: boolean;
  restricted: boolean;
  shareEnabled: boolean;
  current: Upload | null;
  canEdit: boolean;
  updatedAt: string;
};
type ListResponse = { canCreate: boolean; isAdmin: boolean; reports: ReportListItem[] };

/* Which dialog a row opened, with the detail it needed. */
type RowDialog =
  | { kind: 'edit'; detail: ReportDetail }
  | { kind: 'upload'; detail: ReportDetail }
  | { kind: 'owner'; detail: ReportDetail };

export default function CustomReportsListPage() {
  const { me } = useMe();
  const flags = actionFlags(me, [FAMILY_KEY, ACTION_KEY]);
  const hasAccess = flags[FAMILY_KEY] && flags[ACTION_KEY];
  const confirm = useConfirm();

  const { data, loading, error, refetch } = useFetch<ListResponse>(hasAccess ? API_BASE : null);
  const [creating, setCreating] = React.useState(false);
  const [dialog, setDialog] = React.useState<RowDialog | null>(null);
  const [busyId, setBusyId] = React.useState<number | null>(null);

  // BE hard-403 fallback → access panel instead of a raw error string,
  // same convention as every sibling QuickSight report page.
  const beDenied = !!error && /permission|quicksight access/i.test(error);
  const accessDenied = !hasAccess || beDenied;

  const reports = data?.reports ?? [];
  const isEmpty = !accessDenied && !loading && !error && reports.length === 0;
  const isAdmin = !!data?.isAdmin;

  /* Fetch the full definition, then open the dialog that needs it. */
  const openWithDetail = React.useCallback(async (id: number, kind: RowDialog['kind']) => {
    setBusyId(id);
    try {
      const detail = await api.get<ReportDetail>(`${API_BASE}/${id}`);
      setDialog({ kind, detail } as RowDialog);
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not open the report' }) });
    } finally {
      setBusyId(null);
    }
  }, []);

  async function handleArchive(r: ReportListItem) {
    const ok = await confirm({
      title: 'Archive Report',
      description: `Archive "${r.name}"? It disappears from this list and its public link stops working. Uploaded data is removed by the 30-day clean-up.`,
      confirmLabel: 'Archive',
      variant: 'destructive',
    });
    if (!ok) return;
    setBusyId(r.id);
    try {
      await api.delete(`${API_BASE}/${r.id}`);
      showToast({ variant: 'success', message: 'Report archived.' });
      refetch();
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not archive the report' }) });
    } finally {
      setBusyId(null);
    }
  }

  async function handleTemplate(r: ReportListItem, format: 'xlsx' | 'csv') {
    setBusyId(r.id);
    try {
      await downloadXlsx({
        url: `${API_BASE}/${r.id}/template?format=${format}`,
        filename: `${r.name}-template.${format}`,
      });
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not download the template' }) });
    } finally {
      setBusyId(null);
    }
  }

  const closeDialog = () => setDialog(null);
  const afterChange = () => { setDialog(null); refetch(); };

  return (
    <>
      <ReportPageScaffold
        title="Custom Reports"
        subtitle="Build a report from your own spreadsheet — table, optional chart, share by role or public link."
        icon={FileSpreadsheet}
        loading={loading}
        error={accessDenied ? null : error}
        accessDenied={accessDenied}
        isEmpty={isEmpty}
        headerActions={data?.canCreate ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-1 size-4" /> New Report
          </Button>
        ) : undefined}
      >
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-left">Name</th>
                <th className="!text-left">Owner</th>
                <th className="!text-right">Columns</th>
                <th className="!text-left">Last Upload</th>
                <th className="!text-right">Rows</th>
                <th className="!text-left">Public Link</th>
                <th className="!text-left">Tags</th>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td className="!text-left">
                    <Link href={`/quicksight/custom/${r.id}`} className="font-medium text-primary hover:underline">
                      {r.name}
                    </Link>
                  </td>
                  <td className="!text-left">{r.ownerName ?? '—'}</td>
                  <td className="!text-right">{r.columnCount}</td>
                  <td className="!text-left whitespace-nowrap">
                    {r.current ? `${r.current.uploadedAt} · ${r.current.uploadedByName ?? '—'}` : '—'}
                  </td>
                  <td className="!text-right">{r.current ? r.current.rowCount.toLocaleString('en-IN') : '—'}</td>
                  <td className="!text-left whitespace-nowrap">
                    {r.shareEnabled
                      ? <StatusChip tone="success" size="sm">Public Link</StatusChip>
                      : <span className="text-muted-foreground">Not Enabled</span>}
                  </td>
                  <td className="!text-left">
                    <div className="flex flex-wrap gap-1">
                      {r.hasChart && <StatusChip tone="info" size="sm">Chart</StatusChip>}
                      {r.restricted && <StatusChip tone="warning" size="sm">Restricted</StatusChip>}
                    </div>
                  </td>
                  <td className="!text-right">
                    {r.canEdit ? (
                      <div className="inline-flex items-center justify-end gap-0.5">
                        {busyId === r.id && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                        <IconButton
                          icon={Pencil}
                          intent="primary"
                          label="Edit Report"
                          disabled={busyId === r.id}
                          onClick={() => openWithDetail(r.id, 'edit')}
                        />
                        <IconButton
                          icon={XCircle}
                          intent="danger"
                          label="Archive Report"
                          disabled={busyId === r.id}
                          onClick={() => handleArchive(r)}
                        />
                        {/* modal={false} + onCloseAutoFocus: Radix's modal mode locks
                            body pointer-events while closing, which races a dialog
                            opened from an item. See EasyfixerActionMenu. */}
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              title="More Actions"
                              aria-label="More Actions"
                              disabled={busyId === r.id}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
                            <DropdownMenuItem onClick={() => handleTemplate(r, 'xlsx')}>
                              <Download className="mr-2 size-4" /> Download Template
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openWithDetail(r.id, 'upload')}>
                              <UploadIcon className="mr-2 size-4" /> Upload
                            </DropdownMenuItem>
                            {isAdmin && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => openWithDetail(r.id, 'owner')}>
                                  <UserCog className="mr-2 size-4" /> Transfer Owner
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ReportPageScaffold>

      {creating && (
        <ReportEditorDialog
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); refetch(); }}
        />
      )}

      {dialog?.kind === 'edit' && (
        <ReportEditorDialog
          mode="edit"
          report={dialog.detail}
          onClose={closeDialog}
          onSaved={afterChange}
        />
      )}

      {dialog?.kind === 'upload' && (
        <UploadDialog
          reportId={dialog.detail.id}
          current={dialog.detail.current}
          columnsChanged={dialog.detail.columnsChanged}
          onClose={closeDialog}
          onUploaded={afterChange}
        />
      )}

      {dialog?.kind === 'owner' && (
        <TransferOwnerDialog
          reportId={dialog.detail.id}
          currentOwnerId={dialog.detail.ownerId}
          onClose={closeDialog}
          onTransferred={afterChange}
        />
      )}
    </>
  );
}
