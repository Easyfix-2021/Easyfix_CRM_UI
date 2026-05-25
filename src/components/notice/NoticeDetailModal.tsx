'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, Pin, X as XIcon } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NoticeCategoryTag } from './NoticeChip';
import { api } from '@/lib/api';
import { invalidateFetch } from '@/lib/hooks';
import { showToast } from '@/components/ui/toast';
import type { Notice } from '@/lib/notice-types';

/*
 * Notice detail modal — opens when an operator clicks a chip in the
 * dashboard strip or a row in the All-Notices list.
 *
 * Responsibilities:
 *   - Show full title, body, category, audience, action_url, pinned flag.
 *   - On open of an UNREAD notice for the current user, fire
 *     POST /admin/notices/:id/mark-read (surface='crm') exactly once —
 *     idempotent on the BE, but we still gate locally with a ref so we
 *     don't churn extra HTTP per re-render.
 *   - Invalidate the active-strip cache after marking so the unread
 *     dot disappears immediately (no full reload).
 */

export function NoticeDetailModal({
  notice,
  open,
  onClose,
}: {
  notice: Notice | null;
  open: boolean;
  onClose: () => void;
}) {
  const markedRef = React.useRef<number | null>(null);
  /*
   * Lightbox state — when the operator taps an image thumbnail we
   * open a fullscreen overlay showing it at native size. Esc / click
   * outside closes. The lightbox lives inside the modal's portal so
   * it stacks above the dialog without z-index gymnastics.
   */
  const [lightboxSrc, setLightboxSrc] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!lightboxSrc) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxSrc(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxSrc]);

  React.useEffect(() => {
    if (!open || !notice) return;
    if (notice.is_read) return;
    if (markedRef.current === notice.notice_id) return;
    markedRef.current = notice.notice_id;

    void (async () => {
      try {
        await api.post(`/admin/notices/${notice.notice_id}/mark-read`, { surface: 'crm' });
        invalidateFetch((k) => k.startsWith('/admin/notices/active'));
      } catch {
        // Silent — read tracking is best-effort. The badge stays until
        // the next list refresh, no operator-visible failure surface.
      }
    })();
  }, [open, notice]);

  if (!notice) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {notice.is_pinned ? <Pin className="h-4 w-4 text-amber-300" /> : null}
            <span className="truncate">{notice.title}</span>
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex items-center gap-2 pt-1">
              <NoticeCategoryTag name={notice.category_name} color={notice.category_color} />
              <span className="text-xs text-slate-200/80">
                {notice.publish_at
                  ? new Date(notice.publish_at).toLocaleString('en-IN', {
                      day: '2-digit', month: 'short', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })
                  : 'Draft — not published'}
              </span>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4 text-sm whitespace-pre-line text-foreground/90">
          {notice.body}
        </div>

        {/* Image gallery — only renders when there's at least one
            attachment. Grid auto-sizes from 2 → 3 → 4 cols depending
            on viewport so a 2-image notice doesn't render comically
            wide. Each thumbnail opens a lightbox at native size. */}
        {Array.isArray(notice.images) && notice.images.length > 0 && (
          <div className="px-6 pb-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {notice.images.map((src, i) => (
                <button
                  key={`${src}-${i}`}
                  type="button"
                  onClick={() => setLightboxSrc(src)}
                  className="block aspect-square rounded-md overflow-hidden border bg-muted hover:opacity-90 transition-opacity"
                  aria-label={`Open image ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={`Notice attachment ${i + 1}`} className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          </div>
        )}

        {notice.action_url && (
          <div className="px-6 pb-3">
            <Link
              href={notice.action_url}
              target={notice.action_url.startsWith('http') ? '_blank' : undefined}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-sky-700 hover:text-sky-900"
            >
              Open Link <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>
        )}

        {/* Lightbox — full-screen image viewer. Stacked above the
            dialog via a higher z-index than DialogContent (z-50 by
            default in the lib). Click anywhere outside the image to
            close; Esc also closes (effect above). */}
        {lightboxSrc && (
          <div
            className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center p-6"
            onClick={() => setLightboxSrc(null)}
          >
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setLightboxSrc(null); }}
              className="absolute top-4 right-4 rounded-full bg-white/10 hover:bg-white/20 text-white p-2"
              aria-label="Close"
            >
              <XIcon className="h-5 w-5" />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightboxSrc}
              alt="Full size"
              className="max-h-full max-w-full object-contain rounded"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Suppress unused-import warning — used inline above.
void showToast;
