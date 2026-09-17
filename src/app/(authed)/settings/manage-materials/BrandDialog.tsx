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
  open, onClose, editing, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: BrandListItem | null;
  onSaved: () => void;
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
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Philips"' autoFocus />
            {exactMatch && (
              <div className="mt-1 text-xs text-urgent flex items-center gap-1">
                <AlertTriangle className="size-3.5" /> Already exists
                {exactMatch.status !== 1 && <StatusChip tone="neutral" size="sm">Inactive</StatusChip>}
              </div>
            )}
            {!exactMatch && similar.length > 0 && (
              <div className="mt-1 text-xs text-warning-strong flex flex-wrap items-center gap-1">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>
                  Similar existing brands:{' '}
                  {similar.map((b, i) => (
                    <span key={b.brand_id} className="inline-flex items-center gap-1">
                      {b.brand_name}
                      {b.status !== 1 && <StatusChip tone="neutral" size="sm">Inactive</StatusChip>}
                      {i < similar.length - 1 ? ',' : ''}
                    </span>
                  ))}
                </span>
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
