'use client';

/*
 * Client Material Rate dialog — Edit an existing row's client price for one
 * material (the pencil action in RateCardsTab's Materials table). Renders
 * one ClientMaterialPriceEditor per EXISTING group on the item (usually one;
 * more than one only when the client has several brand pairs priced for the
 * same material). See that file for the row editor.
 *
 * 2026-09-24 tx_share redesign (owner-approved): a group's brand pair is now
 * FIXED — this dialog edits Price/Tx Share/State Overrides for the pairs the
 * item already has; adding a NEW pair (a brand not yet on the card) goes
 * through AddClientMaterialsDialog's master-rows picker instead, same as any
 * other never-before-added pair.
 *
 * PUT /admin/clients/:clientId/material-rates/:materialId is a full replace.
 * The dialog is seeded straight from the item the caller already has
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
  ClientMaterialPriceEditor, clientMaterialRateRowToGroupPayload, isClientMaterialRateRowValid,
  seedClientMaterialRateRowValue, type ClientMaterialRateRowValue,
} from './ClientMaterialPriceEditor';
import type { ClientMaterialRateGroup, ClientMaterialRateItem } from './client-material-rate-types';

type EditableRow = { groupId: number; brandIds: number[]; label: string; value: ClientMaterialRateRowValue };

function groupLabel(g: ClientMaterialRateGroup): string {
  return g.brands.length === 0 ? 'No Brand' : g.brands.map((b) => b.brand_name).join(', ');
}

function seedRows(item: ClientMaterialRateItem): EditableRow[] {
  return item.groups.map((g) => ({
    groupId: g.group_id,
    brandIds: g.brands.map((b) => b.brand_id),
    label: groupLabel(g),
    value: seedClientMaterialRateRowValue(g),
  }));
}

export function ClientMaterialRateDialog({
  open, onClose, clientId, item, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  clientId: number;
  /* The row being edited — already carries every existing group/state. */
  item: ClientMaterialRateItem;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<EditableRow[]>(() => seedRows(item));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setRows(seedRows(item));
  }, [open, item]);

  const valid = rows.length > 0 && rows.every((r) => isClientMaterialRateRowValid(r.value));

  function patchRow(groupId: number, value: ClientMaterialRateRowValue) {
    setRows((prev) => prev.map((r) => (r.groupId === groupId ? { ...r, value } : r)));
  }

  async function handleSubmit() {
    setError(null);
    if (!valid) {
      setError('Every price needs a value greater than ₹0, and every state override needs at least one state, a price greater than ₹0, and a Tx Share.');
      return;
    }
    setSubmitting(true);
    try {
      const body = { groups: rows.map((r) => clientMaterialRateRowToGroupPayload(r.brandIds, r.value)) };
      await api.put(`/admin/clients/${clientId}/material-rates/${item.material_id}`, body);
      showToast({ variant: 'success', message: `Client price for "${item.material_name}" updated.` });
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
          <DialogTitle>Edit Client Price — &quot;{item.material_name}&quot;</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {rows.map((r) => (
            <div key={r.groupId} className="rounded-lg border p-4 space-y-3">
              <div className="font-medium text-sm">{r.label}</div>
              <ClientMaterialPriceEditor value={r.value} onChange={(next) => patchRow(r.groupId, next)} />
            </div>
          ))}

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
            {submitting ? 'Saving…' : 'Save Changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
