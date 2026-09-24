'use client';

/*
 * Shared pricing editor for a SINGLE client material-rate row — one
 * material-brand pair's Price, Tx Share, and State Price Overrides (each
 * with its own Price + Tx Share). Extracted from ClientMaterialRateDialog
 * (2026-09-21) so the same editor can render once per card in
 * AddClientMaterialsDialog's batch-add list AND once per existing group in
 * ClientMaterialRateDialog's edit flow — one editor, not two copies.
 *
 * 2026-09-24 tx_share redesign (owner-approved): the row's brand pair is now
 * FIXED by the caller (picked from the master-rows endpoint, or an existing
 * group being edited) — this component no longer owns a No Brand / Per Brand
 * toggle or a brand multi-select; PriceTree here only ever picks STATES.
 * Tx Share always resets to 20% of its price whenever that price changes
 * (src/lib/tx-share.ts's `applyPriceChange` / `defaultTxShare`) but is
 * freely editable in between.
 */

import { useMemo } from 'react';
import { PriceTree, type PriceTreeRow } from '@/components/ui/price-tree';
import { Label } from '@/components/ui/label';
import { useLookup } from '@/lib/use-lookup';
import { applyPriceChange, defaultTxShare } from '@/lib/tx-share';
import type { ClientMaterialRateGroup, MasterMaterialStatePrice } from './client-material-rate-types';

export type ClientMaterialRateRowValue = {
  price: number | null;
  txShare: number | null;
  /* Each row's `optionIds` is the picked state_ids; `price`/`secondaryPrice`
     (Tx Share) are per-override. */
  states: PriceTreeRow[];
};

export function freshClientMaterialRateRowValue(masterPrice: number | null = null): ClientMaterialRateRowValue {
  return { price: masterPrice, txShare: masterPrice != null ? defaultTxShare(masterPrice) : null, states: [] };
}

// Seed from an existing group — RateCardsTab's list fetch already carries
// the full groups/states, so there's no per-material detail fetch here.
export function seedClientMaterialRateRowValue(group: ClientMaterialRateGroup): ClientMaterialRateRowValue {
  const price = Number(group.price);
  return {
    price,
    txShare: group.tx_share != null ? Number(group.tx_share) : defaultTxShare(price),
    states: group.states.map((s) => {
      const sPrice = Number(s.price);
      return {
        id: `s_${s.state_price_id}`,
        optionIds: s.state_ids,
        price: sPrice,
        secondaryPrice: s.tx_share != null ? Number(s.tx_share) : defaultTxShare(sPrice),
      };
    }),
  };
}

// The `groups[i]` shape both PUT /material-rates/:materialId and
// POST /material-rates/batch take — the caller supplies `brandIds` (the
// fixed pair this row represents: [] for No Brand, [brand_id] otherwise).
export function clientMaterialRateRowToGroupPayload(brandIds: number[], value: ClientMaterialRateRowValue) {
  return {
    brand_ids: brandIds,
    price: value.price,
    tx_share: value.txShare,
    states: value.states.map((s) => ({ state_ids: s.optionIds, price: s.price, tx_share: s.secondaryPrice ?? null })),
  };
}

// requirePrice, always — a client row exists only to state a price (unlike
// the master's optional No-Brand price / Price Pending case).
export function isClientMaterialRateRowValid(value: ClientMaterialRateRowValue): boolean {
  const priceValid = value.price != null && value.price > 0;
  const txShareValid = value.txShare != null && value.txShare >= 0;
  const statesValid = value.states.every((s) =>
    s.optionIds.length > 0 && s.price != null && s.price > 0 && s.secondaryPrice != null && s.secondaryPrice >= 0);
  return priceValid && txShareValid && statesValid;
}

function RupeeInput({ value, onChange, placeholder }: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
      <input
        type="number"
        min={0}
        step="0.01"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        placeholder={placeholder ?? 'Required'}
        className="h-9 w-full rounded-md border border-input bg-background pl-5 pr-2 text-sm"
      />
    </div>
  );
}

export function ClientMaterialPriceEditor({
  value, onChange, masterStatePrices,
}: {
  value: ClientMaterialRateRowValue;
  onChange: (next: ClientMaterialRateRowValue) => void;
  /* Master's per-state prices for this pair — only known when adding a NEW
     pair from master-rows. Used to prefill a newly-added state override's
     price when the user picks a state that has one. Omitted when editing an
     existing row (its states already carry their own saved prices). */
  masterStatePrices?: MasterMaterialStatePrice[];
}) {
  const lookup = useLookup();
  const stateTreeOptions = useMemo(
    () => lookup.toOpts.states.map((s) => ({ value: Number(s.value), label: s.label })),
    [lookup.toOpts.states],
  );
  const masterPriceByState = useMemo(() => {
    const m = new Map<number, number>();
    for (const sp of masterStatePrices ?? []) m.set(sp.state_id, Number(sp.price));
    return m;
  }, [masterStatePrices]);

  function patchPrice(price: number | null) {
    onChange(applyPriceChange(value, price));
  }
  function patchTxShare(txShare: number | null) {
    onChange({ ...value, txShare });
  }
  function patchStates(next: PriceTreeRow[]) {
    // ponytail: only a single-state row gets the master-price prefill — a
    // row with several states picked at once (rare) is left for the user to
    // price manually, since those states may carry different master prices.
    const withPrefill = next.map((r) => {
      if (r.price == null && r.optionIds.length === 1) {
        const mp = masterPriceByState.get(r.optionIds[0]);
        if (mp != null) return { ...r, price: mp, secondaryPrice: defaultTxShare(mp) };
      }
      return r;
    });
    onChange({ ...value, states: withPrefill });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 max-w-sm">
        <div>
          <Label className="block mb-1" required>Price (₹)</Label>
          <RupeeInput value={value.price} onChange={patchPrice} />
        </div>
        <div>
          <Label className="block mb-1">Tx Share (₹)</Label>
          <RupeeInput value={value.txShare} onChange={patchTxShare} />
        </div>
      </div>
      <PriceTree
        options={stateTreeOptions}
        rows={value.states}
        onChange={patchStates}
        sectionLabel="State Price Overrides"
        addLabel="Add State Price"
        canEdit
        requirePrice
        showSecondary
        secondaryLabel="Tx Share"
        deriveSecondaryOnPriceChange={defaultTxShare}
        emptyText="No state overrides — uses the price above everywhere."
      />
    </div>
  );
}
