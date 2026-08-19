'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { invalidateFetch } from '@/lib/hooks';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import type { NoticeCategory } from '@/lib/notice-types';

/*
 * CategoryQuickAdd — inline category creator. Triggered from the
 * Compose form's category picker when the operator wants a colour or
 * label that isn't seeded yet (e.g. a one-off "Diwali Bonanza" tag).
 *
 * Posts to /admin/notice-categories. On success, invalidates the
 * /admin/notice-categories cache so the parent form's category list
 * refetches and the new entry appears in the dropdown immediately.
 *
 * The colour picker is a small swatch palette — we don't expose a free-
 * form hex input here because operators were picking unreadable shades.
 * Power-users can edit a category from the Settings page (deferred).
 */

/*
 * Brand swatches only.
 *
 * This was eight arbitrary hexes (amber, violet, blue, red, cyan, pink, slate).
 * The identity document's rule 7 is "no colour picker" and rule 10 is "no colour
 * that is not on this page" — an open palette lets any operator tag a category
 * in a colour the brand does not contain, permanently.
 *
 * The feature survives; the freedom to go off-brand does not. Six semantic
 * tokens cover every distinction a category tag actually needs, and they follow
 * the theme into dark mode, which raw hexes never did.
 */
const SWATCHES = [
  'hsl(var(--success))',
  'hsl(var(--warning))',
  'hsl(var(--urgent))',
  'hsl(var(--info))',
  'hsl(var(--gold))',
  'hsl(var(--neutral))',
];

export function CategoryQuickAdd({
  open, onClose, onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded?: (cat: NoticeCategory) => void;
}) {
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState(SWATCHES[0]);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) { setName(''); setColor(SWATCHES[0]); }
  }, [open]);

  async function handleSave() {
    if (!name.trim()) {
      showToast({ variant: 'error', message: 'Name is required' });
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ success: boolean; data: NoticeCategory }>(
        '/admin/notice-categories',
        { name: name.trim(), color, applies_to_surfaces: 'crm,client,technician' },
      );
      invalidateFetch((k) => k.startsWith('/admin/notice-categories'));
      showToast({ variant: 'success', message: 'Category added' });
      // api.post may unwrap the envelope already — guard either shape.
      const cat = (res as { data?: NoticeCategory })?.data ?? (res as unknown as NoticeCategory);
      onAdded?.(cat);
      onClose();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed to add category' });
    } finally {
      setSaving(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !saving });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> Add Notice Category
          </DialogTitle>
          <DialogDescription asChild>
            <div className="text-xs">
              Categories are coloured chips that prefix every notice. Admin can edit / deactivate them later from Settings.
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="p-6 space-y-4">
          <div>
            <Label htmlFor="cat-name">Name</Label>
            <Input
              id="cat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Diwali Bonanza"
              maxLength={60}
              autoFocus
            />
          </div>
          <div>
            <Label>Colour</Label>
            <div className="flex gap-2 flex-wrap pt-1">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`h-8 w-8 rounded-full border-2 transition-transform ${color === c ? 'border-foreground scale-110' : 'border-transparent'}`}
                  style={{ backgroundColor: c }}
                  aria-label={c}
                />
              ))}
            </div>
          </div>
          <div className="pt-1">
            <span
              className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide"
              style={{ color, backgroundColor: `${color}22`, border: `1px solid ${color}55` }}
            >
              {name.trim() || 'Preview'}
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? 'Adding…' : 'Add Category'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
