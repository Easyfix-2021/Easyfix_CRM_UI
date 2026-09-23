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
 */

import * as React from 'react';
import Link from 'next/link';
import { FileSpreadsheet, Plus } from 'lucide-react';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFetch } from '@/lib/hooks';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { Button } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/StatusChip';
import { ReportEditorDialog } from './ReportEditorDialog';
import type { Upload } from './[id]/types';

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

export default function CustomReportsListPage() {
  const { me } = useMe();
  const flags = actionFlags(me, [FAMILY_KEY, ACTION_KEY]);
  const hasAccess = flags[FAMILY_KEY] && flags[ACTION_KEY];

  const { data, loading, error, refetch } = useFetch<ListResponse>(hasAccess ? API_BASE : null);
  const [creating, setCreating] = React.useState(false);

  // BE hard-403 fallback → access panel instead of a raw error string,
  // same convention as every sibling QuickSight report page.
  const beDenied = !!error && /permission|quicksight access/i.test(error);
  const accessDenied = !hasAccess || beDenied;

  const reports = data?.reports ?? [];
  const isEmpty = !accessDenied && !loading && !error && reports.length === 0;

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
                <th className="!text-left">Tags</th>
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
                  <td className="!text-left">
                    <div className="flex flex-wrap gap-1">
                      {r.hasChart && <StatusChip tone="info" size="sm">Chart</StatusChip>}
                      {r.restricted && <StatusChip tone="warning" size="sm">Restricted</StatusChip>}
                      {r.shareEnabled && <StatusChip tone="success" size="sm">Public Link</StatusChip>}
                    </div>
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
    </>
  );
}
