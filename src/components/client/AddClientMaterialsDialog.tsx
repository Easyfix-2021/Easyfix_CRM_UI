'use client';

/*
 * "Add Materials" modal — replaces the old two-step flow (a picker dialog
 * that opened a second, single-material pricing dialog) with one modal:
 * pick a material, a priced card appears below, pick another, and so on.
 * One POST /admin/clients/:clientId/material-rates/batch writes everything
 * the user picked in a single transaction (see routes/admin/clients.js).
 *
 * Each card renders the SAME pricing editor ClientMaterialRateDialog uses
 * for editing a single row — ClientMaterialPriceEditor — so there is one
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
import { cn } from '@/lib/utils';
import {
  ClientMaterialPriceEditor, editorValueToGroupsPayload, freshClientMaterialPriceEditorValue,
  isClientMaterialPriceEditorValid, type ClientMaterialPriceEditorValue,
} from './ClientMaterialPriceEditor';
import type { ClientMaterialRateOption } from './client-material-rate-types';

type PickedMaterial = {
  material: ClientMaterialRateOption;
  value: ClientMaterialPriceEditorValue;
};

export function AddClientMaterialsDialog({
  open, onClose, clientId, materialOptions, onAdded,
}: {
  open: boolean;
  onClose: () => void;
  clientId: number;
  /* Materials not yet on this client's card — the same list the old picker
     used, filtered here as each one is picked. */
  materialOptions: ClientMaterialRateOption[];
  /* Called after a successful batch save — the caller re-runs its own
     afterMaterialMutation (refetch + invalidate the options key) and closes. */
  onAdded: (count: number) => void;
}) {
  const [picked, setPicked] = useState<PickedMaterial[]>([]);
  const [pickValue, setPickValue] = useState<string | number | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickedIds = useMemo(() => new Set(picked.map((p) => p.material.material_id)), [picked]);
  const remainingOptions = useMemo(
    () => materialOptions.filter((m) => !pickedIds.has(m.material_id)),
    [materialOptions, pickedIds],
  );

  function pickMaterial(v: string) {
    const opt = materialOptions.find((m) => String(m.material_id) === v);
    setPickValue('');
    if (!opt) return;
    setPicked((prev) => [...prev, { material: opt, value: freshClientMaterialPriceEditorValue() }]);
  }

  function removeCard(materialId: number) {
    setPicked((prev) => prev.filter((p) => p.material.material_id !== materialId));
  }

  function patchCard(materialId: number, value: ClientMaterialPriceEditorValue) {
    setPicked((prev) => prev.map((p) => (p.material.material_id === materialId ? { ...p, value } : p)));
  }

  const invalidIds = useMemo(
    () => new Set(picked.filter((p) => !isClientMaterialPriceEditorValid(p.value)).map((p) => p.material.material_id)),
    [picked],
  );
  const canSave = picked.length > 0 && invalidIds.size === 0;

  async function handleSave() {
    if (!canSave) return;
    setError(null);
    setSubmitting(true);
    try {
      const materials = picked.map((p) => ({
        material_id: p.material.material_id,
        groups: editorValueToGroupsPayload(p.value),
      }));
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
            value={pickValue}
            onChange={pickMaterial}
            options={remainingOptions.map((m) => ({ value: m.material_id, label: m.material_name }))}
            placeholder="Add a material…"
            emptyText="No more materials available"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {picked.length === 0 ? (
            <div className="text-sm text-muted-foreground italic py-6 text-center">
              Add materials from the list above.
            </div>
          ) : (
            picked.map(({ material, value }) => {
              const isInvalid = invalidIds.has(material.material_id);
              return (
                <div
                  key={material.material_id}
                  className={cn(
                    'rounded-lg border p-4 space-y-3',
                    isInvalid ? 'border-urgent bg-urgent-tint/20' : 'border-border',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-sm flex items-center gap-2">
                      {material.material_name}
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
                      onClick={() => removeCard(material.material_id)}
                    />
                  </div>
                  <ClientMaterialPriceEditor
                    value={value}
                    onChange={(next) => patchCard(material.material_id, next)}
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
