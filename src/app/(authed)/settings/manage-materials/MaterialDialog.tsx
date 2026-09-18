'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { PriceTree, newPriceTreeRowId, type PriceTreeRow } from '@/components/ui/price-tree';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useLookup } from '@/lib/use-lookup';
import type { BrandOption, MaterialDetail, MaterialListItem, MaterialSaveBody, PricingType, UomOption } from './types';

type PricingMode = 'NO_BRAND' | 'PER_BRAND';

function detailToTreeState(detail: MaterialDetail): { groups: PriceTreeRow[]; statesByGroupId: Record<string, PriceTreeRow[]> } {
  const groups: PriceTreeRow[] = [];
  const statesByGroupId: Record<string, PriceTreeRow[]> = {};
  for (const g of detail.groups) {
    const id = `g_${g.group_id}`;
    groups.push({ id, optionIds: g.brands.map((b) => b.brand_id), price: g.price });
    statesByGroupId[id] = g.states.map((s) => ({ id: `s_${s.state_price_id}`, optionIds: s.state_ids, price: s.price }));
  }
  return { groups, statesByGroupId };
}

function modeForGroups(groups: PriceTreeRow[]): PricingMode {
  return groups.length === 1 && groups[0].optionIds.length === 0 ? 'NO_BRAND' : 'PER_BRAND';
}

function freshNoBrandGroup(): PriceTreeRow {
  return { id: newPriceTreeRowId(), optionIds: [], price: null };
}

export function MaterialDialog({
  open, onClose, editing, canSeeBrands, onSaved,
  prefill, overrideSubmit, titleOverride, submitLabelOverride, savedMessage, bannerNode,
}: {
  open: boolean;
  onClose: () => void;
  editing: MaterialListItem | null;
  /* Whether this user has isBrandView — steers the empty-brands hint. */
  canSeeBrands: boolean;
  onSaved: () => void;
  /*
   * Material Add Requests (approve flow) — seeds a brand-new material's
   * form from a request instead of a blank form or an existing material's
   * detail fetch. Only consulted when `editing` is null; `editing` (true
   * edit-existing-material) always wins. `groupSeed` is optional: omit it
   * to fall back to the normal blank-No-Brand default.
   */
  prefill?: {
    material_name: string;
    description?: string | null;
    service_catg_id: number;
    groupSeed?: { optionIds: number[]; price: number | null };
  } | null;
  /*
   * When set, Save calls this instead of POST /admin/materials or
   * PUT /admin/materials/:id — used by the request-approve flow, which
   * POSTs /admin/material-requests/:id/approve with the same body shape.
   * Errors thrown here are handled by the same catch block as the default
   * path (shown in the banner + toast), so a caller that wants to recover
   * from a specific error (e.g. a 409 duplicate) must catch-and-retry
   * internally and only rethrow what should surface to the operator.
   */
  overrideSubmit?: (body: MaterialSaveBody) => Promise<void>;
  titleOverride?: string;
  submitLabelOverride?: string;
  savedMessage?: string;
  /* Optional banner rendered at the top of the form body (e.g. "technician
     typed brand 'X' — no match found, pick one or leave No Brand"). */
  bannerNode?: ReactNode;
}) {
  const isEdit = !!editing;
  const confirm = useConfirm();
  const lookup = useLookup();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [catgId, setCatgId] = useState<number | ''>('');
  const [uomId, setUomId] = useState<number | ''>('');
  const [pricingType, setPricingType] = useState<PricingType>('FIXED');
  const [pricingMode, setPricingMode] = useState<PricingMode>('NO_BRAND');
  const [groups, setGroups] = useState<PriceTreeRow[]>([]);
  const [statesByGroupId, setStatesByGroupId] = useState<Record<string, PriceTreeRow[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: uoms } = useFetch<UomOption[]>('/admin/materials/uoms', { enabled: open });
  const { data: brandOptions } = useFetch<BrandOption[]>('/admin/materials/brand-options', { enabled: open });

  const detailKey = open && isEdit && editing ? `/admin/materials/${editing.material_id}` : null;
  const { data: detail } = useFetch<MaterialDetail>(detailKey);
  const seededForRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.material_name ?? prefill?.material_name ?? '');
    setDescription(editing?.description ?? prefill?.description ?? '');
    setCatgId(editing?.service_catg_id ?? prefill?.service_catg_id ?? '');
    setUomId(editing?.uom_id ?? '');
    setPricingType(editing?.pricing_type ?? 'FIXED');
    setError(null);
    if (!isEdit) {
      // Decision A: a brand-new Fixed material defaults to No Brand — one
      // optional-price group, no brand picker. The approve-request flow
      // (`prefill`) seeds that same group from the request instead.
      const seed = prefill?.groupSeed;
      const g = seed ? { id: newPriceTreeRowId(), optionIds: seed.optionIds, price: seed.price } : freshNoBrandGroup();
      setGroups([g]);
      setStatesByGroupId({});
      setPricingMode(seed && seed.optionIds.length > 0 ? 'PER_BRAND' : 'NO_BRAND');
    }
    seededForRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, isEdit, prefill]);

  // Seed the price tree from the detail fetch exactly once per open (mirrors
  // the pincodes zone-seed pattern) — a cache-driven re-resolve mid-edit
  // must not clobber the operator's in-progress changes. The dialog opens
  // in whichever mode the loaded data implies (a lone no-brand group → No
  // Brand, anything else → Per Brand).
  useEffect(() => {
    if (!open || !isEdit || !editing || !detail) return;
    if (detail.material_id !== editing.material_id) return;
    if (seededForRef.current === editing.material_id) return;
    const seeded = detailToTreeState(detail);
    setGroups(seeded.groups);
    setStatesByGroupId(seeded.statesByGroupId);
    setPricingMode(modeForGroups(seeded.groups));
    seededForRef.current = editing.material_id;
  }, [open, isEdit, editing, detail]);

  // Decision A: the "Not Applicable" system brand is gone — never offered,
  // never shown. Backend stops returning system brands from brand-options;
  // this filters defensively in case a stale/legacy row still comes back.
  const brandTreeOptions = useMemo(() => {
    const active = (brandOptions ?? []).filter((b) => b.is_system !== 1);
    const activeIds = new Set(active.map((b) => b.brand_id));
    const inactiveOnMaterial = (detail?.groups ?? [])
      .flatMap((g) => g.brands)
      .filter((b) => b.is_system !== 1 && !activeIds.has(b.brand_id) && b.status !== 1);
    const seen = new Set<number>();
    const extra: Array<{ value: number; label: string }> = [];
    for (const b of inactiveOnMaterial) {
      if (seen.has(b.brand_id)) continue;
      seen.add(b.brand_id);
      extra.push({ value: b.brand_id, label: `${b.brand_name} (Inactive)` });
    }
    return [...active.map((b) => ({ value: b.brand_id, label: b.brand_name })), ...extra];
  }, [brandOptions, detail]);

  // Fix F — verified: sourced from useLookup().states → GET
  // /shared/lookup/states → lookup.service.js reads tbl_state. Not
  // hardcoded; nothing to change here.
  const stateTreeOptions = useMemo(
    () => lookup.toOpts.states.map((s) => ({ value: Number(s.value), label: s.label })),
    [lookup.toOpts.states],
  );

  const hasActiveBrands = (brandOptions ?? []).some((b) => b.is_system !== 1);

  const noBrandGroup = pricingMode === 'NO_BRAND' ? groups[0] : undefined;
  const perBrandGroupsValid = groups.length > 0 && groups.every(
    (g) => g.optionIds.length > 0 && g.price != null && g.price >= 0,
  );
  const statesValid = groups.every((g) =>
    (statesByGroupId[g.id] ?? []).every((s) => s.optionIds.length > 0 && s.price != null && s.price >= 0));
  // No Brand's price is optional by design — only Per Brand groups block Save.
  const pricingValid = pricingMode === 'NO_BRAND' ? true : perBrandGroupsValid;

  // Fix E — Price Pending banner behaviour.
  const wasPricePendingOnLoad = isEdit && editing?.price_pending === true;
  const showNoBrandInfoNote = pricingType === 'FIXED' && pricingMode === 'NO_BRAND' && (noBrandGroup?.price == null);
  const showPerBrandPendingBanner = pricingType === 'FIXED' && pricingMode === 'PER_BRAND'
    && wasPricePendingOnLoad && !perBrandGroupsValid;

  function groupsCarryData(): boolean {
    return groups.some((g) => g.optionIds.length > 0 || g.price != null)
      || Object.values(statesByGroupId).some((rows) => rows.length > 0);
  }

  async function selectPricingType(next: PricingType) {
    if (next === pricingType) return;
    if (next === 'DYNAMIC' && groupsCarryData()) {
      const ok = await confirm({
        title: 'Switch to Dynamic Pricing?',
        description: 'Every price (and any state overrides) on this material will be removed. Continue?',
        confirmLabel: 'Switch & Remove',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    if (next === 'DYNAMIC') {
      setGroups([]);
      setStatesByGroupId({});
    } else if (groups.length === 0) {
      // Coming back from Dynamic with nothing set up yet — default to No Brand.
      setGroups([freshNoBrandGroup()]);
      setPricingMode('NO_BRAND');
    }
    setPricingType(next);
  }

  async function selectPricingMode(next: PricingMode) {
    if (next === pricingMode) return;
    if (groupsCarryData()) {
      const ok = await confirm({
        title: `Switch to ${next === 'PER_BRAND' ? 'Per Brand' : 'No Brand'} Pricing?`,
        description: pricingMode === 'PER_BRAND' ? 'Brand prices will be removed.' : 'The No Brand price will be removed.',
        confirmLabel: 'Switch & Remove',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    setGroups([next === 'NO_BRAND' ? freshNoBrandGroup() : { id: newPriceTreeRowId(), optionIds: [], price: null }]);
    setStatesByGroupId({});
    setPricingMode(next);
  }

  function patchNoBrandPrice(price: number | null) {
    setGroups((gs) => gs.map((g, i) => (i === 0 ? { ...g, price } : g)));
  }

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('Material Name is required'); return; }
    if (!catgId) { setError('Category is required'); return; }
    if (pricingType === 'FIXED') {
      if (pricingMode === 'PER_BRAND' && !perBrandGroupsValid) { setError('Every brand-price group needs at least one brand and a price ≥ 0.'); return; }
      if (!statesValid) { setError('Every state override needs at least one state and a price ≥ 0.'); return; }
    }
    setSubmitting(true);
    try {
      const body: MaterialSaveBody = {
        material_name: name.trim(),
        description: description.trim() || null,
        service_catg_id: Number(catgId),
        uom_id: uomId ? Number(uomId) : null,
        pricing_type: pricingType,
        groups: pricingType === 'DYNAMIC' ? [] : groups.map((g) => ({
          price: g.price,
          brand_ids: g.optionIds,
          states: (statesByGroupId[g.id] ?? []).map((s) => ({ price: s.price, state_ids: s.optionIds })),
        })),
      };
      if (overrideSubmit) await overrideSubmit(body);
      else if (isEdit) await api.put(`/admin/materials/${editing!.material_id}`, body);
      else await api.post('/admin/materials', body);
      showToast({ variant: 'success', message: savedMessage ?? `Material ${isEdit ? 'updated' : 'added'}.` });
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

  const categoryOptions: SearchOption[] = lookup.toOpts.serviceCategories;
  const uomOptions: SearchOption[] = (uoms ?? []).map((u) => ({ value: u.uom_id, label: u.uom_name }));

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-3xl p-0 overflow-hidden flex flex-col max-h-[85vh]">
        <DialogHeader className="!mx-0 !mt-0 px-6 py-4 mb-0">
          <DialogTitle>{titleOverride ?? (isEdit ? `Edit "${editing!.material_name}"` : 'Add Material')}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {bannerNode}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="block mb-1" required>Material Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Copper Wire 2.5mm"' />
            </div>
            <div>
              <Label className="block mb-1" required>Category</Label>
              <SearchSelect value={catgId} onChange={(v) => setCatgId(v ? Number(v) : '')} options={categoryOptions} required placeholder="Select a category…" />
            </div>
          </div>

          <div>
            <Label className="block mb-1">Description</Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[64px]"
              placeholder="Optional"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="block mb-1">UOM</Label>
              <SearchSelect value={uomId} onChange={(v) => setUomId(v ? Number(v) : '')} options={uomOptions} placeholder="— Select unit —" />
            </div>
            <div>
              <Label className="block mb-1" required>Pricing Type</Label>
              <div className="inline-flex rounded-md border border-input overflow-hidden h-9">
                {(['FIXED', 'DYNAMIC'] as PricingType[]).map((pt) => (
                  <button
                    key={pt}
                    type="button"
                    onClick={() => void selectPricingType(pt)}
                    className={`px-4 text-sm font-medium transition-colors ${pricingType === pt ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'}`}
                  >
                    {pt === 'FIXED' ? 'Fixed' : 'Dynamic'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {pricingType === 'FIXED' && (
            <>
              <div>
                <Label className="block mb-1">Brand Pricing</Label>
                <div className="inline-flex rounded-md border border-input overflow-hidden h-9">
                  {(['NO_BRAND', 'PER_BRAND'] as PricingMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => void selectPricingMode(mode)}
                      className={`px-4 text-sm font-medium transition-colors ${pricingMode === mode ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'}`}
                    >
                      {mode === 'NO_BRAND' ? 'No Brand' : 'Per Brand'}
                    </button>
                  ))}
                </div>
              </div>

              {showNoBrandInfoNote && (
                <div className="text-sm text-info-strong bg-info-tint border border-info/30 rounded p-2 flex items-start gap-2">
                  <Info className="size-4 mt-0.5 shrink-0" />
                  <span>No price entered — this material will be saved as Price Pending and won&apos;t appear in estimates until priced.</span>
                </div>
              )}
              {showPerBrandPendingBanner && (
                <div className="text-sm text-warning-strong bg-warning-tint border border-warning/30 rounded p-2 flex items-start gap-2">
                  <AlertTriangle className="size-4 mt-0.5 shrink-0" />
                  <span>Price every brand to clear Price Pending.</span>
                </div>
              )}

              {pricingMode === 'NO_BRAND' ? (
                <div className="space-y-3">
                  <div className="max-w-[220px]">
                    <Label className="block mb-1">Price (₹)</Label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={noBrandGroup?.price ?? ''}
                        onChange={(e) => patchNoBrandPrice(e.target.value === '' ? null : Number(e.target.value))}
                        placeholder="Optional"
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
                    {canSeeBrands
                      ? 'No active brands yet — add them under Manage Brands below.'
                      : 'No active brands yet — ask an admin to add one under Manage Brands.'}
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
            </>
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
            disabled={submitting || (pricingType === 'FIXED' && (!pricingValid || !statesValid))}
          >
            {submitting ? 'Saving…' : submitLabelOverride ?? (isEdit ? 'Save Changes' : 'Add Material')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
