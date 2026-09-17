'use client';

/*
 * Shared delete flow for both Materials and Brands — GET .../references
 * first, then branch per the contract:
 *   - 0 references  → a plain "Delete permanently?" body with a Delete button.
 *   - >0 references → this dialog: counts by type + "Deactivate Instead"
 *     or "Replace & Delete" (SearchSelect picker, excluding itself). A 409
 *     with `conflicts` (brand replace only, per contract) lists the
 *     conflicting materials inline and lets the operator retry.
 *
 * Self-contained: the page only needs to render it with an id + name and
 * an onDone() refresh callback — it owns its own fetch/mutation/toast.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import type { ReferencesResponse, ReplaceConflict } from './types';

export function DeleteReferencesDialog({
  open,
  onClose,
  entity,
  id,
  name,
  replacementOptions,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  entity: 'material' | 'brand';
  id: number | null;
  name: string;
  /* Same-entity options for the "Replace & Delete" picker — caller excludes `id`. */
  replacementOptions: SearchOption[];
  onDone: () => void;
}) {
  const basePath = entity === 'material' ? '/admin/materials' : '/admin/brands';
  const entityLabel = entity === 'material' ? 'Material' : 'Brand';

  const refsKey = open && id != null ? `${basePath}/${id}/references` : null;
  const { data: refs, loading } = useFetch<ReferencesResponse>(refsKey);

  const [replacementId, setReplacementId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ReplaceConflict[] | null>(null);

  useEffect(() => {
    if (!open) {
      setReplacementId('');
      setError(null);
      setConflicts(null);
    }
  }, [open]);

  // 0-reference path. Runs from the Delete button's click — never from an
  // effect — so the mutation is a direct operator action.
  async function deleteNow() {
    if (id == null) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`${basePath}/${id}`);
      showToast({ variant: 'success', message: `${entityLabel} deleted.` });
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  async function deactivateInstead() {
    if (id == null) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`${basePath}/${id}/status`, { is_active: false });
      showToast({ variant: 'success', message: `${entityLabel} deactivated.` });
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Deactivate failed');
    } finally {
      setBusy(false);
    }
  }

  async function replaceAndDelete() {
    if (id == null) return;
    if (!replacementId) { setError('Pick a replacement first.'); return; }
    setBusy(true);
    setError(null);
    setConflicts(null);
    try {
      await api.post(`${basePath}/${id}/replace-and-delete`, { replacement_id: Number(replacementId) });
      showToast({ variant: 'success', message: `${entityLabel} replaced and deleted.` });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.details && typeof e.details === 'object' && 'conflicts' in (e.details as object)) {
        setConflicts((e.details as { conflicts: ReplaceConflict[] }).conflicts ?? []);
        setError(e.message);
      } else {
        setError(e instanceof ApiError ? e.message : 'Replace & delete failed');
      }
    } finally {
      setBusy(false);
    }
  }

  // Not a form — no "unsaved input" to guard, just a plain close that
  // respects an in-flight mutation.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false, when: () => !busy });

  // Nothing to render until references have loaded.
  if (!open || id == null || loading || !refs) return null;

  if (refs.total === 0) {
    return (
      <Dialog open={open} onOpenChange={guardedOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete &quot;{name}&quot;?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This {entityLabel.toLowerCase()} has no references and will be permanently deleted. This cannot be undone.
          </p>
          {error && (
            <div className="text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-3">
            <CancelButton onCancel={onClose} disabled={busy} />
            <Button variant="destructive" onClick={deleteNow} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Can&apos;t Delete &quot;{name}&quot;</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">This {entityLabel.toLowerCase()} is referenced by:</p>
          <ul className="text-sm border rounded divide-y">
            {refs.by_type.map((t) => (
              <li key={t.type} className="flex items-center justify-between px-3 py-1.5">
                <span>{t.label}</span>
                <span className="font-medium">{t.count}</span>
              </li>
            ))}
          </ul>

          {conflicts && conflicts.length > 0 && (
            <div className="text-sm text-urgent-strong bg-urgent-tint border border-urgent/30 rounded p-2">
              <div className="font-medium mb-1">The replacement is already on:</div>
              <ul className="list-disc pl-5">
                {conflicts.map((c) => <li key={c.material_id}>{c.material_name}</li>)}
              </ul>
            </div>
          )}

          <div className="border-t pt-3 space-y-2">
            <div className="text-sm font-medium">Replace &amp; Delete</div>
            <SearchSelect
              value={replacementId}
              onChange={(v) => setReplacementId(v ? Number(v) : '')}
              options={replacementOptions}
              placeholder={`Pick a replacement ${entityLabel.toLowerCase()}…`}
            />
          </div>

          {error && (
            <div className="text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 pt-3">
          <Button variant="outline" onClick={deactivateInstead} disabled={busy}>Deactivate Instead</Button>
          <div className="flex gap-2">
            <CancelButton onCancel={onClose} disabled={busy} />
            <Button variant="destructive" onClick={replaceAndDelete} disabled={busy || !replacementId}>
              {busy ? 'Working…' : 'Replace & Delete'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
