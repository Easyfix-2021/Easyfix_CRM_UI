'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { StatusChip } from '@/components/ui/StatusChip';
import { api, ApiError } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { useFetch, useDebouncedValue } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import type { BrandListItem, BrandListResponse } from './types';

/* Mirrors the backend's nameKey() normaliser (contract §Normaliser) for
   client-side "already exists" / "similar" detection only — the server
   remains the source of truth and still enforces the 409 on submit. */
function normalizeBrandName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function BrandDialog({
  open, onClose, editing, onSaved, canReactivate = false,
}: {
  open: boolean;
  onClose: () => void;
  editing: BrandListItem | null;
  onSaved: () => void;
  /* isBrandDeactivate — the same key gates Reactivate in the Brands list. */
  canReactivate?: boolean;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.brand_name ?? '');
      setError(null);
    }
  }, [open, editing]);

  // Fix B — suggestions as the user types (debounce ~250ms, ≥2 chars).
  const dName = useDebouncedValue(name, 250);
  const normalized = normalizeBrandName(dName);
  const suggestKey = open && normalized.length >= 2
    ? `/admin/brands?search=${encodeURIComponent(dName.trim())}&status=all&limit=8`
    : null;
  const { data: suggestData } = useFetch<BrandListResponse>(suggestKey);
  // Exclude the record being edited — its own (unchanged) name must never
  // flag itself as "already exists".
  const suggestions = (suggestData?.items ?? []).filter((b) => b.brand_id !== editing?.brand_id);
  const exactMatch = suggestions.find((b) => normalizeBrandName(b.brand_name) === normalized);
  const similar = suggestions.filter((b) => b !== exactMatch);

  // Picking fills the input with the brand's exact existing spelling; the list
  // stays hidden until the user types again (the debounced match catches up).
  const [pickedName, setPickedName] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const showList = !exactMatch && similar.length > 0 && name !== pickedName && normalizeBrandName(name).length >= 2;

  function pick(b: BrandListItem) {
    setName(b.brand_name);
    setPickedName(b.brand_name);
    setActive(0);
  }

  function onNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showList) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, similar.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(similar[active] ?? similar[0]); }
  }

  async function reactivate(b: BrandListItem) {
    setError(null);
    setSubmitting(true);
    try {
      await api.patch(`/admin/brands/${b.brand_id}/status`, { is_active: true });
      showToast({ variant: 'success', message: `"${b.brand_name}" reactivated.` });
      onSaved();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Reactivate failed';
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('Brand Name is required'); return; }
    if (exactMatch) { setError(`A brand named "${exactMatch.brand_name}" already exists.`); return; }
    setSubmitting(true);
    try {
      if (isEdit) await api.put(`/admin/brands/${editing!.brand_id}`, { brand_name: name.trim() });
      else await api.post('/admin/brands', { brand_name: name.trim() });
      showToast({ variant: 'success', message: `Brand ${isEdit ? 'updated' : 'added'}.` });
      onSaved();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Save failed';
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSubmitting(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: () => name.trim() !== (editing?.brand_name ?? ''),
    when: () => !submitting,
  });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.brand_name}"` : 'Add Brand'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="block mb-1" required>Brand Name</Label>
            <Input
              value={name}
              onChange={(e) => { setName(e.target.value); setActive(0); }}
              onKeyDown={onNameKeyDown}
              placeholder='e.g. "Philips"'
              autoFocus
              role="combobox"
              aria-expanded={showList}
              aria-controls="brand-suggestions"
              aria-autocomplete="list"
            />
            {/* In-flow (not a floating popover) so the Dialog's overflow can never clip it. */}
            {showList && (
              <ul id="brand-suggestions" role="listbox" className="mt-1 border rounded-md bg-card shadow-sm max-h-48 overflow-y-auto py-1">
                <li className="px-3 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Existing Brands — Select To Use</li>
                {similar.map((b, i) => (
                  <li
                    key={b.brand_id}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => { e.preventDefault(); pick(b); }}
                    onMouseEnter={() => setActive(i)}
                    className={`px-3 py-1.5 text-sm cursor-pointer flex items-center justify-between gap-2 ${i === active ? 'bg-muted' : ''}`}
                  >
                    <span>{b.brand_name}</span>
                    {b.status !== 1 && <StatusChip tone="neutral" size="sm">Inactive</StatusChip>}
                  </li>
                ))}
              </ul>
            )}
            {exactMatch && exactMatch.status === 1 && (
              <div className="mt-1 text-xs text-urgent flex items-center gap-1">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>&ldquo;{exactMatch.brand_name}&rdquo; already exists — use it as is.</span>
              </div>
            )}
            {exactMatch && exactMatch.status !== 1 && (
              <div className="mt-1 text-xs text-urgent flex items-center justify-between gap-2">
                <span className="flex items-center gap-1">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span>
                    &ldquo;{exactMatch.brand_name}&rdquo; already exists but is Inactive
                    {canReactivate ? '.' : ' — ask someone with brand permissions to reactivate it.'}
                  </span>
                </span>
                {canReactivate && (
                  <Button size="sm" variant="outline" onClick={() => reactivate(exactMatch)} disabled={submitting}>
                    {submitting ? 'Reactivating…' : 'Reactivate'}
                  </Button>
                )}
              </div>
            )}
          </div>
          {error && (
            <div className="text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-3">
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button onClick={handleSubmit} disabled={submitting || !!exactMatch}>
            {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Brand'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
