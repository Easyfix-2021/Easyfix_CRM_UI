'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { api, ApiError } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import type { BrandListItem } from './types';

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

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('Brand Name is required'); return; }
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
          </div>
          {error && (
            <div className="text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-3">
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Brand'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
