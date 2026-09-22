'use client';

/*
 * Client Material Rate dialog — Edit an existing row's client price for one
 * material (the pencil action in RateCardsTab's Materials table). The
 * picker → this-dialog "Add" flow was replaced (2026-09-21) by
 * AddClientMaterialsDialog's single batch-add modal; this dialog now renders
 * the SAME pricing editor that modal uses per-card — ClientMaterialPriceEditor
 * — rather than owning its own copy of the No Brand / Per Brand + PriceTree
 * logic. See that file for the editor and ClientMaterialPriceEditorValue.
 *
 * PUT /admin/clients/:clientId/material-rates/:materialId is a full replace.
 * The dialog is seeded straight from the row the caller already has
 * (RateCardsTab's list fetch already carries the full groups/states), so
 * there's no per-material detail fetch here.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import {
  ClientMaterialPriceEditor, editorValueToGroupsPayload, freshClientMaterialPriceEditorValue,
  isClientMaterialPriceEditorValid, seedClientMaterialPriceEditorValue,
  type ClientMaterialPriceEditorValue,
} from './ClientMaterialPriceEditor';
import type { ClientMaterialRateItem, ClientMaterialRateOption } from './client-material-rate-types';

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

  const [value, setValue] = useState<ClientMaterialPriceEditorValue>(freshClientMaterialPriceEditorValue());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setValue(editing ? seedClientMaterialPriceEditorValue(editing.groups) : freshClientMaterialPriceEditorValue());
  }, [open, editing]);

  const valid = isClientMaterialPriceEditorValid(value);

  async function handleSubmit() {
    setError(null);
    if (!valid) {
      setError('Every price group needs a price greater than ₹0, and every state override needs at least one state and a price greater than ₹0.');
      return;
    }
    setSubmitting(true);
    try {
      const body = { groups: editorValueToGroupsPayload(value) };
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
          <ClientMaterialPriceEditor value={value} onChange={setValue} />

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
            disabled={submitting || !valid}
          >
            {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Material'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
