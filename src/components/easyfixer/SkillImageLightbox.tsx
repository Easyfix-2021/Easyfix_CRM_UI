'use client';

import * as React from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

export type SkillImageLightboxValue = { url: string; name: string } | null;

export function SkillImageLightbox({
  value, onClose,
}: {
  value: SkillImageLightboxValue;
  onClose: () => void;
}) {
  /*
   * Project-canonical close handler — `useFormDirtyGuard` is mandatory
   * here per the `no-restricted-syntax` ESLint rule (inline arrow
   * functions on Dialog `onOpenChange` are blocked). `isDirty: false`
   * because the lightbox shows a single image with no form state.
   */
  const guardedClose = useFormDirtyGuard(onClose, { isDirty: false });
  return (
    <Dialog open={value !== null} onOpenChange={guardedClose}>
      <DialogContent className="sm:max-w-2xl" noPadding>
        <DialogHeader className="px-6 py-4 shrink-0">
          <DialogTitle className="text-base">{value?.name}</DialogTitle>
        </DialogHeader>
        {value?.url && (
          <div className="flex items-center justify-center p-6 pt-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={value.url}
              alt={value.name}
              className="max-h-[70vh] max-w-full object-contain rounded"
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
