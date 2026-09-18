'use client';

/*
 * Client Material Rate dialog — Add/Edit a client's override price for one
 * material. Reuses `PriceTree` UNCHANGED (per the sub-project C contract),
 * the same brand-group / state-override tree Settings > Manage Materials
 * uses, with `requirePrice` on: unlike the master, a client row exists only
 * to state a price (see the design doc, "No Brand mode" note).
 *
 * PUT /admin/clients/:clientId/material-rates/:materialId is a full replace
 * and is also the Add path — no separate create endpoint. The dialog is
 * seeded straight from the row the caller already has (RateCardsTab's list
 * fetch already carries the full groups/states), so there's no per-material
 * detail fetch here.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { PriceTree, newPriceTreeRowId, type PriceTreeRow } from '@/components/ui/price-tree';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useLookup } from '@/lib/use-lookup';
import type { BrandOption } from '@/app/(authed)/settings/manage-materials/types';
import type { ClientMaterialRateItem, ClientMaterialRateOption } from './client-material-rate-types';

type PricingMode = 'NO_BRAND' | 'PER_BRAND';

function freshNoBrandGroup(): PriceTreeRow {
  return { id: newPriceTreeRowId(), optionIds: [], price: null };
}

function itemToTreeState(item: ClientMaterialRateItem): { groups: PriceTreeRow[]; statesByGroupId: Record<string, PriceTreeRow[]> } {
  const groups: PriceTreeRow[] = [];
  const statesByGroupId: Record<string, PriceTreeRow[]> = {};
  for (const g of item.groups) {
    const id = `g_${g.group_id}`;
    groups.push({ id, optionIds: g.brands.map((b) => b.brand_id), price: Number(g.price) });
    statesByGroupId[id] = g.states.map((s) => ({ id: `s_${s.state_price_id}`, optionIds: s.state_ids, price: Number(s.price) }));
  }
  return { groups, statesByGroupId };
}

function modeForGroups(groups: PriceTreeRow[]): PricingMode {
  return groups.length === 1 && groups[0].optionIds.length === 0 ? 'NO_BRAND' : 'PER_BRAND';
}

export function ClientMaterialRateDialog({
  open, onClose, clientId, material, editing, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  clientId: number;
  /* The material being priced — from the Add picker (no groups yet) or the
     row being edited (already carries groups/states). */
  material: ClientMaterialRateOption;
  editing: ClientMaterialRateItem | null;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const lookup = useLookup();

  const [pricingMode, setPricingMode] = useState<PricingMode>('NO_BRAND');
  const [groups, setGroups] = useState<PriceTreeRow[]>([]);
  const [statesByGroupId, setStatesByGroupId] = useState<Record<string, PriceTreeRow[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: brandOptions } = useFetch<BrandOption[]>('/admin/materials/brand-options', { enabled: open });

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editing) {
      const seeded = itemToTreeState(editing);
      setGroups(seeded.groups);
      setStatesByGroupId(seeded.statesByGroupId);
      setPricingMode(modeForGroups(seeded.groups));
    } else {
      setGroups([freshNoBrandGroup()]);
      setStatesByGroupId({});
      setPricingMode('NO_BRAND');
    }
  }, [open, editing]);

  // Same defensive filter as MaterialDialog: the system "Not Applicable"
  // brand is never offered here either.
  const brandTreeOptions = useMemo(
    () => (brandOptions ?? []).filter((b) => b.is_system !== 1).map((b) => ({ value: b.brand_id, label: b.brand_name })),
    [brandOptions],
  );
  const stateTreeOptions = useMemo(
    () => lookup.toOpts.states.map((s) => ({ value: Number(s.value), label: s.label })),
    [lookup.toOpts.states],
  );
  const hasActiveBrands = (brandOptions ?? []).some((b) => b.is_system !== 1);

  const noBrandGroup = pricingMode === 'NO_BRAND' ? groups[0] : undefined;
  // requirePrice, always — a client row exists only to state a price
  // (unlike the master's optional No-Brand price / Price Pending case).
  const noBrandValid = !!noBrandGroup && noBrandGroup.price != null && noBrandGroup.price > 0;
  const perBrandGroupsValid = groups.length > 0 && groups.every((g) => g.optionIds.length > 0 && g.price != null && g.price > 0);
  const statesValid = groups.every((g) =>
    (statesByGroupId[g.id] ?? []).every((s) => s.optionIds.length > 0 && s.price != null && s.price > 0));
  const pricingValid = pricingMode === 'NO_BRAND' ? noBrandValid : perBrandGroupsValid;

  function selectPricingMode(next: PricingMode) {
    if (next === pricingMode) return;
    setGroups([next === 'NO_BRAND' ? freshNoBrandGroup() : { id: newPriceTreeRowId(), optionIds: [], price: null }]);
    setStatesByGroupId({});
    setPricingMode(next);
  }

  function patchNoBrandPrice(price: number | null) {
    setGroups((gs) => gs.map((g, i) => (i === 0 ? { ...g, price } : g)));
  }

  async function handleSubmit() {
    setError(null);
    if (!pricingValid) { setError('Every price group needs a price greater than ₹0.'); return; }
    if (!statesValid) { setError('Every state override needs at least one state and a price greater than ₹0.'); return; }
    setSubmitting(true);
    try {
      const body = {
        groups: groups.map((g) => ({
          brand_ids: g.optionIds,
          price: g.price,
          states: (statesByGroupId[g.id] ?? []).map((s) => ({ state_ids: s.optionIds, price: s.price })),
        })),
      };
      await api.put(`/admin/clients/${clientId}/material-rates/${material.material_id}`, body);
      showToast({ variant: 'success', message: `Client price for "${material.material_name}" ${isEdit ? 'updated' : 'added'}.` });
      onSaved();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Save failed';
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSubmitting(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-3xl p-0 overflow-hidden flex flex-col max-h-[85vh]">
        <DialogHeader className="!mx-0 !mt-0 px-6 py-4 mb-0">
          <DialogTitle>{isEdit ? `Edit Client Price — "${material.material_name}"` : `Add Client Price — "${material.material_name}"`}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div>
            <Label className="block mb-1">Brand Pricing</Label>
            <div className="inline-flex rounded-md border border-input overflow-hidden h-9">
              {(['NO_BRAND', 'PER_BRAND'] as PricingMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => selectPricingMode(mode)}
                  className={`px-4 text-sm font-medium transition-colors ${pricingMode === mode ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'}`}
                >
                  {mode === 'NO_BRAND' ? 'No Brand' : 'Per Brand'}
                </button>
              ))}
            </div>
          </div>

          {pricingMode === 'NO_BRAND' ? (
            <div className="space-y-3">
              <div className="max-w-[220px]">
                <Label className="block mb-1" required>Price (₹)</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={noBrandGroup?.price ?? ''}
                    onChange={(e) => patchNoBrandPrice(e.target.value === '' ? null : Number(e.target.value))}
                    placeholder="Required"
                    className="h-9 w-full rounded-md border border-input bg-background pl-5 pr-2 text-sm"
                  />
                </div>
              </div>
              <PriceTree
                options={stateTreeOptions}
                rows={noBrandGroup ? (statesByGroupId[noBrandGroup.id] ?? []) : []}
                onChange={(next) => noBrandGroup && setStatesByGroupId((prev) => ({ ...prev, [noBrandGroup.id]: next }))}
                sectionLabel="State Price Overrides"
                addLabel="Add State Price"
                canEdit
                requirePrice
                emptyText="No state overrides — uses the price above everywhere."
              />
            </div>
          ) : (
            !hasActiveBrands ? (
              <div className="text-sm text-muted-foreground border rounded p-3">
                No active brands yet — add them under Settings &gt; Manage Materials &gt; Manage Brands.
              </div>
            ) : (
              <PriceTree
                options={brandTreeOptions}
                rows={groups}
                onChange={setGroups}
                sectionLabel="Brand Prices"
                addLabel="Add Brand Price"
                minRows={1}
                requirePrice
                canEdit
                renderChildTree={(row) => (
                  <PriceTree
                    options={stateTreeOptions}
                    rows={statesByGroupId[row.id] ?? []}
                    onChange={(next) => setStatesByGroupId((prev) => ({ ...prev, [row.id]: next }))}
                    sectionLabel="State Price Overrides"
                    addLabel="Add State Price"
                    canEdit
                    requirePrice
                    emptyText="No state overrides — uses the brand price above everywhere."
                  />
                )}
              />
            )
          )}

          {error && (
            <div className="text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-3 border-t">
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button
            onClick={handleSubmit}
            disabled={submitting || !pricingValid || !statesValid}
          >
            {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Material'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
