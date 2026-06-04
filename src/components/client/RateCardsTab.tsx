'use client';

/*
 * Rate Cards tab — spreadsheet-style inline-edit grid.
 *
 * Backed by:
 *   GET /admin/clients/:clientId/rate-cards
 *   PUT /admin/clients/:clientId/rate-cards   (bulk upsert)
 *   DELETE /admin/clients/rate-cards/:id
 *
 * Perf design:
 *   - Single GET on mount; merged with the (cached) /service-types
 *     lookup. NO per-row fetches.
 *   - Local-draft state captures inline edits without round-trips.
 *     "Save All" sends ONE bulk PUT — the server upserts the whole
 *     grid in a single INSERT … ON DUPLICATE KEY UPDATE statement.
 *   - "Add Rows" only appends a stub locally; nothing crosses the
 *     network until Save All.
 *
 * UX design:
 *   - Compact grid with the 6 cost columns. Mobile-hostile by design —
 *     this is a CRM-only flow.
 *   - Save All is permanently visible at the top so the user always
 *     sees the dirty-row badge + can save without scrolling.
 *   - "Add Row" picks a service_type from the multi-select; multiple
 *     can be added at once. Already-keyed service_types are excluded
 *     from the picker (no duplicate keys).
 */

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save, AlertCircle, Calculator, Download, Building2, Layers, User } from 'lucide-react';
import { downloadXlsx } from '@/lib/download-xlsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, invalidateFetch } from '@/lib/hooks';

type RateCardRow = {
  rate_card_id?: number;            // absent for unsaved (locally-added) rows
  client_id?: number;
  service_type_id: number;
  service_type_name?: string | null;
  easyfix_direct_fixed: number;
  easyfix_direct_variable: number;
  overhead_fixed: number;
  overhead_variable: number;
  client_fixed: number;
  client_variable: number;
};

type ServiceType = { service_type_id: number; service_type_name: string };

type Props = {
  clientId: number;
  canEdit: boolean;
};

const COST_LABELS: { key: keyof RateCardRow; label: string; group: 'easyfix' | 'overhead' | 'client' }[] = [
  { key: 'easyfix_direct_fixed',    label: 'Direct Fixed',    group: 'easyfix' },
  { key: 'easyfix_direct_variable', label: 'Direct Variable', group: 'easyfix' },
  { key: 'overhead_fixed',          label: 'OH Fixed',        group: 'overhead' },
  { key: 'overhead_variable',       label: 'OH Variable',     group: 'overhead' },
  { key: 'client_fixed',            label: 'Client Fixed',    group: 'client' },
  { key: 'client_variable',         label: 'Client Variable', group: 'client' },
];

/*
 * Per-₹100 cascade preview.
 *
 * The rate-cards grid stores the 6 cost columns but NOT a per-row total
 * charge (that lives on tbl_client_service via rate_card_id linkage).
 * So we can't show absolute ₹ amounts here — instead, show what fraction
 * of any future ₹100 job-charge each party would receive.
 *
 * Formula mirrors backend `services/client-rate-cards.service.js`
 * `calculateCharges()` — Variable% then Fixed at each layer (Easyfix
 * Direct → Overhead → Client Share). The Client Share fixed/variable is
 * the legacy "true-up" bucket; the technician's (Easyfixer) cut is the
 * residual after all three layers.
 */
function splitPer100(r: RateCardRow) {
  const total = 100;
  let running = total;
  const eVar = Math.max(0, Number(r.easyfix_direct_variable) || 0);
  const eFix = Math.max(0, Number(r.easyfix_direct_fixed)    || 0);
  const oVar = Math.max(0, Number(r.overhead_variable)       || 0);
  const oFix = Math.max(0, Number(r.overhead_fixed)          || 0);
  const cVar = Math.max(0, Number(r.client_variable)         || 0);
  const cFix = Math.max(0, Number(r.client_fixed)            || 0);

  const eVarAmt = running * (eVar / 100); running -= eVarAmt;
  const eFixAmt = Math.min(running, eFix); running -= eFixAmt;
  const oVarAmt = running * (oVar / 100); running -= oVarAmt;
  const oFixAmt = Math.min(running, oFix); running -= oFixAmt;
  const cVarAmt = running * (cVar / 100); running -= cVarAmt;
  const cFixAmt = Math.min(running, cFix); running -= cFixAmt;

  const easyfixDirect = eVarAmt + eFixAmt;
  const overhead      = oVarAmt + oFixAmt;
  const clientShare   = cVarAmt + cFixAmt;
  const easyfixerCut  = Math.max(0, running);

  return {
    easyfixDirect,
    overhead,
    clientShare,
    easyfixerCut,
    breakdown: { eVarAmt, eFixAmt, oVarAmt, oFixAmt, cVarAmt, cFixAmt },
  };
}

function fmt2(n: number) {
  return (Math.round((n + Number.EPSILON) * 100) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function blankRow(serviceTypeId: number, serviceTypeName?: string): RateCardRow {
  return {
    service_type_id: serviceTypeId,
    service_type_name: serviceTypeName ?? null,
    easyfix_direct_fixed: 0,
    easyfix_direct_variable: 0,
    overhead_fixed: 0,
    overhead_variable: 0,
    client_fixed: 0,
    client_variable: 0,
  };
}

export function RateCardsTab({ clientId, canEdit }: Props) {
  const listKey = `/admin/clients/${clientId}/rate-cards`;
  const { data: serverRows, loading, error, refetch } = useFetch<RateCardRow[]>(listKey);
  const { data: types } = useFetchOnce<ServiceType[]>(`/shared/lookup/service-types`);

  const [draft, setDraft] = useState<RateCardRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [addingIds, setAddingIds] = useState(false);
  const confirm = useConfirm();

  // Snapshot serverRows → local draft on first load and after each save.
  useEffect(() => {
    if (serverRows && draft === null) setDraft(normalise(serverRows));
  }, [serverRows, draft]);

  // Dirty detection — compare cell-by-cell. Adding/removing rows is also
  // "dirty". Stringify-based diff is fine here because the grid is small
  // (≤500 rows max per the BE validator).
  const dirty = useMemo(() => {
    if (!draft || !serverRows) return false;
    const a = JSON.stringify(normalise(draft).map(stripVolatile));
    const b = JSON.stringify(normalise(serverRows).map(stripVolatile));
    return a !== b;
  }, [draft, serverRows]);

  const rows = draft ?? [];
  const usedTypeIds = useMemo(() => new Set(rows.map((r) => r.service_type_id)), [rows]);
  const availableTypeOptions = useMemo(
    () => (types ?? [])
      .filter((t) => !usedTypeIds.has(t.service_type_id))
      .map((t) => ({ value: t.service_type_id, label: t.service_type_name })),
    [types, usedTypeIds],
  );

  function updateCell(serviceTypeId: number, key: keyof RateCardRow, value: number) {
    setDraft((d) => (d ?? []).map((r) => (
      r.service_type_id === serviceTypeId ? { ...r, [key]: value } : r
    )));
  }

  async function removeRow(row: RateCardRow) {
    if (row.rate_card_id) {
      // Persisted — confirm + DELETE.
      const ok = await confirm({
        title: 'Remove Rate Card',
        description: `Remove rate card for "${row.service_type_name ?? `#${row.service_type_id}`}"?`,
        confirmLabel: 'Remove',
        variant: 'destructive',
      });
      if (!ok) return;
      try {
        await api.delete<{ deleted: boolean }>(`/admin/clients/rate-cards/${row.rate_card_id}`);
        setDraft((d) => (d ?? []).filter((r) => r.service_type_id !== row.service_type_id));
        invalidateFetch((k) => k === listKey);
        refetch();
        // After refetch lands draft will resync; force re-snapshot.
        setDraft(null);
        showToast({ variant: 'success', message: 'Rate card removed.' });
      } catch (e) {
        showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Remove failed.' });
      }
    } else {
      // Locally-added stub — drop without network call.
      setDraft((d) => (d ?? []).filter((r) => r.service_type_id !== row.service_type_id));
    }
  }

  function addRowsForTypes(typeIds: number[]) {
    if (!types) return;
    const lookup = new Map(types.map((t) => [t.service_type_id, t.service_type_name]));
    setDraft((d) => [
      ...(d ?? []),
      ...typeIds
        .filter((id) => !(d ?? []).some((r) => r.service_type_id === id))
        .map((id) => blankRow(id, lookup.get(id))),
    ]);
  }

  function revert() {
    setDraft(normalise(serverRows ?? []));
  }

  async function onSaveAll() {
    if (!draft) return;
    setSaving(true);
    try {
      const payloadRows = draft.map((r) => ({
        serviceTypeId: r.service_type_id,
        easyfixDirectFixed:    r.easyfix_direct_fixed,
        easyfixDirectVariable: r.easyfix_direct_variable,
        overheadFixed:         r.overhead_fixed,
        overheadVariable:      r.overhead_variable,
        clientFixed:           r.client_fixed,
        clientVariable:        r.client_variable,
      }));
      await api.put<{ affected: number }>(`/admin/clients/${clientId}/rate-cards`, { rows: payloadRows } as never);
      invalidateFetch((k) => k === listKey);
      refetch();
      setDraft(null); // force resync from server
      showToast({ variant: 'success', message: 'Rate cards saved.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Save failed.' });
    } finally { setSaving(false); }
  }

  return (
    <div className="pt-2 space-y-2">
      {/* Sticky action bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Calculator className="size-3.5" />
          {loading ? 'Loading…' : `${rows.length} rate card${rows.length === 1 ? '' : 's'}`}
          {dirty && <span className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5 text-[10px]">Unsaved changes</span>}
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            {dirty && (
              <>
                <Button size="sm" variant="outline" onClick={revert} disabled={saving}>Revert</Button>
                <Button size="sm" onClick={onSaveAll} disabled={saving}>
                  <Save className="size-3.5 mr-1" /> {saving ? 'Saving…' : 'Save All'}
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                downloadXlsx({
                  url: `/admin/clients/${clientId}/rate-cards/download`,
                  filename: `rate-cards-${clientId}.xlsx`,
                }).catch((e) => showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed.' }));
              }}
              disabled={rows.length === 0}
            >
              <Download className="size-3.5 mr-1" /> Download
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setAddingIds(true)} disabled={!types || availableTypeOptions.length === 0}>
              <Plus className="size-3.5 mr-1" /> Add Rows
            </Button>
          </div>
        )}
      </div>

      {/* Formula helper — abbreviated; collapsed by default */}
      <details className="text-[11px] text-muted-foreground bg-purple-50/40 border border-purple-100 rounded px-2 py-1">
        <summary className="cursor-pointer select-none text-purple-900 font-medium">
          Per &#8377;100 split formula
        </summary>
        <div className="pt-1 leading-snug">
          Cascade per layer: Variable% then Fixed, applied in order &mdash;
          Easyfix Direct &rarr; Overhead &rarr; Client Share &rarr; Easyfixer (residual).
          The rightmost columns preview what fraction of a hypothetical &#8377;100 job each party receives.
        </div>
      </details>

      {error && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="text-sm text-muted-foreground italic">
          No rate cards defined. {canEdit ? 'Click "Add Rows" to start.' : ''}
        </div>
      )}

      {rows.length > 0 && (
        <div className="rounded border bg-card overflow-x-auto">
          <table className="data-table w-full text-xs">
            <thead>
              <tr>
                <th className="!text-left sticky left-0 bg-muted/40 z-10 border-r border-border" rowSpan={2}>Service Type</th>
                <th className="!text-center bg-sky-50 text-sky-900 text-xs uppercase font-semibold tracking-wide border-b border-sky-200 border-r border-border" colSpan={2}>
                  <span className="inline-flex items-center gap-1.5 justify-center">
                    <Building2 className="size-3.5" /> Easyfix Direct
                  </span>
                </th>
                <th className="!text-center bg-amber-50 text-amber-900 text-xs uppercase font-semibold tracking-wide border-b border-amber-200 border-r border-border" colSpan={2}>
                  <span className="inline-flex items-center gap-1.5 justify-center">
                    <Layers className="size-3.5" /> Overhead
                  </span>
                </th>
                <th className="!text-center bg-emerald-50 text-emerald-900 text-xs uppercase font-semibold tracking-wide border-b border-emerald-200 border-r border-border" colSpan={2}>
                  <span className="inline-flex items-center gap-1.5 justify-center">
                    <User className="size-3.5" /> Client
                  </span>
                </th>
                <th className="!text-center bg-purple-50 text-purple-900 text-xs uppercase font-semibold tracking-wide border-b border-purple-200 border-r border-border" colSpan={4}>
                  <span className="inline-flex items-center gap-1.5 justify-center">
                    <Calculator className="size-3.5" /> Per &#8377;100 Split (Preview)
                  </span>
                </th>
                {canEdit && <th rowSpan={2}></th>}
              </tr>
              <tr>
                {COST_LABELS.map((c, i) => {
                  const isGroupEnd = i % 2 === 1;
                  const tint =
                    c.group === 'easyfix'  ? 'bg-sky-50/40'
                    : c.group === 'overhead' ? 'bg-amber-50/40'
                    : 'bg-emerald-50/40';
                  return (
                    <th
                      key={c.key as string}
                      className={`!text-right text-[11px] font-normal text-muted-foreground ${tint} ${isGroupEnd ? 'border-r border-border' : ''}`}
                    >
                      {c.label}
                    </th>
                  );
                })}
                <th className="!text-right text-[11px] font-normal text-purple-900 bg-purple-50/40">EF Direct</th>
                <th className="!text-right text-[11px] font-normal text-purple-900 bg-purple-50/40">Overhead</th>
                <th className="!text-right text-[11px] font-normal text-purple-900 bg-purple-50/40">Client</th>
                <th className="!text-right text-[11px] font-normal text-purple-900 bg-purple-50/40 border-r border-border">Easyfixer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const split = splitPer100(r);
                const efTip   = `Variable: ₹${fmt2(split.breakdown.eVarAmt)}  •  Fixed: ₹${fmt2(split.breakdown.eFixAmt)}`;
                const ohTip   = `Variable: ₹${fmt2(split.breakdown.oVarAmt)}  •  Fixed: ₹${fmt2(split.breakdown.oFixAmt)}`;
                const clTip   = `Variable: ₹${fmt2(split.breakdown.cVarAmt)}  •  Fixed: ₹${fmt2(split.breakdown.cFixAmt)}`;
                const fxrTip  = 'Residual after all three layers (Easyfix Direct → Overhead → Client Share)';
                return (
                <tr key={r.rate_card_id ?? `new-${r.service_type_id}-${idx}`}>
                  <td className="!text-left sticky left-0 bg-card z-10 font-medium border-r border-border">
                    {r.service_type_name ?? `#${r.service_type_id}`}
                  </td>
                  {COST_LABELS.map((c, i) => {
                    const isGroupEnd = i % 2 === 1;
                    return (
                      <td key={c.key as string} className={`!text-right ${isGroupEnd ? 'border-r border-border' : ''}`}>
                        {canEdit ? (
                          <Input
                            type="number" min={0} step="0.01"
                            value={Number(r[c.key as keyof RateCardRow] ?? 0)}
                            onChange={(e) => updateCell(r.service_type_id, c.key, Number(e.target.value) || 0)}
                            className="h-7 text-right font-mono text-xs"
                          />
                        ) : (
                          <span className="font-mono">{Number(r[c.key as keyof RateCardRow] ?? 0).toFixed(2)}</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="!text-right bg-purple-50/30">
                    <span className="font-mono text-xs" title={efTip}>&#8377;{fmt2(split.easyfixDirect)}</span>
                  </td>
                  <td className="!text-right bg-purple-50/30">
                    <span className="font-mono text-xs" title={ohTip}>&#8377;{fmt2(split.overhead)}</span>
                  </td>
                  <td className="!text-right bg-purple-50/30">
                    <span className="font-mono text-xs" title={clTip}>&#8377;{fmt2(split.clientShare)}</span>
                  </td>
                  <td className="!text-right bg-purple-50/30 border-r border-border">
                    <span className="font-mono text-xs" title={fxrTip}>&#8377;{fmt2(split.easyfixerCut)}</span>
                  </td>
                  {canEdit && (
                    <td className="!text-right">
                      <Button size="sm" variant="ghost" onClick={() => removeRow(r)} className="text-red-600 hover:text-red-700">
                        <Trash2 className="size-3.5" />
                      </Button>
                    </td>
                  )}
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {addingIds && (
        <AddRowsDialog
          options={availableTypeOptions}
          onClose={() => setAddingIds(false)}
          onAdd={(ids) => { addRowsForTypes(ids); setAddingIds(false); }}
        />
      )}
    </div>
  );
}

function AddRowsDialog({
  options, onClose, onAdd,
}: {
  options: { value: number; label: string }[];
  onClose: () => void;
  onAdd: (ids: number[]) => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Rate Card Rows</DialogTitle>
        </DialogHeader>
        <div className="pt-1">
          <SearchMultiSelect
            value={selected}
            onChange={(v) => setSelected(v.map((x) => Number(x)))}
            options={options}
            placeholder="Pick service types…"
          />
          <div className="text-[11px] text-muted-foreground mt-1">
            {options.length} service types still available (already-added ones are filtered out).
          </div>
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onAdd(selected)} disabled={selected.length === 0}>Add {selected.length || ''} Row{selected.length === 1 ? '' : 's'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Normalise: coerce numeric cols to numbers (MySQL returns DECIMAL as
// string by default via mysql2). Without this, the dirty-diff thinks
// "100" vs 100 are different.
function normalise(rows: RateCardRow[]): RateCardRow[] {
  return rows.map((r) => ({
    ...r,
    easyfix_direct_fixed:    Number(r.easyfix_direct_fixed) || 0,
    easyfix_direct_variable: Number(r.easyfix_direct_variable) || 0,
    overhead_fixed:          Number(r.overhead_fixed) || 0,
    overhead_variable:       Number(r.overhead_variable) || 0,
    client_fixed:            Number(r.client_fixed) || 0,
    client_variable:         Number(r.client_variable) || 0,
  }));
}

// Strip ids + names from the dirty-diff payload so we compare only the
// cost cells. Otherwise the FE would think a fresh fetch (with new
// rate_card_id sort) is "dirty" against a local draft.
function stripVolatile(r: RateCardRow) {
  return {
    sid: r.service_type_id,
    a: r.easyfix_direct_fixed,
    b: r.easyfix_direct_variable,
    c: r.overhead_fixed,
    d: r.overhead_variable,
    e: r.client_fixed,
    f: r.client_variable,
  };
}
