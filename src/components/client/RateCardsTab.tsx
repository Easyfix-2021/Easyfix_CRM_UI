'use client';

/*
 * Rate Cards tab — spreadsheet-style inline-edit grid.
 *
 * Backed by:
 *   GET /admin/clients/:clientId/rate-cards
 *   PUT /admin/clients/:clientId/rate-cards   (bulk upsert)
 *   DELETE /admin/clients/rate-cards/:clientServiceId   (soft-deletes the
 *     client's own tbl_client_service row; never the shared catalog)
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

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, AlertTriangle, Save, AlertCircle, Calculator, Download, FileSpreadsheet, FileText, Upload, Building2, Layers, User, Package } from 'lucide-react';
import { downloadXlsx } from '@/lib/download-xlsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ImportDialog, outcomeTone } from '@/components/ui/import-dialog';
import { GlidingTabs } from '@/components/ui/gliding-tabs';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { StatusChip } from '@/components/ui/StatusChip';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { cn } from '@/lib/utils';
import { ClientMaterialRateDialog } from './ClientMaterialRateDialog';
import { AddClientMaterialsDialog } from './AddClientMaterialsDialog';
import { defaultTxShare } from '@/lib/tx-share';
import type { ClientMaterialRateGroup, ClientMaterialRateItem } from './client-material-rate-types';

type RateCardRow = {
  /*
   * The PK of the client's OWN tbl_client_service row, and the only id that
   * identifies "this client's rate card". Absent on locally-added stubs, which
   * is what distinguishes a persisted row from one that has never been saved.
   */
  client_service_id?: number;
  /*
   * FK into tbl_client_rate_card — a CATALOG SHARED ACROSS CLIENTS. Useful as a
   * name, never as a delete target: removing the catalog row blanks that rate
   * card's name for every other client using it. It is also nullable on
   * persisted rows, so it cannot stand in for "has this been saved".
   */
  rate_card_id?: number;
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

/*
 * Bulk-upload preview/commit summary shape, per
 * EasyFix_Backend/docs/superpowers/specs/2026-09-21-rate-card-bulk-upload-design.md.
 * Same shape for both Services and Materials uploads. The backend for this
 * contract is being written in parallel, so `renderRowLabel` below hedges on
 * the exact identifying-field key names with a fallback chain rather than
 * assuming one casing.
 */
type RateCardImportSummary = { new: number; update: number; unchanged: number; blocked: number };

/*
 * Materials bulk-upload compiled plan — the preview response's `materials[]`
 * field, additive to the `rows`/`summary` shape every ImportDialog caller
 * gets. One entry per distinct material in the uploaded file; `lines` is the
 * per-brand/per-state price breakdown the backend compiled from the sheet's
 * Material/Brand/Price/State rows. `material_id` is null when the material
 * name itself didn't resolve to a catalog row.
 */
type MaterialPlanLine = { brand?: string | null; state?: string | null; price: number; tx_share?: number | null };
type MaterialPlanItem = {
  material: string;
  material_id: number | null;
  outcome: string;
  lines: MaterialPlanLine[];
  errors?: string[];
};
type MaterialUploadPreviewExtra = { materials?: MaterialPlanItem[] };

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
  const [servicesImportOpen, setServicesImportOpen] = useState(false);
  const [materialsImportOpen, setMaterialsImportOpen] = useState(false);
  const confirm = useConfirm();

  // Services / Materials gliding tabs — layout only, both sections still fetch
  // on mount regardless of which is visible (their useFetch calls above are
  // unconditional), so switching tabs never re-triggers a request.
  const [section, setSection] = useState<'services' | 'materials'>('services');

  // ── Materials section (sub-project C) ──────────────────────────────────
  const materialRatesKey = `/admin/clients/${clientId}/material-rates`;
  const {
    data: materialRates, loading: materialsLoading, error: materialsError, refetch: refetchMaterialRates,
  } = useFetch<ClientMaterialRateItem[]>(materialRatesKey);
  const [addMaterialsDialogOpen, setAddMaterialsDialogOpen] = useState(false);
  const [materialDialogOpen, setMaterialDialogOpen] = useState(false);
  const [materialDialogItem, setMaterialDialogItem] = useState<ClientMaterialRateItem | null>(null);
  const [materialBusyId, setMaterialBusyId] = useState<number | null>(null);

  function groupLabel(g: ClientMaterialRateGroup): string {
    return g.brands.length === 0 ? 'No Brand' : g.brands.map((b) => b.brand_name).join(', ');
  }
  function flaggedGroups(item: ClientMaterialRateItem): ClientMaterialRateGroup[] {
    return item.groups.filter((g) =>
      g.master_price_seen != null && g.master_price_today != null
      && Number(g.master_price_seen) !== Number(g.master_price_today));
  }
  function afterMaterialMutation() {
    refetchMaterialRates();
  }
  function openEditMaterial(item: ClientMaterialRateItem) {
    setMaterialDialogItem(item);
    setMaterialDialogOpen(true);
  }
  async function removeMaterial(item: ClientMaterialRateItem) {
    const ok = await confirm({
      title: 'Remove Client Price',
      description: `Remove the client price for "${item.material_name}"? It will fall back to the master price.`,
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!ok) return;
    setMaterialBusyId(item.material_id);
    try {
      await api.delete(`/admin/clients/${clientId}/material-rates/${item.material_id}`);
      afterMaterialMutation();
      showToast({ variant: 'success', message: 'Client price removed.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Remove failed.' });
    } finally {
      setMaterialBusyId(null);
    }
  }
  async function acceptMaster(item: ClientMaterialRateItem) {
    setMaterialBusyId(item.material_id);
    try {
      await api.post(`/admin/clients/${clientId}/material-rates/${item.material_id}/accept-master`);
      afterMaterialMutation();
      showToast({ variant: 'success', message: 'Master price change accepted.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Accept failed.' });
    } finally {
      setMaterialBusyId(null);
    }
  }
  async function updateToMaster(item: ClientMaterialRateItem) {
    const flaggedIds = new Set(flaggedGroups(item).map((g) => g.group_id));
    if (flaggedIds.size === 0) return;
    setMaterialBusyId(item.material_id);
    try {
      const body = {
        groups: item.groups.map((g) => ({
          brand_ids: g.brands.map((b) => b.brand_id),
          price: flaggedIds.has(g.group_id) && g.master_price_today != null ? g.master_price_today : g.price,
          // Not a user-driven price edit — carry the group's own Tx Share
          // through unchanged rather than resetting it to 20% of the new
          // price (that reset rule is for the interactive editor only).
          tx_share: g.tx_share,
          states: g.states.map((s) => ({ state_ids: s.state_ids, price: s.price, tx_share: s.tx_share })),
        })),
      };
      await api.put(`/admin/clients/${clientId}/material-rates/${item.material_id}`, body);
      afterMaterialMutation();
      showToast({ variant: 'success', message: 'Client price updated to master.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Update failed.' });
    } finally {
      setMaterialBusyId(null);
    }
  }
  function onMaterialSaved() {
    setMaterialDialogOpen(false);
    afterMaterialMutation();
  }

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
    /*
     * Keyed on client_service_id, not rate_card_id, for two reasons. It is the
     * client's OWN row — the server soft-deletes that and never touches the
     * shared catalog. And rate_card_id is NULLABLE on a persisted row, so the
     * old check sent any saved-but-unlinked row down the "local stub" branch
     * below: it vanished from the grid without a request and came straight back
     * on the next refetch.
     */
    if (row.client_service_id) {
      // Persisted — confirm + DELETE.
      const ok = await confirm({
        title: 'Remove Rate Card',
        description: `Remove rate card for "${row.service_type_name ?? `#${row.service_type_id}`}"?`,
        confirmLabel: 'Remove',
        variant: 'destructive',
      });
      if (!ok) return;
      try {
        await api.delete<{ deleted: boolean }>(`/admin/clients/rate-cards/${row.client_service_id}`);
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
    <div className="pt-2 space-y-3">
      <GlidingTabs
        ariaLabel="Rate Cards section"
        value={section}
        onChange={(v) => setSection(v as 'services' | 'materials')}
        tabs={[
          { value: 'services', label: 'Services', count: rows.length },
          { value: 'materials', label: 'Materials', count: (materialRates ?? []).length },
        ]}
      />

    <div className={cn('space-y-2', section !== 'services' && 'hidden')}>
      {/* Sticky action bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Calculator className="size-3.5" />
          {loading ? 'Loading…' : `${rows.length} rate card${rows.length === 1 ? '' : 's'}`}
          {dirty && <span className="text-warning-strong bg-warning-tint border border-warning rounded px-1 py-0.5 text-xs">Unsaved changes</span>}
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
            <Button size="sm" variant="outline" onClick={() => setServicesImportOpen(true)}>
              <Upload className="size-3.5 mr-1" /> Bulk Upload
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setAddingIds(true)} disabled={!types || availableTypeOptions.length === 0}>
              <Plus className="size-3.5 mr-1" /> Add Rows
            </Button>
          </div>
        )}
      </div>

      {/* Formula helper — abbreviated; collapsed by default */}
      <details className="text-xs text-muted-foreground bg-gold-tint/40 border border-gold-tint rounded px-2 py-1">
        <summary className="cursor-pointer select-none text-gold-strong font-medium">
          Per &#8377;100 split formula
        </summary>
        <div className="pt-1 leading-snug">
          Cascade per layer: Variable% then Fixed, applied in order &mdash;
          Easyfix Direct &rarr; Overhead &rarr; Client Share &rarr; Easyfixer (residual).
          The rightmost columns preview what fraction of a hypothetical &#8377;100 job each party receives.
        </div>
      </details>

      {error && (
        <div className="text-xs text-urgent-strong flex items-center gap-1">
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
                <th className="!text-center bg-info-tint text-info-deep text-xs uppercase font-semibold tracking-wide border-b border-info border-r border-border" colSpan={2}>
                  <span className="inline-flex items-center gap-1.5 justify-center">
                    <Building2 className="size-3.5" /> Easyfix Direct
                  </span>
                </th>
                <th className="!text-center bg-warning-tint text-warning-strong text-xs uppercase font-semibold tracking-wide border-b border-warning border-r border-border" colSpan={2}>
                  <span className="inline-flex items-center gap-1.5 justify-center">
                    <Layers className="size-3.5" /> Overhead
                  </span>
                </th>
                <th className="!text-center bg-success-tint text-success-strong text-xs uppercase font-semibold tracking-wide border-b border-success border-r border-border" colSpan={2}>
                  <span className="inline-flex items-center gap-1.5 justify-center">
                    <User className="size-3.5" /> Client
                  </span>
                </th>
                <th className="!text-center bg-gold-tint text-gold-strong text-xs uppercase font-semibold tracking-wide border-b border-gold border-r border-border" colSpan={4}>
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
                    c.group === 'easyfix'  ? 'bg-info-tint/40'
                    : c.group === 'overhead' ? 'bg-warning-tint/40'
                    : 'bg-success-tint/40';
                  return (
                    <th
                      key={c.key as string}
                      className={`!text-right text-xs font-normal text-muted-foreground ${tint} ${isGroupEnd ? 'border-r border-border' : ''}`}
                    >
                      {c.label}
                    </th>
                  );
                })}
                <th className="!text-right text-xs font-normal text-gold-strong bg-gold-tint/40">EF Direct</th>
                <th className="!text-right text-xs font-normal text-gold-strong bg-gold-tint/40">Overhead</th>
                <th className="!text-right text-xs font-normal text-gold-strong bg-gold-tint/40">Client</th>
                <th className="!text-right text-xs font-normal text-gold-strong bg-gold-tint/40 border-r border-border">Easyfixer</th>
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
                <tr key={r.client_service_id ?? `new-${r.service_type_id}-${idx}`}>
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
                  <td className="!text-right bg-gold-tint/30">
                    <span className="font-mono text-xs" title={efTip}>&#8377;{fmt2(split.easyfixDirect)}</span>
                  </td>
                  <td className="!text-right bg-gold-tint/30">
                    <span className="font-mono text-xs" title={ohTip}>&#8377;{fmt2(split.overhead)}</span>
                  </td>
                  <td className="!text-right bg-gold-tint/30">
                    <span className="font-mono text-xs" title={clTip}>&#8377;{fmt2(split.clientShare)}</span>
                  </td>
                  <td className="!text-right bg-gold-tint/30 border-r border-border">
                    <span className="font-mono text-xs" title={fxrTip}>&#8377;{fmt2(split.easyfixerCut)}</span>
                  </td>
                  {canEdit && (
                    <td className="!text-right">
                      <Button size="sm" variant="ghost" onClick={() => removeRow(r)} className="text-urgent hover:text-urgent-strong">
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
    </div>

      {/* ── Materials section (sub-project C) ──────────────────────────── */}
      <div className={cn('space-y-2', section !== 'materials' && 'hidden')}>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Package className="size-3.5" />
            {materialsLoading ? 'Loading…' : `${(materialRates ?? []).length} material${(materialRates ?? []).length === 1 ? '' : 's'}`}
          </div>
          {canEdit && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setMaterialsImportOpen(true)}>
                <Upload className="size-3.5 mr-1" /> Bulk Upload
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAddMaterialsDialogOpen(true)}>
                <Plus className="size-3.5 mr-1" /> Add Materials
              </Button>
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Materials not listed here quote at the master price.
        </p>

        {materialsLoading && (
          <div className="text-xs text-muted-foreground">Loading materials…</div>
        )}
        {materialsError && (
          <div className="text-xs text-urgent-strong flex items-center gap-1">
            <AlertCircle className="size-3.5" /> {materialsError}
          </div>
        )}

        {!materialsLoading && (materialRates ?? []).length === 0 && (
          <div className="text-sm text-muted-foreground italic">
            No client material prices set. {canEdit ? 'Click "Add Materials" to start.' : ''}
          </div>
        )}

        {(materialRates ?? []).length > 0 && (
          <div className="rounded border bg-card overflow-x-auto">
            <table className="data-table w-full text-xs">
              <thead>
                <tr>
                  <th className="!text-left">Material</th>
                  <th className="!text-left">Brand Groups</th>
                  <th className="!text-right">Price</th>
                  <th className="!text-right">Tx Share</th>
                  <th className="!text-center">States</th>
                  <th className="!text-center">Master</th>
                  {canEdit && <th></th>}
                </tr>
              </thead>
              <tbody>
                {(materialRates ?? []).map((item) => {
                  const flagged = flaggedGroups(item);
                  const stateCount = item.groups.reduce((n, g) => n + g.states.length, 0);
                  const busy = materialBusyId === item.material_id;
                  return (
                    <Fragment key={item.material_id}>
                      <tr>
                        <td className="!text-left font-medium">{item.material_name}</td>
                        <td className="!text-left">
                          <div className="space-y-0.5">
                            {item.groups.map((g) => (
                              <div key={g.group_id}>{groupLabel(g)}</div>
                            ))}
                          </div>
                        </td>
                        <td className="!text-right">
                          <div className="space-y-0.5">
                            {item.groups.map((g) => (
                              <div key={g.group_id} className="font-mono">&#8377;{fmt2(Number(g.price))}</div>
                            ))}
                          </div>
                        </td>
                        <td className="!text-right">
                          <div className="space-y-0.5">
                            {item.groups.map((g) => (
                              <div key={g.group_id} className="font-mono">
                                &#8377;{fmt2(g.tx_share != null ? Number(g.tx_share) : defaultTxShare(Number(g.price)))}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="!text-center">{stateCount}</td>
                        <td className="!text-center">
                          {flagged.length > 0 ? (
                            <span className="inline-flex items-center gap-1 text-warning-strong bg-warning-tint border border-warning rounded px-1.5 py-0.5">
                              <AlertTriangle className="size-3" /> Review
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        {canEdit && (
                          <td className="!text-right">
                            <div className="flex items-center justify-end gap-1">
                              <IconButton icon={Pencil} label="Edit Client Price" intent="primary"
                                disabled={busy} onClick={() => openEditMaterial(item)} />
                              <IconButton icon={Trash2} label="Remove Client Price" intent="danger"
                                disabled={busy} onClick={() => removeMaterial(item)} />
                            </div>
                          </td>
                        )}
                      </tr>
                      {flagged.length > 0 && (
                        <tr key={`${item.material_id}-flag`} className="bg-warning-tint/40">
                          <td colSpan={canEdit ? 7 : 6} className="!text-left px-3 py-2">
                            <div className="flex items-start gap-2">
                              <AlertTriangle className="size-3.5 mt-0.5 text-warning-strong shrink-0" />
                              <div className="space-y-1">
                                {flagged.map((g) => (
                                  <div key={g.group_id} className="text-warning-strong">
                                    {flagged.length > 1 ? `${groupLabel(g)}: ` : ''}
                                    Master changed &#8377;{fmt2(Number(g.master_price_seen))} &rarr; &#8377;{fmt2(Number(g.master_price_today))}
                                  </div>
                                ))}
                                {canEdit && (
                                  <div className="flex gap-2 pt-1">
                                    <Button size="sm" variant="outline" disabled={busy} onClick={() => acceptMaster(item)}>Accept</Button>
                                    <Button size="sm" disabled={busy} onClick={() => updateToMaster(item)}>Update</Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {addMaterialsDialogOpen && (
        <AddClientMaterialsDialog
          open={addMaterialsDialogOpen}
          onClose={() => setAddMaterialsDialogOpen(false)}
          clientId={clientId}
          existingRates={materialRates ?? []}
          onAdded={() => {
            setAddMaterialsDialogOpen(false);
            afterMaterialMutation();
          }}
        />
      )}

      {materialDialogOpen && materialDialogItem && (
        <ClientMaterialRateDialog
          open={materialDialogOpen}
          onClose={() => setMaterialDialogOpen(false)}
          clientId={clientId}
          item={materialDialogItem}
          onSaved={onMaterialSaved}
        />
      )}

      {addingIds && (
        <AddRowsDialog
          options={availableTypeOptions}
          onClose={() => setAddingIds(false)}
          onAdd={(ids) => { addRowsForTypes(ids); setAddingIds(false); }}
        />
      )}

      <ImportDialog<RateCardImportSummary>
        open={servicesImportOpen}
        onClose={() => setServicesImportOpen(false)}
        entityLabel="Service Rate"
        templateUrl={`/admin/clients/${clientId}/rate-cards/template`}
        templateFilename={`rate-cards-template-${clientId}.xlsx`}
        previewUrl={`/admin/clients/${clientId}/rate-cards/upload/preview`}
        commitUrl={`/admin/clients/${clientId}/rate-cards/upload/commit`}
        renderRowLabel={(r) => String(r.service_type_name ?? r.serviceTypeName ?? r.service_type_id ?? r.serviceTypeId ?? '')}
        summaryStats={(s) => [
          { label: 'New', value: s.new, tone: 'ok' as const },
          { label: 'Update', value: s.update },
          { label: 'Unchanged', value: s.unchanged },
          { label: 'Blocked', value: s.blocked, tone: 'err' as const },
        ]}
        sortBlockedFirst
        blockCommitOnAnyBlocked
        onImported={() => {
          // Same "resync from server" sequence as onSaveAll — a bulk upload
          // writes rows outside the local draft, so the draft must be
          // dropped or edited cells would keep showing pre-upload values.
          invalidateFetch((k) => k === listKey);
          refetch();
          setDraft(null);
        }}
      />

      <ImportDialog<RateCardImportSummary, MaterialUploadPreviewExtra>
        open={materialsImportOpen}
        onClose={() => setMaterialsImportOpen(false)}
        entityLabel="Material Rate"
        templateUrl={`/admin/clients/${clientId}/material-rates/template`}
        templateFilename={`material-rates-template-${clientId}.xlsx`}
        previewUrl={`/admin/clients/${clientId}/material-rates/upload/preview`}
        commitUrl={`/admin/clients/${clientId}/material-rates/upload/commit`}
        renderRowLabel={(r) => String(r.material_name ?? r.materialName ?? r.material ?? '')}
        summaryStats={(s) => [
          { label: 'New', value: s.new, tone: 'ok' as const },
          { label: 'Update', value: s.update },
          { label: 'Unchanged', value: s.unchanged },
          { label: 'Blocked', value: s.blocked, tone: 'err' as const },
        ]}
        commitLabel="Upload"
        renderPreview={(extra) => <MaterialUploadPreview materials={extra?.materials ?? []} />}
        sortBlockedFirst
        blockCommitOnAnyBlocked
        onImported={afterMaterialMutation}
      />
    </div>
  );
}

/*
 * RateCardsDownloadAction — the single combined Download control for the
 * "Rate Cards · Brand-Level" title row (rendered by SectionShell's `actions`
 * slot in clients/[id]/page.tsx, a sibling of <RateCardsTab>, not a child —
 * that row lives outside this component's own returned tree). Replaces the
 * two per-tab Download buttons above.
 *
 * Own useFetch calls on the SAME cache keys the grids above use — the module
 * cache in lib/hooks.ts dedupes concurrent/`recent` hits on an identical key,
 * so this doesn't cost a second network round-trip, just a second read of the
 * same cached/in-flight response. Basing "empty" on the server-fetched counts
 * (rather than the grid's local unsaved draft) is also the more correct
 * signal here: both export endpoints read committed DB rows, so an unsaved
 * local edit doesn't change what they'd actually produce.
 */
export function RateCardsDownloadAction({ clientId, canEdit }: { clientId: number; canEdit: boolean }) {
  const { data: serviceRows } = useFetch<RateCardRow[]>(`/admin/clients/${clientId}/rate-cards`);
  const { data: materialRows } = useFetch<ClientMaterialRateItem[]>(`/admin/clients/${clientId}/material-rates`);
  const isEmpty = (serviceRows ?? []).length === 0 && (materialRows ?? []).length === 0;

  if (!canEdit) return null;

  function runDownload(url: string, filename: string) {
    downloadXlsx({ url, filename }).catch((e) =>
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed.' }));
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" disabled={isEmpty}>
          <Download className="size-3.5 mr-1" /> Download
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => runDownload(
            `/admin/clients/${clientId}/rate-cards/export.xlsx`,
            `rate-cards-${clientId}.xlsx`,
          )}
        >
          <FileSpreadsheet className="mr-2 h-4 w-4" /> Excel Workbook
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => runDownload(
            `/admin/clients/${clientId}/rate-cards/export.pdf`,
            `rate-card-${clientId}-${today}.pdf`,
          )}
        >
          <FileText className="mr-2 h-4 w-4" /> PDF (Letterhead)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/*
 * Materials bulk-upload preview — replaces the ImportDialog default
 * row table for this one caller (via `renderPreview`). Groups the sheet's
 * Material/Brand/Price/State rows into the backend's compiled per-material
 * plan: one block per material, an outcome chip, and its Brand · State ·
 * Price lines. A material's own `errors` (e.g. "has state prices but no
 * all-states price") show underneath it — no separate raw-row table, since
 * every uploaded row folds into exactly one material entry here.
 */
function MaterialUploadPreview({ materials }: { materials: MaterialPlanItem[] }) {
  if (materials.length === 0) {
    return <div className="text-xs text-muted-foreground italic px-1">No materials found in this file.</div>;
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        The &quot;Tx Share&quot; column is optional — leave it blank to default to 20% of Price.
      </p>
      <div className="max-h-64 overflow-auto border rounded divide-y divide-border">
        {materials.map((m, i) => (
          <div key={`${m.material}-${i}`} className="p-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">{m.material}</span>
              <StatusChip tone={outcomeTone(m.outcome)} size="sm">{m.outcome}</StatusChip>
            </div>
            {m.lines.length > 0 && (
              <table className="data-table w-full text-xs">
                <thead>
                  <tr><th className="!text-left">Brand</th><th className="!text-left">State</th><th className="!text-right">Price</th><th className="!text-right">Tx Share</th></tr>
                </thead>
                <tbody>
                  {m.lines.map((l, li) => (
                    <tr key={li}>
                      <td className="!text-left">{l.brand?.trim() ? l.brand : 'No Brand'}</td>
                      <td className="!text-left">{l.state?.trim() ? l.state : 'All States'}</td>
                      <td className="!text-right font-mono">&#8377;{fmt2(Number(l.price) || 0)}</td>
                      <td className="!text-right font-mono">
                        &#8377;{fmt2(l.tx_share != null ? Number(l.tx_share) : defaultTxShare(Number(l.price) || 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {m.errors && m.errors.length > 0 && (
              <div className="text-xs text-urgent-strong">{m.errors.join('; ')}</div>
            )}
          </div>
        ))}
      </div>
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
  const guardedOpenChange = useFormDirtyGuard(onClose);
  return (
    <Dialog open onOpenChange={guardedOpenChange}>
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
          <div className="text-xs text-muted-foreground mt-1">
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
