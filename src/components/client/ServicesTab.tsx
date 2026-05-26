'use client';

/*
 * Services tab — catalog of (category + service types + charge) rows
 * for a client. List + Add + Edit + soft-Delete.
 *
 * Perf design:
 *   - One useFetch for the list. The BE returns rows fully resolved
 *     (category_name + service_types[]) so there's NO secondary fetch
 *     per row on the FE side.
 *   - Lookups (categories + service types) loaded via useFetchOnce; the
 *     module-level cache in lib/hooks ensures repeated dialog opens
 *     don't hit the network.
 *   - Service-type options for the dialog are derived from the lookups
 *     via useMemo, filtered by the chosen category. No extra fetch on
 *     category change.
 *
 * UX design:
 *   - Compact table view with chips for service-type names (the most
 *     scannable shape for a 1-N relationship).
 *   - "Add Service" opens a dialog with: Category dropdown →
 *     Service Types multi-select (filtered by category) → Charge Type
 *     + Total Charge.
 *   - Optimistic delete: row disappears immediately, rolled back on
 *     error. Add/Edit go through a normal load → success → refetch
 *     flow since the user expects to see the new row populated.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { Plus, Pencil, Trash2, AlertCircle, Layers, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SearchSelect } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, invalidateFetch } from '@/lib/hooks';

type ServiceCategory = { service_catg_id: number; service_catg_name: string };
type ServiceType = { service_type_id: number; service_type_name: string; service_catg_id: number | null };

type ClientServiceRow = {
  client_service_id: number;
  client_id: number;
  service_category_id: number;
  service_category_name: string | null;
  service_type_ids: number[];
  service_types: { service_type_id: number; service_type_name: string | null }[];
  charge_type: string | null;
  total_charge: number | null;
  service_status: number | null;
};

type Props = {
  clientId: number;
  canEdit: boolean;
};

export function ServicesTab({ clientId, canEdit }: Props) {
  const listKey = `/admin/clients/${clientId}/services`;
  const { data, loading, error, refetch } = useFetch<ClientServiceRow[]>(listKey);

  // Lookups — module-deduped, fired once even if the tab is opened
  // and closed repeatedly. `/shared/lookup/service-categories` and
  // `/shared/lookup/service-types` already exist (see use-lookup.ts).
  const { data: categories } = useFetchOnce<ServiceCategory[]>(`/shared/lookup/service-categories`);
  const { data: serviceTypes } = useFetchOnce<ServiceType[]>(`/shared/lookup/service-types`);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ClientServiceRow | null>(null);
  // Optimistic-delete buffer — keeps deleted row ids hidden client-side
  // while the network call is in flight. If the call fails we clear
  // and refetch, so the row pops back in.
  const [pendingDeletes, setPendingDeletes] = useState<Set<number>>(() => new Set());
  const confirm = useConfirm();

  // Filtered, sorted view. useMemo keeps the table render cheap on
  // unrelated state changes (e.g. dialog open/close).
  const items = useMemo(() => {
    return (data ?? []).filter((r) => !pendingDeletes.has(r.client_service_id));
  }, [data, pendingDeletes]);

  async function onDelete(row: ClientServiceRow) {
    const ok = await confirm({
      title: 'Remove Service',
      description: `Remove "${row.service_category_name ?? 'Service'}" from this client? Existing jobs referencing it stay intact.`,
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!ok) return;
    // Optimistic hide
    setPendingDeletes((s) => new Set(s).add(row.client_service_id));
    try {
      await api.delete<{ deleted: boolean }>(`/admin/clients/services/${row.client_service_id}`);
      invalidateFetch((k) => k === listKey);
      refetch();
      // Once the refetch lands, the row is gone from `data` — drop our local hide.
      setPendingDeletes((s) => {
        const next = new Set(s);
        next.delete(row.client_service_id);
        return next;
      });
      showToast({ variant: 'success', message: 'Service removed.' });
    } catch (e) {
      // Rollback the optimistic hide
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
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {loading ? 'Loading…' : `${items.length} service${items.length === 1 ? '' : 's'}`}
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

      {/* Skeleton first-paint instead of a blank "Loading…" — feels faster */}
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
                <th className="!text-left">Category</th>
                <th className="!text-left">Service Types</th>
                <th className="!text-left">Charge Type</th>
                <th className="!text-right">Total Charge</th>
                {canEdit && <th className="!text-right">Action</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.client_service_id}>
                  <td className="!text-left">
                    <div className="font-medium flex items-center gap-1">
                      <Layers className="size-3.5 text-muted-foreground" />
                      {r.service_category_name ?? `#${r.service_category_id}`}
                    </div>
                  </td>
                  <td className="!text-left">
                    {r.service_types.length === 0 ? (
                      <span className="text-muted-foreground italic text-xs">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {r.service_types.map((t) => (
                          <span
                            key={t.service_type_id}
                            className="text-[11px] bg-sky-50 text-sky-800 border border-sky-200 rounded px-1.5 py-0.5 inline-flex items-center gap-1"
                          >
                            <Tag className="size-2.5" />
                            {t.service_type_name ?? `#${t.service_type_id}`}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="!text-left text-xs">
                    {r.charge_type ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-right font-mono text-xs">
                    {r.total_charge != null ? `₹${Number(r.total_charge).toLocaleString('en-IN')}` : <span className="text-muted-foreground">—</span>}
                  </td>
                  {canEdit && (
                    <td className="!text-right">
                      <div className="inline-flex items-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onDelete(r)} className="text-red-600 hover:text-red-700">
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(adding || editing) && (
        <ServiceFormDialog
          clientId={clientId}
          initial={editing}
          categories={categories ?? []}
          serviceTypes={serviceTypes ?? []}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => {
            invalidateFetch((k) => k === listKey);
            refetch();
          }}
        />
      )}
    </div>
  );
}

/* ─── Form dialog (create + edit) ─────────────────────────────────── */

const CHARGE_TYPES = ['Fixed', 'Variable', 'Per Visit', 'Per Hour'];

function ServiceFormDialog({
  clientId, initial, categories, serviceTypes, onClose, onSaved,
}: {
  clientId: number;
  initial: ClientServiceRow | null;
  categories: ServiceCategory[];
  serviceTypes: ServiceType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial;
  const [categoryId, setCategoryId] = useState<number>(initial?.service_category_id ?? 0);
  const [typeIds, setTypeIds] = useState<number[]>(initial?.service_type_ids ?? []);
  const [chargeType, setChargeType] = useState<string>(initial?.charge_type ?? '');
  const [totalCharge, setTotalCharge] = useState<string>(
    initial?.total_charge != null ? String(initial.total_charge) : '',
  );
  const [saving, setSaving] = useState(false);

  // Filter service-types to those in the chosen category. If the
  // lookup doesn't expose service_catg_id (legacy quirk), fall back
  // to "all types".
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
      const payload: Record<string, unknown> = {
        serviceCategoryId: categoryId,
        serviceTypeIds: typeIds,
        chargeType: chargeType || null,
      };
      if (totalCharge !== '') payload.totalCharge = Number(totalCharge);
      if (isEdit && initial) {
        await api.put<{ updated: boolean }>(`/admin/clients/services/${initial.client_service_id}`, payload as never);
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

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="!max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Service' : 'Add Service'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3 pt-1">
          <div>
            <Label className="text-xs">Service Category <span className="text-red-600">*</span></Label>
            <SearchSelect
              value={categoryId || ''}
              onChange={(val) => {
                const next = Number(val);
                setCategoryId(next);
                // Clear types that no longer belong to the new category — prevents
                // submitting orphan ids when the user switches mid-form.
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
            <Label className="text-xs">Service Types <span className="text-red-600">*</span></Label>
            <SearchMultiSelect
              value={typeIds}
              onChange={(next) => setTypeIds(next.map((v) => Number(v)))}
              options={typeOptions}
              placeholder={categoryId ? 'Select service types…' : 'Pick a category first'}
              disabled={!categoryId}
            />
            <div className="text-[11px] text-muted-foreground mt-1">
              {typeIds.length} selected · {typeOptions.length} available in this category
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Charge Type</Label>
              <select
                className="border rounded h-9 px-2 text-sm w-full bg-background"
                value={chargeType}
                onChange={(e) => setChargeType(e.target.value)}
              >
                <option value="">—</option>
                {CHARGE_TYPES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
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
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Service')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
