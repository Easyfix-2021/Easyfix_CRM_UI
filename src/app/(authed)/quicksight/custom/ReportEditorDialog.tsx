'use client';

/*
 * Custom Reports — create / edit dialog.
 *
 * Sections: Name; Columns (name + type Text/Number/Date, reorder, remove,
 * add); Chart (Optional) — type/X/Y/aggregation; Who Can View — everyone
 * with the family+view key, or a role allowlist fetched from
 * `/shared/lookup/roles?group=admin` (NOT `useLookup().roles`, which is
 * fetched unfiltered for the Manage Users picker — this list must be
 * admin-group only, per the contract's lookup note).
 *
 * Column keys: `Column.key` ("c1", stable across renames) is BE-assigned —
 * PUT sends the EXISTING key for a kept column and OMITS it for a new one.
 * A chart must still name a new column's key in the SAME request, so the
 * chart state references draft columns by their client `uid` (stable across
 * reorder/rename) and `resolveKeys` turns uids into keys only at submit, with
 * the backend's own rule (normalizeColumns in
 * quicksight-dynamic-reports.service.js): kept columns keep their key; new
 * columns, in their FINAL order, get c<max ORIGINAL key + 1>, c<+2>, …
 * Predicting by position instead would collide with an existing key on edit,
 * and silently re-point the chart when a new column is moved.
 */

import * as React from 'react';
import { Plus, ChevronUp, ChevronDown, X, Loader2, Save } from 'lucide-react';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { showToast } from '@/components/ui/toast';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import type { ColType, Chart, ReportDetail } from './[id]/types';

const API_BASE = '/admin/quicksight/dynamic-reports';

type DraftColumn = { uid: string; key?: string; name: string; type: ColType };

let uidCounter = 0;
const nextUid = () => `col-${++uidCounter}`;
/* uid → the key the backend will store — see the file-header note. */
function resolveKeys(columns: DraftColumn[], original: ReadonlyArray<{ key: string }>): Map<string, string> {
  let next = Math.max(0, ...original.map((c) => Number(c.key.slice(1)) || 0)) + 1;
  return new Map(columns.map((c) => [c.uid, c.key ?? `c${next++}`]));
}

const TYPE_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
];
const CHART_TYPE_OPTIONS = [
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
  { value: 'pie', label: 'Pie' },
];
const AGG_OPTIONS = [
  { value: 'sum', label: 'Sum' },
  { value: 'count', label: 'Count' },
  { value: 'avg', label: 'Average' },
];

type RoleLite = { role_id: number; role_name: string };

export function ReportEditorDialog({
  mode, report, onClose, onSaved,
}: {
  mode: 'create' | 'edit';
  report?: ReportDetail;
  onClose: () => void;
  onSaved: (detail: ReportDetail) => void;
}) {
  const [name, setName] = React.useState(report?.name ?? '');
  const originalColumns = report?.columns ?? [];
  const [columns, setColumns] = React.useState<DraftColumn[]>(
    () => (originalColumns.length > 0
      ? originalColumns.map((c) => ({ uid: nextUid(), key: c.key, name: c.name, type: c.type }))
      : [{ uid: nextUid(), name: '', type: 'text' as ColType }]),
  );
  // Chart X/Y hold column UIDS (not keys) — see the file-header note.
  const uidOfKey = (key: string) => columns.find((c) => c.key === key)?.uid ?? '';
  const [chartEnabled, setChartEnabled] = React.useState(!!report?.chart);
  const [chartType, setChartType] = React.useState<Chart['type']>(report?.chart?.type ?? 'bar');
  const [chartX, setChartX] = React.useState(() => (report?.chart ? uidOfKey(report.chart.x) : ''));
  const [chartY, setChartY] = React.useState<string[]>(() => (report?.chart?.y ?? []).map(uidOfKey).filter(Boolean));
  const [chartAgg, setChartAgg] = React.useState<Chart['agg']>(report?.chart?.agg ?? 'sum');
  const [who, setWho] = React.useState<'everyone' | 'roles'>(report && report.roleIds.length > 0 ? 'roles' : 'everyone');
  const [roleIds, setRoleIds] = React.useState<number[]>(report?.roleIds ?? []);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Admin-group roles only — a fresh call, NOT useLookup().roles (unfiltered).
  const rolesRes = useFetch<RoleLite[]>('/shared/lookup/roles?group=admin');
  const roleOptions = React.useMemo(
    () => (rolesRes.data ?? []).map((r) => ({ value: r.role_id, label: r.role_name })),
    [rolesRes.data],
  );

  const initialSnapshot = React.useRef(JSON.stringify({
    name: report?.name ?? '',
    columns: (report?.columns ?? []).map((c) => ({ key: c.key, name: c.name, type: c.type })),
    chart: report?.chart ?? null,
    roleIds: report?.roleIds ?? [],
  }));
  const keys = resolveKeys(columns, originalColumns);
  const byUid = new Map(columns.map((c) => [c.uid, c]));
  // Only selections that still point at a column of the right type count.
  const validX = byUid.get(chartX) && byUid.get(chartX)!.type !== 'number' ? chartX : '';
  const validY = chartY.filter((u) => byUid.get(u)?.type === 'number');
  const chartBody: Chart | null = chartEnabled
    ? { type: chartType, x: keys.get(validX) ?? '', y: validY.map((u) => keys.get(u)!), agg: chartAgg }
    : null;
  const currentSnapshot = JSON.stringify({
    name,
    columns: columns.map((c) => ({ key: keys.get(c.uid), name: c.name, type: c.type })),
    chart: chartBody,
    roleIds: who === 'roles' ? roleIds : [],
  });
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: () => currentSnapshot !== initialSnapshot.current,
    when: () => !submitting,
  });

  const textOrDateOptions = columns
    .map((c, i) => ({ value: c.uid, label: c.name || `Column ${i + 1}`, type: c.type }))
    .filter((c) => c.type === 'text' || c.type === 'date');
  const numberOptions = columns
    .map((c, i) => ({ value: c.uid, label: c.name || `Column ${i + 1}`, type: c.type }))
    .filter((c) => c.type === 'number');
  const maxY = chartType === 'pie' ? 1 : 4;

  function addColumn() {
    setColumns((cs) => [...cs, { uid: nextUid(), name: '', type: 'text' }]);
  }
  function patchColumn(uid: string, patch: Partial<Pick<DraftColumn, 'name' | 'type'>>) {
    setColumns((cs) => cs.map((c) => (c.uid === uid ? { ...c, ...patch } : c)));
  }
  function removeColumn(uid: string) {
    setColumns((cs) => cs.filter((c) => c.uid !== uid));
  }
  function moveColumn(uid: string, delta: number) {
    setColumns((cs) => {
      const i = cs.findIndex((c) => c.uid === uid);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= cs.length) return cs;
      const copy = cs.slice();
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

  function validate(): string | null {
    if (!name.trim()) return 'Enter a report name.';
    if (columns.length === 0) return 'Add at least one column.';
    const names = columns.map((c) => c.name.trim());
    if (names.some((n) => !n)) return 'Every column needs a name.';
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return 'Column names must be unique.';
    if (chartEnabled) {
      if (!validX) return 'Pick a Text or Date X column for the chart.';
      if (chartAgg !== 'count' && validY.length === 0) return 'Pick at least one Number Y column for the chart.';
    }
    if (who === 'roles' && roleIds.length === 0) {
      return 'Select at least one role, or switch to "Everyone With Custom Reports Access".';
    }
    return null;
  }

  async function submit() {
    const v = validate();
    if (v) { setError(v); return; }
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        name: name.trim(),
        columns: columns.map((c) => ({
          ...(c.key ? { key: c.key } : {}),
          name: c.name.trim(),
          type: c.type,
        })) as Array<{ key?: string; name: string; type: ColType }>,
        chart: chartBody,
        roleIds: who === 'roles' ? roleIds : [],
      };
      const detail = mode === 'create'
        ? await api.post<ReportDetail>(API_BASE, body)
        : await api.put<ReportDetail>(`${API_BASE}/${report!.id}`, body);
      invalidateFetch((k) => k.startsWith(API_BASE));
      showToast({ variant: 'success', message: mode === 'create' ? 'Report created.' : 'Report updated.' });
      onSaved(detail);
    } catch (e) {
      setError(formatApiError(e, { fallback: 'Could not save the report' }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{mode === 'create' ? 'New Custom Report' : 'Edit Report'}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-5 pr-1">
          <div>
            <Label className="block mb-1" required>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly Client Revenue" />
          </div>

          <div className="space-y-2">
            <Label className="block">Columns</Label>
            {columns.map((c, i) => (
              <div key={c.uid} className="flex items-center gap-2">
                <Input
                  value={c.name}
                  onChange={(e) => patchColumn(c.uid, { name: e.target.value })}
                  placeholder={`Column ${i + 1} Name`}
                  className="flex-1"
                />
                <Select
                  className="w-32 shrink-0"
                  value={c.type}
                  onChange={(e) => patchColumn(c.uid, { type: e.target.value as ColType })}
                  options={TYPE_OPTIONS}
                />
                <div className="flex items-center gap-1 shrink-0">
                  <IconButton icon={ChevronUp} label="Move Column Up" disabled={i === 0} onClick={() => moveColumn(c.uid, -1)} />
                  <IconButton icon={ChevronDown} label="Move Column Down" disabled={i === columns.length - 1} onClick={() => moveColumn(c.uid, 1)} />
                  <IconButton icon={X} intent="danger" label="Remove Column" disabled={columns.length === 1} onClick={() => removeColumn(c.uid)} />
                </div>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={addColumn}>
              <Plus className="mr-1 size-4" /> Add Column
            </Button>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="accent-primary" checked={chartEnabled} onChange={(e) => setChartEnabled(e.target.checked)} />
              Chart (Optional)
            </label>
            {chartEnabled && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pl-6">
                <div>
                  <Label className="block mb-1">Chart Type</Label>
                  <Select
                    value={chartType}
                    onChange={(e) => {
                      const t = e.target.value as Chart['type'];
                      setChartType(t);
                      if (t === 'pie' && chartY.length > 1) setChartY(chartY.slice(0, 1));
                    }}
                    options={CHART_TYPE_OPTIONS}
                  />
                </div>
                <div>
                  <Label className="block mb-1">Aggregation</Label>
                  <Select value={chartAgg} onChange={(e) => setChartAgg(e.target.value as Chart['agg'])} options={AGG_OPTIONS} />
                </div>
                <div>
                  <Label className="block mb-1">X Column</Label>
                  <Select
                    value={validX}
                    onChange={(e) => setChartX(e.target.value)}
                    placeholder="Select column"
                    options={textOrDateOptions}
                  />
                </div>
                <div>
                  <Label className="block mb-1">Y Column{chartType === 'pie' ? '' : 's'} (max {maxY})</Label>
                  <SearchMultiSelect
                    value={validY}
                    onChange={(next) => setChartY(next.map(String).slice(0, maxY))}
                    options={numberOptions}
                    placeholder="Select column(s)"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label className="block">Who Can View</Label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="radio" className="accent-primary" checked={who === 'everyone'} onChange={() => setWho('everyone')} />
              Everyone With Custom Reports Access
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="radio" className="accent-primary" checked={who === 'roles'} onChange={() => setWho('roles')} />
              Selected Roles
            </label>
            {who === 'roles' && (
              <div className="pl-6">
                <SearchMultiSelect
                  value={roleIds}
                  onChange={(next) => setRoleIds(next.map(Number))}
                  options={roleOptions}
                  placeholder="Select Roles…"
                  selectedLabel="roles"
                />
              </div>
            )}
          </div>

          {error && <p role="alert" className="text-sm font-medium text-urgent-strong">{error}</p>}
        </div>

        <DialogFooter className="shrink-0">
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <><Loader2 className="mr-1 size-4 animate-spin" /> Saving…</> : <><Save className="mr-1 size-4" /> Save</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
