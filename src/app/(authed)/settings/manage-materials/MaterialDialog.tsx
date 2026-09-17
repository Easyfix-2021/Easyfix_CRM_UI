'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { PriceTree, type PriceTreeRow } from '@/components/ui/price-tree';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useLookup } from '@/lib/use-lookup';
import type { BrandOption, MaterialDetail, MaterialListItem, PricingType, UomOption } from './types';

/* A brand's inclusion of the system "Not Applicable" row is exclusive of
   every other brand on the SAME row. SearchMultiSelect always appends a
   freshly-toggled value to the end of the array, so the last element tells
   us which side of the toggle just happened. */
function enforceNotApplicableExclusivity(rows: PriceTreeRow[], naId: number | null): PriceTreeRow[] {
  if (naId == null) return rows;
  return rows.map((r) => {
    if (r.optionIds.length <= 1 || !r.optionIds.includes(naId)) return r;
    const last = r.optionIds[r.optionIds.length - 1];
    return last === naId
      ? { ...r, optionIds: [naId] }
      : { ...r, optionIds: r.optionIds.filter((id) => id !== naId) };
  });
}

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

export function MaterialDialog({
  open, onClose, editing, canSeeBrands, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: MaterialListItem | null;
  /* Whether this user has isBrandView — steers the empty-brands hint. */
  canSeeBrands: boolean;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const confirm = useConfirm();
  const lookup = useLookup();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [catgId, setCatgId] = useState<number | ''>('');
  const [uomId, setUomId] = useState<number | ''>('');
  const [pricingType, setPricingType] = useState<PricingType>('FIXED');
  const [brandGroups, setBrandGroups] = useState<PriceTreeRow[]>([]);
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
    setName(editing?.material_name ?? '');
    setDescription(editing?.description ?? '');
    setCatgId(editing?.service_catg_id ?? '');
    setUomId(editing?.uom_id ?? '');
    setPricingType(editing?.pricing_type ?? 'FIXED');
    setError(null);
    if (!isEdit) {
      setBrandGroups([]);
      setStatesByGroupId({});
    }
    seededForRef.current = null;
  }, [open, editing, isEdit]);

  // Seed the price tree from the detail fetch exactly once per open (mirrors
  // the pincodes zone-seed pattern) — a cache-driven re-resolve mid-edit
  // must not clobber the operator's in-progress changes.
  useEffect(() => {
    if (!open || !isEdit || !editing || !detail) return;
    if (detail.material_id !== editing.material_id) return;
    if (seededForRef.current === editing.material_id) return;
    const seeded = detailToTreeState(detail);
    setBrandGroups(seeded.groups);
    setStatesByGroupId(seeded.statesByGroupId);
    seededForRef.current = editing.material_id;
  }, [open, isEdit, editing, detail]);

  const notApplicableId = useMemo(
    () => (brandOptions ?? []).find((b) => b.is_system === 1)?.brand_id ?? null,
    [brandOptions],
  );

  // Merge active brand-options with any brand already on this material that
  // has since gone inactive, so its row still renders (tagged) and can be
  // removed even though it's no longer offered to new selections.
  const brandTreeOptions = useMemo(() => {
    const active = brandOptions ?? [];
    const activeIds = new Set(active.map((b) => b.brand_id));
    const inactiveOnMaterial = (detail?.groups ?? [])
      .flatMap((g) => g.brands)
      .filter((b) => !activeIds.has(b.brand_id) && b.status !== 1);
    const seen = new Set<number>();
    const extra: Array<{ value: number; label: string }> = [];
    for (const b of inactiveOnMaterial) {
      if (seen.has(b.brand_id)) continue;
      seen.add(b.brand_id);
      extra.push({ value: b.brand_id, label: `${b.brand_name} (Inactive)` });
    }
    return [...active.map((b) => ({ value: b.brand_id, label: b.brand_name })), ...extra];
  }, [brandOptions, detail]);

  const stateTreeOptions = useMemo(
    () => lookup.toOpts.states.map((s) => ({ value: Number(s.value), label: s.label })),
    [lookup.toOpts.states],
  );

  const hasActiveNonSystemBrands = (brandOptions ?? []).some((b) => b.is_system !== 1);

  const allGroupsValid = brandGroups.length > 0 && brandGroups.every(
    (g) => g.optionIds.length > 0 && g.price != null && g.price >= 0,
  );
  const statesValid = brandGroups.every((g) =>
    (statesByGroupId[g.id] ?? []).every((s) => s.optionIds.length > 0 && s.price != null && s.price >= 0),
  );
  const showPricePendingBanner = pricingType === 'FIXED' && !allGroupsValid;

  async function selectPricingType(next: PricingType) {
    if (next === pricingType) return;
    if (next === 'DYNAMIC' && brandGroups.some((g) => g.optionIds.length > 0 || g.price != null)) {
      const ok = await confirm({
        title: 'Switch to Dynamic Pricing?',
        description: 'Every brand price (and any state overrides) on this material will be removed. Continue?',
        confirmLabel: 'Switch & Remove',
        variant: 'destructive',
      });
      if (!ok) return;
      setBrandGroups([]);
      setStatesByGroupId({});
    }
    setPricingType(next);
  }

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('Material Name is required'); return; }
    if (!catgId) { setError('Category is required'); return; }
    if (pricingType === 'FIXED') {
      if (!allGroupsValid) { setError('Every brand-price group needs at least one brand and a price ≥ 0.'); return; }
      if (!statesValid) { setError('Every state override needs at least one state and a price ≥ 0.'); return; }
    }
    setSubmitting(true);
    try {
      const body = {
        material_name: name.trim(),
        description: description.trim() || null,
        service_catg_id: Number(catgId),
        uom_id: uomId ? Number(uomId) : null,
        pricing_type: pricingType,
        groups: pricingType === 'DYNAMIC' ? [] : brandGroups.map((g) => ({
          price: g.price,
          brand_ids: g.optionIds,
          states: (statesByGroupId[g.id] ?? []).map((s) => ({ price: s.price, state_ids: s.optionIds })),
        })),
      };
      if (isEdit) await api.put(`/admin/materials/${editing!.material_id}`, body);
      else await api.post('/admin/materials', body);
      showToast({ variant: 'success', message: `Material ${isEdit ? 'updated' : 'added'}.` });
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
          <DialogTitle>{isEdit ? `Edit "${editing!.material_name}"` : 'Add Material'}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
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
              {showPricePendingBanner && (
                <div className="text-sm text-warning-strong bg-warning-tint border border-warning/30 rounded p-2 flex items-start gap-2">
                  <AlertTriangle className="size-4 mt-0.5 shrink-0" />
                  <span>Price Pending — every brand-price group needs a price before this can be saved.</span>
                </div>
              )}

              {!hasActiveNonSystemBrands ? (
                <div className="text-sm text-muted-foreground border rounded p-3">
                  {canSeeBrands
                    ? 'No active brands yet — add them under Manage Brands below.'
                    : 'No active brands yet — ask an admin to add one under Manage Brands.'}
                </div>
              ) : (
                <PriceTree
                  options={brandTreeOptions}
                  rows={brandGroups}
                  onChange={(next) => setBrandGroups(enforceNotApplicableExclusivity(next, notApplicableId))}
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
            disabled={submitting || (pricingType === 'FIXED' && (!allGroupsValid || !statesValid))}
          >
            {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Material'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
