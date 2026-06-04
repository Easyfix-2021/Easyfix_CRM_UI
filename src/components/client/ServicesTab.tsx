'use client';

/*
 * Services tab — catalog of (category + service types + cost-cascade)
 * rows for a client. List + Add + Edit + soft-Delete + Show-inactive
 * toggle + client-side pagination.
 *
 * Upgraded 2026-06-03 to match the legacy CRM "Manage Client Services"
 * page + "Edit Client Services" modal: the modal now collects the full
 * Fixed/Variable cascade (Easyfix Direct → Overhead → Client Share →
 * Easyfixer) and the listing shows Easyfixer + Client per-unit charges
 * the BE returns from the cascade. Status badges + Show-inactive
 * filter + pagination via the shared TablePagination component.
 *
 * Perf design:
 *   - One useFetch for the list. The BE returns rows fully resolved
 *     (category_name + service_types[] + charges{}) so there's NO
 *     secondary fetch per row on the FE side.
 *   - Lookups (categories + service types) loaded via useFetchOnce; the
 *     module-level cache in lib/hooks ensures repeated dialog opens
 *     don't hit the network.
 *   - Service-type options for the dialog are derived from the lookups
 *     via useMemo, filtered by the chosen category. No extra fetch on
 *     category change.
 *   - When editing, fresh row data is fetched via
 *     GET /admin/clients/services/:id (the list row may be stale or
 *     filtered out).
 *
 * UX design:
 *   - Compact table view; chip-list for service-type names lives in
 *     the "Service Name / Type" column (we collapse the legacy Name
 *     and Type columns into one since our schema is many-types-per-row
 *     — see comment near the column header).
 *   - Live "Computed split" preview inside the modal runs the same
 *     cascade as the BE so the operator sees Easyfixer/Client/Overhead
 *     numbers before saving. Negative residuals (over-configured
 *     costs) render in red rather than being clamped silently.
 *   - Collapsible formula helper explains the cascade.
 *   - Optimistic delete: row disappears immediately, rolled back on
 *     error. Add/Edit go through a normal load → success → refetch
 *     flow since the user expects to see the new row populated.
 */

import React, { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, Pencil, Trash2, AlertCircle, Layers, ChevronDown, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SearchSelect } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

type ServiceCategory = { service_catg_id: number; service_catg_name: string };
type ServiceType = { service_type_id: number; service_type_name: string; service_catg_id: number | null };

type ChargesBreakdown = {
  total_charge: number;
  total_cost: number;
  client_charge: number;
  easyfix_charge: number;
  easyfixer_charge: number;
  _breakdown?: {
    ef_direct_share_per_unit: number;
    overhead_share_per_unit: number;
    client_share_per_unit: number;
    easyfixer_share_per_unit: number;
  };
};

type ClientServiceRow = {
  client_service_id: number;
  client_id: number;
  service_category_id: number;
  service_category_name: string | null;
  service_type_ids: number[];
  service_types: { service_type_id: number; service_type_name: string | null }[];
  charge_type: string | null;
  total_charge: number | null;
  easyfix_direct_fixed: number | null;
  easyfix_direct_variable: number | null;
  overhead_fixed: number | null;
  overhead_variable: number | null;
  client_fixed: number | null;
  client_variable: number | null;
  charges: ChargesBreakdown | null;
  service_status: number | null;
};

type Props = {
  clientId: number;
  canEdit: boolean;
};

export function ServicesTab({ clientId, canEdit }: Props) {
  const [showInactive, setShowInactive] = useState(false);
  // BE supports ?includeInactive=1; keying it into the URL means
  // useFetch dedupes/refetches cleanly when the toggle flips.
  const listKey = `/admin/clients/${clientId}/services${showInactive ? '?includeInactive=1' : ''}`;
  const { data, loading, error, refetch } = useFetch<ClientServiceRow[]>(listKey);

  // Lookups — module-deduped, fired once even if the tab is opened
  // and closed repeatedly.
  const { data: categories } = useFetchOnce<ServiceCategory[]>(`/shared/lookup/service-categories`);
  const { data: serviceTypes } = useFetchOnce<ServiceType[]>(`/shared/lookup/service-types`);

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pendingDeletes, setPendingDeletes] = useState<Set<number>>(() => new Set());
  // Show Breakdown expander — same pattern as JobModal::ServicesTab,
  // but no extra fetch is needed: the BE listForClient response already
  // carries `charges._breakdown` on every row. Operators click the
  // BarChart3 icon to expand a row below the table row showing the
  // 4-layer cascade cuts (L1 Easyfix Direct, L2 Overhead, L3 Client,
  // L4 Easyfixer) per ₹1 of the row's total_charge — useful to audit
  // the cascade math without opening the Edit modal.
  const [openBreakdownId, setOpenBreakdownId] = useState<number | null>(null);
  const confirm = useConfirm();

  // Pagination — client-side; lists are small enough that fetching all
  // and paginating in JS is cheaper than threading offset/limit through
  // the BE call. Default 20 to match other CRM tabs.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(20);

  const items = useMemo(() => {
    return (data ?? []).filter((r) => !pendingDeletes.has(r.client_service_id));
  }, [data, pendingDeletes]);

  // Reset to page 0 when the underlying row set shrinks past the current
  // page boundary (e.g. toggling Show-inactive or deleting last row on
  // current page).
  useEffect(() => {
    if (pageSize === 'all') return;
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    if (page >= totalPages) setPage(Math.max(0, totalPages - 1));
  }, [items.length, page, pageSize]);

  const paged = useMemo(() => {
    if (pageSize === 'all') return items;
    const start = page * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  async function onDelete(row: ClientServiceRow) {
    const ok = await confirm({
      title: 'Remove Service',
      description: `Remove "${row.service_category_name ?? 'Service'}" from this client? Existing jobs referencing it stay intact.`,
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!ok) return;
    setPendingDeletes((s) => new Set(s).add(row.client_service_id));
    try {
      await api.delete<{ deleted: boolean }>(`/admin/clients/services/${row.client_service_id}`);
      invalidateFetch((k) => k.startsWith(`/admin/clients/${clientId}/services`));
      refetch();
      setPendingDeletes((s) => {
        const next = new Set(s);
        next.delete(row.client_service_id);
        return next;
      });
      showToast({ variant: 'success', message: 'Service removed.' });
    } catch (e) {
      setPendingDeletes((s) => {
        const next = new Set(s);
        next.delete(row.client_service_id);
        return next;
      });
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Remove failed.' });
    }
  }

  return (
    <div className="pt-2 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted-foreground">
            {loading ? 'Loading…' : `${items.length} service${items.length === 1 ? '' : 's'}`}
          </div>
          <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => { setShowInactive(e.target.checked); setPage(0); }}
              className="h-3.5 w-3.5"
            />
            <span>Show Inactive</span>
          </label>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5 mr-1" /> Add Service
          </Button>
        )}
      </div>
      {error && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="space-y-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded border bg-card animate-pulse h-12" />
          ))}
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="text-sm text-muted-foreground italic">
          No services configured. {canEdit ? 'Click "Add Service" to subscribe this client to a service category.' : ''}
        </div>
      )}

      {items.length > 0 && (
        <div className="rounded border bg-card overflow-hidden">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">Service ID</th>
                {/* Service Type column dropped 2026-06-03 — the chip
                    rendering of `#id - name` was duplicative with the
                    Service Name column (both derived from the same
                    `service_type_ids` array, just with different
                    visual treatment). Keeping the prose-style
                    "Service Name" + the Category column is enough. */}
                <th className="!text-left">Service Name</th>
                <th className="!text-left">Service Category</th>
                <th className="!text-right">Easyfixer Charges</th>
                <th className="!text-right">Client Charges</th>
                <th className="!text-center">Status</th>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((r) => {
                const isOpen = openBreakdownId === r.client_service_id;
                const bd = r.charges?._breakdown ?? null;
                return (
                  <React.Fragment key={r.client_service_id}>
                    <tr>
                      <td className="!text-left font-mono text-xs">{r.client_service_id}</td>
                      {/* Service Name — comma-joined names, plain text.
                          (Service Type column dropped — was duplicative
                          with this column; both derived from the same
                          service_type_ids array.) */}
                      <td className="!text-left text-xs">
                        {r.service_types.length === 0 ? (
                          <span className="text-muted-foreground italic">—</span>
                        ) : (
                          <span className="text-foreground">
                            {r.service_types
                              .map((t) => t.service_type_name ?? `#${t.service_type_id}`)
                              .join(', ')}
                          </span>
                        )}
                      </td>
                      <td className="!text-left">
                        <div className="font-medium flex items-center gap-1">
                          <Layers className="size-3.5 text-muted-foreground" />
                          {r.service_category_name ?? `#${r.service_category_id}`}
                        </div>
                      </td>
                      <td className="!text-right font-mono text-xs">
                        {r.charges?.easyfixer_charge != null
                          ? `₹${Number(r.charges.easyfixer_charge).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="!text-right font-mono text-xs">
                        {r.charges?.client_charge != null
                          ? `₹${Number(r.charges.client_charge).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="!text-center">
                        {r.service_status === 0 ? (
                          <span className="text-[11px] bg-gray-100 text-gray-700 border border-gray-200 rounded px-1.5 py-0.5">Inactive</span>
                        ) : (
                          <span className="text-[11px] bg-green-50 text-green-700 border border-green-200 rounded px-1.5 py-0.5">Active</span>
                        )}
                      </td>
                      <td className="!text-right">
                        {/* gap-0.5 (was gap-1) tightens horizontal space
                            between icons since each now uses a fixed
                            28×28 box with no internal padding. */}
                        <div className="inline-flex items-center gap-0.5 justify-end">
                          {/* Show/Hide Breakdown — always rendered (even
                              when canEdit is false) so read-only viewers
                              can still audit the cascade. */}
                          <button
                            type="button"
                            title={isOpen ? 'Hide Breakdown' : 'Show Breakdown'}
                            aria-label={isOpen ? 'Hide Breakdown' : 'Show Breakdown'}
                            className={
                              'inline-flex items-center justify-center w-7 h-7 rounded border ' +
                              (isOpen
                                ? 'bg-sky-50 border-sky-300 text-sky-700'
                                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50')
                            }
                            onClick={() => setOpenBreakdownId(isOpen ? null : r.client_service_id)}
                          >
                            <BarChart3 className="h-3.5 w-3.5" />
                          </button>
                          {canEdit && (
                            <>
                              {/* Edit + Delete — native <button>s matching
                                  the Show Breakdown footprint exactly so
                                  the three icons share one box-size and
                                  there's no stray padding from the shadcn
                                  Button component (which carries its own
                                  h-8 px-3 padding). */}
                              <button
                                type="button"
                                title="Edit Service"
                                aria-label="Edit Service"
                                className="inline-flex items-center justify-center w-7 h-7 rounded border bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                                onClick={() => setEditingId(r.client_service_id)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                title="Remove Service"
                                aria-label="Remove Service"
                                className="inline-flex items-center justify-center w-7 h-7 rounded border bg-white border-rose-200 text-rose-600 hover:bg-rose-50"
                                onClick={() => onDelete(r)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        {/* colSpan = 7 (Service ID + Name + Category
                            + EF Charges + Cl Charges + Status + Actions). */}
                        <td colSpan={7} className="bg-slate-50 p-3">
                          <BreakdownPanel row={r} breakdown={bd} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {items.length > 0 && (
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={items.length}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
          className="px-1 pt-2"
        />
      )}

      {(adding || editingId != null) && (
        <ServiceFormDialog
          clientId={clientId}
          editingId={editingId}
          categories={categories ?? []}
          serviceTypes={serviceTypes ?? []}
          onClose={() => { setAdding(false); setEditingId(null); }}
          onSaved={() => {
            invalidateFetch((k) => k.startsWith(`/admin/clients/${clientId}/services`));
            refetch();
          }}
        />
      )}
    </div>
  );
}

/* ─── Breakdown expander panel ────────────────────────────────────── */

/*
 * BreakdownPanel — the row that drops down beneath a service when the
 * Show Breakdown icon is clicked. Same visual shape as JobModal's
 * BreakdownTable (slate-50 backdrop, 4-row table with per-layer ₹
 * cuts) but reads from `row.charges._breakdown` directly — no fetch.
 *
 * Each value is per-unit (multiply by qty at job-line write time).
 * Sums by design: ef + oh + cl + ef-er = total_charge (per-unit price).
 * The bundling decision means easyfix_charge on tbl_job_services
 * absorbs ef + oh — we surface them separately HERE so operators can
 * see WHY easyfix_charge has the value it does.
 */
function BreakdownPanel({
  row,
  breakdown,
}: {
  row: ClientServiceRow;
  breakdown: NonNullable<ChargesBreakdown['_breakdown']> | null;
}) {
  const fmt = (n: number | null | undefined) =>
    n == null
      ? '—'
      : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  if (!breakdown) {
    return (
      <div className="text-xs text-muted-foreground italic">
        Breakdown unavailable for this service (cascade not yet computed on the server).
      </div>
    );
  }

  // L1+L2 sum is what gets persisted as easyfix_charge on the job-line.
  // We show the sum AND the components so the bundling is transparent.
  const easyfixBundle = breakdown.ef_direct_share_per_unit + breakdown.overhead_share_per_unit;

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-slate-700">
        Per-unit cascade cuts for{' '}
        <span className="font-mono">
          ₹{Number(row.total_charge ?? row.charges?.total_charge ?? 0).toLocaleString('en-IN')}
        </span>{' '}
        total charge
      </div>
      <table className="data-table w-auto text-xs">
        <thead>
          <tr>
            <th className="!text-left">Layer</th>
            <th className="!text-right">Per-Unit Cut</th>
            <th className="!text-left">Bundled As</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="!text-left">L1 · Easyfix Direct</td>
            <td className="!text-right font-mono">{fmt(breakdown.ef_direct_share_per_unit)}</td>
            <td className="!text-left text-muted-foreground">
              <code>easyfix_charge</code>
            </td>
          </tr>
          <tr>
            <td className="!text-left">L2 · Overhead</td>
            <td className="!text-right font-mono">{fmt(breakdown.overhead_share_per_unit)}</td>
            <td className="!text-left text-muted-foreground">
              <code>easyfix_charge</code>
            </td>
          </tr>
          <tr>
            <td className="!text-left">L3 · Client Share</td>
            <td className="!text-right font-mono">{fmt(breakdown.client_share_per_unit)}</td>
            <td className="!text-left text-muted-foreground">
              <code>client_charge</code>
            </td>
          </tr>
          <tr>
            <td className="!text-left">L4 · Easyfixer (residual)</td>
            <td className="!text-right font-mono">{fmt(breakdown.easyfixer_share_per_unit)}</td>
            <td className="!text-left text-muted-foreground">
              <code>easyfixer_charge</code>
            </td>
          </tr>
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 bg-sky-50 text-sky-800 border border-sky-200 rounded px-1.5 py-0.5 font-mono">
          L1 + L2 = easyfix_charge: {fmt(easyfixBundle)}
        </span>
        <span className="text-muted-foreground">
          (L3 = client_charge, L4 = easyfixer_charge; together they sum to total_charge.)
        </span>
      </div>
    </div>
  );
}

/* ─── Form dialog (create + edit) ─────────────────────────────────── */

/*
 * Inline pair: a checkbox that gates a numeric input. Both Fixed and
 * Variable can be set on the same layer (independent), so we render
 * two of these side-by-side per layer (Easyfix Direct, Overhead,
 * Client Share). When unchecked, the input is disabled and we send 0
 * on save so the BE clears the column to a deterministic value.
 * Kept inline to honour the scope: no new files in this change.
 */
function CostPairRow({
  label, enabled, value, onToggle, onValueChange, suffix,
}: {
  label: string;
  enabled: boolean;
  value: string;
  onToggle: (next: boolean) => void;
  onValueChange: (v: string) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="inline-flex items-center gap-1.5 text-xs select-none cursor-pointer min-w-[5.5rem]">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        <span>{label}</span>
      </label>
      <div className="relative flex-1">
        <Input
          type="number"
          min={0}
          step="0.01"
          value={enabled ? value : ''}
          disabled={!enabled}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder="0.00"
          className="h-8 text-xs"
        />
        {suffix && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

/*
 * Mirror the BE cascade exactly so the live preview matches what the
 * server will compute on save. Order: Easyfix Direct → Overhead →
 * Client Share → Easyfixer (residual). Variable rates are %s.
 * Easyfix + Overhead bundle to `easyfix_charge`; Client Share is its
 * own; Easyfixer is the residual. We DON'T clamp here — we want
 * negative residuals to surface in red as a misconfiguration signal.
 */
function previewSplit(
  unitPrice: number,
  efF: number, efV: number,
  ohF: number, ohV: number,
  clF: number, clV: number,
) {
  let r = unitPrice;
  const efCut = r * (efV / 100) + efF; r -= efCut;
  const ohCut = r * (ohV / 100) + ohF; r -= ohCut;
  const clCut = r * (clV / 100) + clF; r -= clCut;
  return { easyfix: efCut + ohCut, client: clCut, easyfixer: r };
}

function formatRupee(n: number) {
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function ServiceFormDialog({
  clientId, editingId, categories, serviceTypes, onClose, onSaved,
}: {
  clientId: number;
  editingId: number | null;
  categories: ServiceCategory[];
  serviceTypes: ServiceType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = editingId != null;
  const [loadingPrefill, setLoadingPrefill] = useState<boolean>(isEdit);

  const [categoryId, setCategoryId] = useState<number>(0);
  const [typeIds, setTypeIds] = useState<number[]>([]);
  const [chargeType, setChargeType] = useState<'Fixed' | 'Variable'>('Fixed');
  const [totalCharge, setTotalCharge] = useState<string>('');

  // Per-layer Fixed + Variable, each gated by its own checkbox. We
  // keep the raw string in state for the input field (avoids
  // round-tripping NaN); on save we coerce via Number().
  const [efFixedOn, setEfFixedOn] = useState(false);
  const [efFixed, setEfFixed] = useState<string>('');
  const [efVarOn, setEfVarOn] = useState(false);
  const [efVar, setEfVar] = useState<string>('');

  const [ohFixedOn, setOhFixedOn] = useState(false);
  const [ohFixed, setOhFixed] = useState<string>('');
  const [ohVarOn, setOhVarOn] = useState(false);
  const [ohVar, setOhVar] = useState<string>('');

  const [clFixedOn, setClFixedOn] = useState(false);
  const [clFixed, setClFixed] = useState<string>('');
  const [clVarOn, setClVarOn] = useState(false);
  const [clVar, setClVar] = useState<string>('');

  const [serviceStatus, setServiceStatus] = useState<number>(1);
  const [saving, setSaving] = useState(false);

  // Fetch fresh row on Edit — the list row may be filtered out or
  // stale. New endpoint shipped on BE: GET /admin/clients/services/:id.
  useEffect(() => {
    if (!isEdit || editingId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const row = await api.get<ClientServiceRow>(`/admin/clients/services/${editingId}`);
        if (cancelled) return;
        setCategoryId(row.service_category_id);
        setTypeIds(row.service_type_ids ?? []);
        const ct = row.charge_type === 'Variable' ? 'Variable' : 'Fixed';
        setChargeType(ct);
        setTotalCharge(row.total_charge != null ? String(row.total_charge) : '');

        const seedPair = (
          v: number | null,
          setOn: (b: boolean) => void,
          setVal: (s: string) => void,
        ) => {
          if (v != null && Number(v) !== 0) {
            setOn(true);
            setVal(String(v));
          } else {
            setOn(false);
            setVal('');
          }
        };
        seedPair(row.easyfix_direct_fixed, setEfFixedOn, setEfFixed);
        seedPair(row.easyfix_direct_variable, setEfVarOn, setEfVar);
        seedPair(row.overhead_fixed, setOhFixedOn, setOhFixed);
        seedPair(row.overhead_variable, setOhVarOn, setOhVar);
        seedPair(row.client_fixed, setClFixedOn, setClFixed);
        seedPair(row.client_variable, setClVarOn, setClVar);
        setServiceStatus(row.service_status ?? 1);
      } catch (err) {
        if (!cancelled) {
          showToast({ variant: 'error', message: err instanceof ApiError ? err.message : 'Failed to load service.' });
        }
      } finally {
        if (!cancelled) setLoadingPrefill(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isEdit, editingId]);

  const typeOptions = useMemo(() => {
    const filtered = categoryId
      ? serviceTypes.filter((t) => !t.service_catg_id || t.service_catg_id === categoryId)
      : serviceTypes;
    return filtered.map((t) => ({ value: t.service_type_id, label: t.service_type_name }));
  }, [categoryId, serviceTypes]);

  const categoryOptions = useMemo(
    () => categories.map((c) => ({ value: c.service_catg_id, label: c.service_catg_name })),
    [categories],
  );

  // Live preview — runs the same cascade as the BE so the operator
  // sees the split before saving. Numbers default to 0 when the layer
  // is unchecked or empty.
  const split = useMemo(() => {
    const tc = Number(totalCharge) || 0;
    const num = (on: boolean, v: string) => (on ? (Number(v) || 0) : 0);
    return previewSplit(
      tc,
      num(efFixedOn, efFixed), num(efVarOn, efVar),
      num(ohFixedOn, ohFixed), num(ohVarOn, ohVar),
      num(clFixedOn, clFixed), num(clVarOn, clVar),
    );
  }, [totalCharge, efFixedOn, efFixed, efVarOn, efVar, ohFixedOn, ohFixed, ohVarOn, ohVar, clFixedOn, clFixed, clVarOn, clVar]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!categoryId) {
      showToast({ variant: 'error', message: 'Pick a service category.' });
      return;
    }
    if (typeIds.length === 0) {
      showToast({ variant: 'error', message: 'Pick at least one service type.' });
      return;
    }
    setSaving(true);
    try {
      const num = (on: boolean, v: string) => (on ? (Number(v) || 0) : 0);
      const payload: Record<string, unknown> = {
        serviceCategoryId: categoryId,
        serviceTypeIds: typeIds,
        chargeType,
        totalCharge: totalCharge === '' ? 0 : Number(totalCharge),
        easyfixDirectFixed:    num(efFixedOn, efFixed),
        easyfixDirectVariable: num(efVarOn,   efVar),
        overheadFixed:         num(ohFixedOn, ohFixed),
        overheadVariable:      num(ohVarOn,   ohVar),
        clientFixed:           num(clFixedOn, clFixed),
        clientVariable:        num(clVarOn,   clVar),
      };
      if (isEdit) {
        payload.serviceStatus = serviceStatus;
        await api.put<{ updated: boolean }>(`/admin/clients/services/${editingId}`, payload as never);
      } else {
        await api.post<{ client_service_id: number }>(`/admin/clients/${clientId}/services`, payload as never);
      }
      showToast({ variant: 'success', message: isEdit ? 'Service updated.' : 'Service added.' });
      onSaved();
      onClose();
    } catch (err) {
      showToast({ variant: 'error', message: err instanceof ApiError ? err.message : 'Save failed.' });
    } finally { setSaving(false); }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !saving });

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      {/* !max-w-2xl — the legacy field set is too tight at xl */}
      <DialogContent className="!max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Client Service' : 'Add Client Service'}</DialogTitle>
        </DialogHeader>
        {loadingPrefill ? (
          <div className="py-8 text-center text-xs text-muted-foreground">Loading service…</div>
        ) : (
        <form onSubmit={onSubmit} className="space-y-3 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Service Category <span className="text-red-600">*</span></Label>
              <SearchSelect
                value={categoryId || ''}
                onChange={(val) => {
                  const next = Number(val);
                  setCategoryId(next);
                  setTypeIds((prev) => prev.filter((id) => {
                    const t = serviceTypes.find((x) => x.service_type_id === id);
                    return !t || !t.service_catg_id || t.service_catg_id === next;
                  }));
                }}
                options={categoryOptions}
                placeholder="Select category…"
                required
              />
            </div>
            <div>
              <Label className="text-xs">
                Service <span className="text-red-600">*</span>
              </Label>
              {/* Renamed from "Service Type(s)" to "Service" to match
                  legacy nomenclature (the legacy modal's third dropdown
                  was labelled "Service"). The multi-select IS the
                  master service list — sourced from
                  /shared/lookup/service-types, the canonical catalog of
                  all available services across the platform.

                  Unlocked when no category is selected (was previously
                  `disabled={!categoryId}` which read as "no options" to
                  operators). Category becomes a FILTER over an already-
                  picked-able list, not a gate. If a category is picked,
                  the typeOptions useMemo narrows the list; otherwise
                  the full master shows. */}
              <SearchMultiSelect
                value={typeIds}
                onChange={(next) => setTypeIds(next.map((v) => Number(v)))}
                options={typeOptions}
                placeholder={
                  categoryId
                    ? 'Select service(s) from the master list…'
                    : 'Select service(s) from the master list (pick a category to narrow this list)'
                }
              />
              <div className="text-[11px] text-muted-foreground mt-1">
                {typeIds.length} selected · {typeOptions.length} available
                {categoryId ? ' (filtered by category)' : ' (showing full master list)'}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Total Charge Type</Label>
              <div className="flex items-center gap-4 h-9 pt-1">
                <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
                  <input
                    type="radio"
                    name="chargeType"
                    checked={chargeType === 'Fixed'}
                    onChange={() => setChargeType('Fixed')}
                    className="h-3.5 w-3.5"
                  />
                  <span>Fixed</span>
                </label>
                <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
                  <input
                    type="radio"
                    name="chargeType"
                    checked={chargeType === 'Variable'}
                    onChange={() => setChargeType('Variable')}
                    className="h-3.5 w-3.5"
                  />
                  <span>Variable</span>
                </label>
              </div>
            </div>
            <div>
              <Label className="text-xs">Total Charge (₹)</Label>
              <Input
                type="number" min={0} step="0.01"
                value={totalCharge}
                onChange={(e) => setTotalCharge(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>

          {/* Cost cascade — three layers, each with Fixed + Variable. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Easyfix Direct</Label>
              <div className="space-y-1.5 pl-1">
                <CostPairRow
                  label="Fixed"
                  enabled={efFixedOn} value={efFixed}
                  onToggle={setEfFixedOn} onValueChange={setEfFixed}
                />
                <CostPairRow
                  label="Variable"
                  enabled={efVarOn} value={efVar}
                  onToggle={setEfVarOn} onValueChange={setEfVar}
                  suffix="%"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Overhead</Label>
              <div className="space-y-1.5 pl-1">
                <CostPairRow
                  label="Fixed"
                  enabled={ohFixedOn} value={ohFixed}
                  onToggle={setOhFixedOn} onValueChange={setOhFixed}
                />
                <CostPairRow
                  label="Variable"
                  enabled={ohVarOn} value={ohVar}
                  onToggle={setOhVarOn} onValueChange={setOhVar}
                  suffix="%"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Client Share</Label>
              <div className="space-y-1.5 pl-1">
                <CostPairRow
                  label="Fixed"
                  enabled={clFixedOn} value={clFixed}
                  onToggle={setClFixedOn} onValueChange={setClFixed}
                />
                <CostPairRow
                  label="Variable"
                  enabled={clVarOn} value={clVar}
                  onToggle={setClVarOn} onValueChange={setClVar}
                  suffix="%"
                />
              </div>
            </div>
          </div>

          {/* Live preview pills */}
          <div className="flex flex-wrap items-center gap-2 text-xs border rounded bg-muted/30 px-3 py-2">
            <span className="text-muted-foreground">Computed split:</span>
            <span className="inline-flex items-center gap-1 bg-sky-50 text-sky-800 border border-sky-200 rounded px-2 py-0.5 font-mono">
              Easyfix: {formatRupee(split.easyfix)}
            </span>
            <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-800 border border-amber-200 rounded px-2 py-0.5 font-mono">
              Client: {formatRupee(split.client)}
            </span>
            <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono border ${
              split.easyfixer < 0
                ? 'bg-red-50 text-red-700 border-red-200'
                : 'bg-green-50 text-green-700 border-green-200'
            }`}>
              Easyfixer: {formatRupee(split.easyfixer)}
            </span>
            {split.easyfixer < 0 && (
              <span className="text-[11px] text-red-600">
                Costs exceed Total Charge — Easyfixer would receive a negative residual.
              </span>
            )}
          </div>

          {/* Formula helper — collapsible, native <details> so no extra
              dep. Tinted bg so it reads as help, not a primary field. */}
          <details className="group rounded border bg-muted/40 px-3 py-2">
            <summary className="cursor-pointer list-none flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <ChevronDown className="size-3.5 transition-transform group-open:rotate-0 -rotate-90" />
              Show Formula
            </summary>
            <div className="pt-2 text-xs text-muted-foreground space-y-1.5 leading-relaxed">
              <p className="font-medium text-foreground">How the cascade computes Easyfixer and Client charges</p>
              <p>
                Starting from <strong>Total Charge</strong> (per-unit price), each layer takes its cut in this order:
              </p>
              <ol className="list-decimal pl-5 space-y-0.5">
                <li><strong>Easyfix Direct</strong> — deduct <code>(remaining × Variable%) + Fixed</code></li>
                <li><strong>Overhead</strong> — deduct <code>(remaining × Variable%) + Fixed</code></li>
                <li><strong>Client Share</strong> — deduct <code>(remaining × Variable%) + Fixed</code></li>
                <li><strong>Easyfixer</strong> — gets everything left</li>
              </ol>
              <p className="italic">
                Variable rates are %s (e.g. 10 = 10%). Both Fixed and Variable can be set on the same layer.
              </p>
              <p>
                <strong>Example</strong>: Total = ₹400 · Easyfix Direct: Fixed 200 + Variable 10% → ₹400 − (₹400 × 10%) − ₹200 = ₹160 left for Overhead etc.
              </p>
              <p>
                The result: <strong>Easyfix Direct + Overhead</strong> bundle into <code>easyfix_charge</code>; <strong>Client Share</strong> becomes <code>client_charge</code>; <strong>Easyfixer</strong> is the residual <code>easyfixer_charge</code>. They sum to Total Charge × Quantity.
              </p>
            </div>
          </details>

          {isEdit && (
            <div>
              <Label className="text-xs">Status</Label>
              <select
                className="border rounded h-9 px-2 text-sm w-full bg-background"
                value={serviceStatus}
                onChange={(e) => setServiceStatus(Number(e.target.value))}
              >
                <option value={1}>Active</option>
                <option value={0}>Inactive</option>
              </select>
            </div>
          )}

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Service')}</Button>
          </DialogFooter>
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
