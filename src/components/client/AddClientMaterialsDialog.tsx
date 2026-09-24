'use client';

/*
 * "Add Materials" modal — pick a MATERIAL-BRAND PAIR from the master-rows
 * endpoint (label like "Adapter 5A - Havells"), a priced card appears below,
 * pick another, and so on. One POST /admin/clients/:clientId/material-rates/
 * batch writes everything the user picked in a single transaction (see
 * routes/admin/clients.js).
 *
 * 2026-09-24 tx_share redesign (owner-approved): the picker used to be "pick
 * a whole material, then choose No Brand / Per Brand with a free brand
 * multi-select" — that's gone. Every pickable option is now a single fixed
 * pair (brand_id null = No Brand) already priced at the master rate; pairs
 * already on the client's card (any material+brand combo present in ANY of
 * its existing groups) never appear in the search results. Two picked pairs
 * that share a material_id (e.g. the same material in two brands) fold into
 * ONE `materials[]` entry with two groups on save — the batch endpoint's
 * shape is unchanged, only how many groups per material this dialog can
 * produce.
 *
 * Each card renders the SAME row editor ClientMaterialRateDialog uses for
 * editing an existing group — ClientMaterialPriceEditor — so there is one
 * editor implementation, not two copies.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { SearchSelect } from '@/components/ui/search-select';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useCancelConfirm } from '@/lib/use-cancel-confirm';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useDebouncedValue, useFetch } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { existingPairKeys, hideExistingPairs, pairKey } from '@/lib/material-rate-pairs';
import {
  ClientMaterialPriceEditor, clientMaterialRateRowToGroupPayload, freshClientMaterialRateRowValue,
  isClientMaterialRateRowValid, type ClientMaterialRateRowValue,
} from './ClientMaterialPriceEditor';
import type { ClientMaterialRateItem, MasterMaterialRateRow, MasterMaterialRateRowsResponse } from './client-material-rate-types';

type PickedRow = { masterRow: MasterMaterialRateRow; value: ClientMaterialRateRowValue };

export function AddClientMaterialsDialog({
  open, onClose, clientId, existingRates, onAdded,
}: {
  open: boolean;
  onClose: () => void;
  clientId: number;
  /* The client's current material rates — used only to hide pairs already
     on the card from the search results below. */
  existingRates: ClientMaterialRateItem[];
  /* Called after a successful batch save — the caller re-runs its own
     afterMaterialMutation (refetch) and closes. */
  onAdded: (count: number) => void;
}) {
  const [picked, setPicked] = useState<PickedRow[]>([]);
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dq = useDebouncedValue(query, 300);
  const searchKey = open
    ? `/admin/clients/${clientId}/material-rates/master-rows?limit=20${dq.trim() ? `&search=${encodeURIComponent(dq.trim())}` : ''}`
    : null;
  const { data: searchData, loading: searchLoading, error: searchError } = useFetch<MasterMaterialRateRowsResponse>(searchKey);

  const existingKeys = useMemo(() => existingPairKeys(existingRates), [existingRates]);
  const pickedKeys = useMemo(() => new Set(picked.map((p) => pairKey(p.masterRow.material_id, p.masterRow.brand_id))), [picked]);
  const remainingOptions = useMemo(
    () => hideExistingPairs(searchData?.items ?? [], existingKeys).filter((r) => !pickedKeys.has(pairKey(r.material_id, r.brand_id))),
    [searchData, existingKeys, pickedKeys],
  );

  function pickPair(v: string) {
    const opt = remainingOptions.find((r) => pairKey(r.material_id, r.brand_id) === v);
    setQuery('');
    if (!opt) return;
    setPicked((prev) => [...prev, { masterRow: opt, value: freshClientMaterialRateRowValue(Number(opt.price)) }]);
  }

  function removeCard(key: string) {
    setPicked((prev) => prev.filter((p) => pairKey(p.masterRow.material_id, p.masterRow.brand_id) !== key));
  }

  function patchCard(key: string, value: ClientMaterialRateRowValue) {
    setPicked((prev) => prev.map((p) => (pairKey(p.masterRow.material_id, p.masterRow.brand_id) === key ? { ...p, value } : p)));
  }

  const invalidKeys = useMemo(
    () => new Set(picked.filter((p) => !isClientMaterialRateRowValid(p.value)).map((p) => pairKey(p.masterRow.material_id, p.masterRow.brand_id))),
    [picked],
  );
  const canSave = picked.length > 0 && invalidKeys.size === 0;

  async function handleSave() {
    if (!canSave) return;
    setError(null);
    setSubmitting(true);
    try {
      // Fold picked pairs sharing a material_id into one materials[] entry —
      // "one group per row" at the pick level, unchanged batch shape.
      const byMaterial = new Map<number, ReturnType<typeof clientMaterialRateRowToGroupPayload>[]>();
      for (const p of picked) {
        const group = clientMaterialRateRowToGroupPayload(p.masterRow.brand_id != null ? [p.masterRow.brand_id] : [], p.value);
        const arr = byMaterial.get(p.masterRow.material_id) ?? [];
        arr.push(group);
        byMaterial.set(p.masterRow.material_id, arr);
      }
      const materials = [...byMaterial.entries()].map(([material_id, groups]) => ({ material_id, groups }));
      await api.post(`/admin/clients/${clientId}/material-rates/batch`, { materials });
      showToast({ variant: 'success', message: `${picked.length} material${picked.length === 1 ? '' : 's'} added.` });
      onAdded(picked.length);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Save failed.';
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSubmitting(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => picked.length > 0 && !submitting });
  const onCancel = useCancelConfirm(onClose, { when: () => picked.length > 0 && !submitting });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-3xl p-0 overflow-hidden flex flex-col max-h-[85vh]">
        <DialogHeader className="!mx-0 !mt-0 px-6 py-4 mb-0">
          <DialogTitle>Add Materials</DialogTitle>
        </DialogHeader>

        <div className="px-6 pt-4">
          <SearchSelect
            value=""
            onChange={pickPair}
            onQueryChange={setQuery}
            options={remainingOptions.map((r) => ({ value: pairKey(r.material_id, r.brand_id), label: r.label }))}
            placeholder={searchLoading ? 'Loading…' : 'Search material · brand…'}
            emptyText={searchError ? 'Lookup failed' : 'Type to search materials'}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {picked.length === 0 ? (
            <div className="text-sm text-muted-foreground italic py-6 text-center">
              Search and pick a material · brand from the list above.
            </div>
          ) : (
            picked.map(({ masterRow, value }) => {
              const key = pairKey(masterRow.material_id, masterRow.brand_id);
              const isInvalid = invalidKeys.has(key);
              return (
                <div
                  key={key}
                  className={cn(
                    'rounded-lg border p-4 space-y-3',
                    isInvalid ? 'border-urgent bg-urgent-tint/20' : 'border-border',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-sm flex items-center gap-2">
                      {masterRow.label}
                      {isInvalid && (
                        <span className="inline-flex items-center gap-1 text-urgent-strong text-xs">
                          <AlertTriangle className="size-3.5" /> Needs a price
                        </span>
                      )}
                    </div>
                    <IconButton
                      icon={Trash2}
                      label="Remove"
                      intent="danger"
                      onClick={() => removeCard(key)}
                    />
                  </div>
                  <ClientMaterialPriceEditor
                    value={value}
                    onChange={(next) => patchCard(key, next)}
                    masterStatePrices={masterRow.state_prices}
                  />
                </div>
              );
            })
          )}

          {error && (
            <div className="text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-3 border-t">
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSave} disabled={submitting || !canSave}>
            {submitting ? 'Saving…' : `Add ${picked.length || ''} Material${picked.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
