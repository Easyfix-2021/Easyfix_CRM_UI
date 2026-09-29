'use client';

/*
 * Team Roster → Bulk Update. Pick Months + Employees → Download Template →
 * fill → upload. The upload is a DRY RUN (nothing saved): the preview shows
 * the uploaded sheet with every error cell in red (hover for the reason) and
 * every cell that will change in green; Confirm & Save stays disabled while
 * any row is blocked. "Download Error Sheet" returns the same file with the
 * error cells filled red and the reason as a cell note, ready to fix and
 * re-upload.
 *
 * Built on the shared ImportDialog (templateControls / renderPreview). Backend:
 * GET /admin/roster/bulk/template, POST /admin/roster/bulk/upload[?dryRun=1],
 * POST /admin/roster/bulk/errors (services/roster-bulk.service.js).
 */

import { useEffect, useMemo, useState } from 'react';
import { ImportDialog, type ImportRow } from '@/components/ui/import-dialog';
import { Label } from '@/components/ui/label';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { cn } from '@/lib/utils';
import { addMonthsYmd, formatYmdLabel, startOfMonth } from './roster-dates';
import type { RosterMember } from './types';

type BulkSummary = {
  employees: number; toUpdate: number; unchanged: number; blocked: number; changedCells: number; headerErrors: number;
};
type BulkSheet = {
  headers: string[];
  rows: { rowNumber: number; cells: string[]; changedCols: number[] }[];
  /** 'row:col' (1-based, as in Excel) → reason */
  errors: Record<string, string>;
};

function colLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

export function RosterBulkDialog({
  open, onClose, members, initialUserIds, editFrom, editTo, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Editable members only — whoever the caller may plan for. */
  members: RosterMember[];
  initialUserIds: number[];
  editFrom: string;
  editTo: string;
  onSaved: () => void;
}) {
  // Every month that has at least one editable day.
  const months = useMemo(() => {
    const out: { key: string; label: string; partialFrom: string | null }[] = [];
    if (!editFrom || !editTo) return out;
    for (let m = startOfMonth(editFrom); m <= editTo; m = addMonthsYmd(m, 1)) {
      out.push({ key: m.slice(0, 7), label: formatYmdLabel(m).slice(3), partialFrom: m < editFrom ? formatYmdLabel(editFrom).slice(0, 6) : null });
    }
    return out;
  }, [editFrom, editTo]);

  const [pickedMonths, setPickedMonths] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<Array<string | number>>([]);
  useEffect(() => {
    if (!open) return;
    setPickedMonths(months.map((m) => m.key));
    setUserIds(initialUserIds);
    // Reset only when the dialog opens — not while the operator is picking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const options = useMemo(
    () => members.map((m) => ({ value: m.userId, label: m.empCode ? `${m.empCode} · ${m.name}` : m.name, keywords: m.roleName ?? '' })),
    [members],
  );

  const qs = new URLSearchParams({ months: pickedMonths.join(',') });
  if (userIds.length && userIds.length < members.length) qs.set('userIds', userIds.join(','));

  const controls = (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <Label className="mb-1 block">Months</Label>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
          {months.map((m) => (
            <label key={m.key} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={pickedMonths.includes(m.key)}
                onChange={(e) => setPickedMonths((cur) => (e.target.checked ? [...cur, m.key].sort() : cur.filter((k) => k !== m.key)))}
              />
              {m.label}
              {m.partialFrom && <span className="text-xs text-muted-foreground">(From {m.partialFrom})</span>}
            </label>
          ))}
        </div>
      </div>
      <div>
        <Label className="mb-1 block">Employees</Label>
        <SearchMultiSelect
          value={userIds}
          onChange={setUserIds}
          options={options}
          placeholder="Select Employees"
          selectedLabel="employees"
        />
      </div>
    </div>
  );

  function renderPreview(extra: { sheet?: BulkSheet }, ctx: { rows: ImportRow[]; summary: BulkSummary; hasBlocked: boolean }) {
    const sheet = extra.sheet;
    const { summary } = ctx;
    const errorRows = ctx.rows.filter((r) => (r.errors?.length ?? 0) > 0);
    const stats = [
      { label: 'Employees', value: summary.employees, cls: '' },
      { label: 'To Update', value: summary.toUpdate, cls: 'text-success-strong' },
      { label: 'Unchanged', value: summary.unchanged, cls: '' },
      { label: 'With Errors', value: summary.blocked, cls: summary.blocked ? 'text-urgent-strong' : '' },
      { label: 'Days Changing', value: summary.changedCells, cls: '' },
    ];
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-5 gap-2 text-center">
          {stats.map((s) => (
            <div key={s.label} className="border rounded p-2 bg-background">
              <div className={cn('text-lg font-semibold', s.cls)}>{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>

        {ctx.hasBlocked ? (
          <div className="rounded border border-urgent/40 bg-urgent-tint p-2 text-xs text-urgent-strong space-y-0.5 max-h-32 overflow-auto">
            <div className="font-semibold">Fix These And Upload Again — Nothing Has Been Saved.</div>
            {errorRows.map((r) => (
              <div key={r.row_number}>Row {r.row_number} · {String(r.name)}: {r.errors?.join('; ')}</div>
            ))}
          </div>
        ) : summary.changedCells === 0 ? (
          <div className="text-xs text-muted-foreground">No Changes Found — The File Matches The Current Roster.</div>
        ) : (
          <div className="text-xs text-muted-foreground">Review The Highlighted Cells, Then Confirm & Save.</div>
        )}

        {sheet && (
          <>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><span className="size-3 rounded-sm bg-urgent-tint border border-urgent" /> Error (Hover For Reason)</span>
              <span className="inline-flex items-center gap-1"><span className="size-3 rounded-sm bg-success-tint border border-success" /> Will Change</span>
            </div>
            <div className="max-h-[45vh] overflow-auto border rounded bg-background">
              <table className="text-xs border-collapse">
                <thead className="sticky top-0 z-10 bg-muted">
                  <tr>
                    <th className="px-2 py-1 border text-left font-medium">Row</th>
                    {sheet.headers.map((h, i) => {
                      const err = sheet.errors[`1:${i + 1}`];
                      return (
                        <th
                          key={i}
                          title={err}
                          className={cn('px-2 py-1 border font-medium whitespace-nowrap', err && 'bg-urgent-tint text-urgent-strong')}
                        >
                          {h.replace(/^(\d{2}\/\d{2})\/\d{4}/, '$1')}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sheet.rows.map((r) => (
                    <tr key={r.rowNumber}>
                      <td className="px-2 py-1 border text-muted-foreground">{r.rowNumber}</td>
                      {sheet.headers.map((_, i) => {
                        const col = i + 1;
                        const err = sheet.errors[`${r.rowNumber}:${col}`];
                        const changed = r.changedCols.includes(col);
                        return (
                          <td
                            key={i}
                            title={err ? `${colLetter(col)}${r.rowNumber}: ${err}` : undefined}
                            className={cn(
                              'px-2 py-1 border whitespace-nowrap',
                              col > 5 && 'text-center',
                              err ? 'bg-urgent-tint text-urgent-strong font-semibold' : changed && 'bg-success-tint text-success-strong font-semibold',
                            )}
                          >
                            {r.cells[i] || (err ? '—' : '')}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <ImportDialog<BulkSummary, { sheet?: BulkSheet; headerErrors?: string[] }>
      open={open}
      onClose={onClose}
      entityLabel="Roster"
      title="Bulk Update Roster"
      templateControls={controls}
      templateDisabled={!pickedMonths.length || !userIds.length}
      templateUrl={`/admin/roster/bulk/template?${qs.toString()}`}
      templateFilename={`team-roster-bulk-${pickedMonths[0] ?? ''}.xlsx`}
      previewUrl="/admin/roster/bulk/upload?dryRun=1"
      commitUrl="/admin/roster/bulk/upload"
      errorsUrl="/admin/roster/bulk/errors"
      errorsLabel="Download Error Sheet"
      renderRowLabel={(r) => String(r.name ?? '')}
      summaryStats={(s) => [{ label: 'Days Changing', value: s.changedCells }]}
      renderPreview={renderPreview}
      commitLabel="Confirm & Save"
      blockCommitOnAnyBlocked
      contentClassName="sm:max-w-5xl"
      onImported={onSaved}
    />
  );
}
