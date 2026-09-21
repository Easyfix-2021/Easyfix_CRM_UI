'use client';

/*
 * Shared pricing editor for a single client material price — No Brand /
 * Per Brand toggle, price, State Price Overrides via PriceTree. Extracted
 * from ClientMaterialRateDialog (2026-09-21) so the same editor can render
 * once per card in AddClientMaterialsDialog's batch-add list AND inside
 * ClientMaterialRateDialog's single-material edit flow — one editor, not
 * two copies. See ClientMaterialRateDialog.tsx's comment for why PriceTree
 * itself carries no domain knowledge.
 *
 * Fully controlled: the caller owns `value` (pricingMode + PriceTree rows +
 * per-group state rows) and gets every change via `onChange`. That's what
 * lets AddClientMaterialsDialog hold one independent value per picked
 * material without this component knowing about "a list of materials" at
 * all — it only ever edits one.
 */

import { useMemo } from 'react';
import { PriceTree, newPriceTreeRowId, type PriceTreeRow } from '@/components/ui/price-tree';
import { Label } from '@/components/ui/label';
import { useFetch } from '@/lib/hooks';
import { useLookup } from '@/lib/use-lookup';
import type { BrandOption } from '@/app/(authed)/settings/manage-materials/types';
import type { ClientMaterialRateGroup } from './client-material-rate-types';

export type PricingMode = 'NO_BRAND' | 'PER_BRAND';

export type ClientMaterialPriceEditorValue = {
  pricingMode: PricingMode;
  groups: PriceTreeRow[];
  statesByGroupId: Record<string, PriceTreeRow[]>;
};

function freshNoBrandGroup(): PriceTreeRow {
  return { id: newPriceTreeRowId(), optionIds: [], price: null };
}

export function freshClientMaterialPriceEditorValue(): ClientMaterialPriceEditorValue {
  return { pricingMode: 'NO_BRAND', groups: [freshNoBrandGroup()], statesByGroupId: {} };
}

function modeForGroups(groups: PriceTreeRow[]): PricingMode {
  return groups.length === 1 && groups[0].optionIds.length === 0 ? 'NO_BRAND' : 'PER_BRAND';
}

// Seed from an existing row's groups (the edit path — RateCardsTab's list
// fetch already carries the full groups/states, so there's no per-material
// detail fetch here).
export function seedClientMaterialPriceEditorValue(groups: ClientMaterialRateGroup[]): ClientMaterialPriceEditorValue {
  const outGroups: PriceTreeRow[] = [];
  const statesByGroupId: Record<string, PriceTreeRow[]> = {};
  for (const g of groups) {
    const id = `g_${g.group_id}`;
    outGroups.push({ id, optionIds: g.brands.map((b) => b.brand_id), price: Number(g.price) });
    statesByGroupId[id] = g.states.map((s) => ({ id: `s_${s.state_price_id}`, optionIds: s.state_ids, price: Number(s.price) }));
  }
  return { pricingMode: modeForGroups(outGroups), groups: outGroups, statesByGroupId };
}

// The `groups` shape both PUT /material-rates/:materialId and
// POST /material-rates/batch take.
export function editorValueToGroupsPayload(value: ClientMaterialPriceEditorValue) {
  return value.groups.map((g) => ({
    brand_ids: g.optionIds,
    price: g.price,
    states: (value.statesByGroupId[g.id] ?? []).map((s) => ({ state_ids: s.optionIds, price: s.price })),
  }));
}

// requirePrice, always — a client row exists only to state a price (unlike
// the master's optional No-Brand price / Price Pending case).
export function isClientMaterialPriceEditorValid(value: ClientMaterialPriceEditorValue): boolean {
  const { pricingMode, groups, statesByGroupId } = value;
  const noBrandGroup = pricingMode === 'NO_BRAND' ? groups[0] : undefined;
  const noBrandValid = !!noBrandGroup && noBrandGroup.price != null && noBrandGroup.price > 0;
  const perBrandGroupsValid = groups.length > 0 && groups.every((g) => g.optionIds.length > 0 && g.price != null && g.price > 0);
  const statesValid = groups.every((g) =>
    (statesByGroupId[g.id] ?? []).every((s) => s.optionIds.length > 0 && s.price != null && s.price > 0));
  return (pricingMode === 'NO_BRAND' ? noBrandValid : perBrandGroupsValid) && statesValid;
}

export function ClientMaterialPriceEditor({
  value, onChange,
}: {
  value: ClientMaterialPriceEditorValue;
  onChange: (next: ClientMaterialPriceEditorValue) => void;
}) {
  const lookup = useLookup();
  const { data: brandOptions } = useFetch<BrandOption[]>('/admin/materials/brand-options');

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

  const { pricingMode, groups, statesByGroupId } = value;
  const noBrandGroup = pricingMode === 'NO_BRAND' ? groups[0] : undefined;

  function selectPricingMode(next: PricingMode) {
    if (next === pricingMode) return;
    onChange({
      pricingMode: next,
      groups: [next === 'NO_BRAND' ? freshNoBrandGroup() : { id: newPriceTreeRowId(), optionIds: [], price: null }],
      statesByGroupId: {},
    });
  }

  function patchNoBrandPrice(price: number | null) {
    onChange({ ...value, groups: groups.map((g, i) => (i === 0 ? { ...g, price } : g)) });
  }

  return (
    <div className="space-y-4">
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
            onChange={(next) => noBrandGroup && onChange({ ...value, statesByGroupId: { ...statesByGroupId, [noBrandGroup.id]: next } })}
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
            onChange={(next) => onChange({ ...value, groups: next })}
            sectionLabel="Brand Prices"
            addLabel="Add Brand Price"
            minRows={1}
            requirePrice
            canEdit
            renderChildTree={(row) => (
              <PriceTree
                options={stateTreeOptions}
                rows={statesByGroupId[row.id] ?? []}
                onChange={(next) => onChange({ ...value, statesByGroupId: { ...statesByGroupId, [row.id]: next } })}
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
    </div>
  );
}
