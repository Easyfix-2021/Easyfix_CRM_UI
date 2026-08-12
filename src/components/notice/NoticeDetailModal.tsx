'use client';

import * as React from 'react';
import Link from 'next/link';
import { Cake, ExternalLink, Megaphone, PartyPopper, Pin, X as XIcon } from 'lucide-react';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NoticeCelebration, detectCelebration } from './NoticeCelebration';
import { api } from '@/lib/api';
import { invalidateFetch } from '@/lib/hooks';
import type { Notice } from '@/lib/notice-types';

/*
 * Notice detail modal — opens when an operator clicks a banner in the
 * dashboard strip or a row in the All-Notices list.
 *
 * Presentation (2026-08-12 redesign): this is a BROADCAST ANNOUNCEMENT, not a
 * data form, so it deliberately does NOT use the shared DialogHeader/Footer
 * chrome (flat slate band + right-aligned button row) that every CRUD modal in
 * the CRM wears. Ops asked for something that reads as an announcement, so the
 * modal renders `noPadding` and owns its own layout:
 *   - a gradient hero with a megaphone/pin medallion, so the eye lands on a
 *     symbol before it lands on text;
 *   - the title at display size, allowed to WRAP (it used to be truncated and
 *     was also physically overlapped by the dialog's absolute close X, which is
 *     why `hideClose` is set);
 *   - body copy at real reading size/leading rather than the CRM's dense
 *     table type;
 *   - ONE full-width primary "OK". A read-only announcement has no
 *     confirm/cancel branch, so a second dismissal (X, or "Close") was noise.
 *
 * Behaviour:
 *   - On open of an UNREAD notice, fire POST /admin/notices/:id/mark-read
 *     (surface='crm') exactly once — idempotent on the BE, but gated locally
 *     with a ref so re-renders don't churn extra HTTP.
 *   - Then invalidate the active-strip cache AND call `onRead`, so the caller
 *     can refetch (see the onRead prop note — eviction alone is not enough).
 */

export function NoticeDetailModal({
  notice,
  open,
  onClose,
  onRead,
}: {
  notice: Notice | null;
  open: boolean;
  onClose: () => void;
  /*
   * Fired once the BE has recorded the read. `invalidateFetch` only EVICTS the
   * module cache — it does not tell an already-mounted `useFetch` to re-request,
   * so the caller's "N unread" counter kept its stale value until a full page
   * reload. The owner of the list passes `refetch` here to close that gap.
   */
  onRead?: (noticeId: number) => void;
}) {
  const markedRef = React.useRef<number | null>(null);
  /*
   * Lightbox state — when the operator taps an image thumbnail we open a
   * fullscreen overlay showing it at native size. Esc / click outside closes.
   * The lightbox lives inside the modal's portal so it stacks above the dialog
   * without z-index gymnastics.
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

    const readId = notice.notice_id;
    void (async () => {
      try {
        await api.post(`/admin/notices/${readId}/mark-read`, { surface: 'crm' });
        invalidateFetch((k) => k.startsWith('/admin/notices/active'));
        // Evicting the cache is not enough for a mounted list — ask the owner
        // to re-request so the unread dot + counter clear immediately.
        onRead?.(readId);
      } catch {
        // Silent — read tracking is best-effort. The badge stays until the next
        // list refresh, no operator-visible failure surface.
      }
    })();
    // `onRead` is intentionally out of the dep list: callers pass an inline
    // arrow, and the markedRef guard already makes this fire once per notice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, notice]);

  if (!notice) return null;

  const publishedLabel = notice.publish_at
    ? new Date(notice.publish_at).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : 'Draft — not published';

  const body = notice.body ?? '';
  /*
   * Celebration keyword → burst animation, read off the title. Also decides the
   * medallion glyph so the icon and the animation always agree.
   */
  const celebration = detectCelebration(notice.title);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        hideClose
        noPadding
        className="sm:max-w-[32rem] rounded-2xl border-0 shadow-2xl"
      >
        {/*
          * Hero. The gradient + soft blurred blobs give the announcement a
          * "moment" instead of the flat slate band every CRUD dialog uses.
          * Blobs are pointer-events-none so they never eat a click.
          */}
        <div className="relative overflow-hidden bg-gradient-to-br from-sky-500 via-sky-600 to-indigo-700 px-6 pt-7 pb-6 text-center">
          <div className="pointer-events-none absolute -top-16 -right-12 h-40 w-40 rounded-full bg-white/15 blur-2xl" />
          <div className="pointer-events-none absolute -bottom-20 -left-14 h-44 w-44 rounded-full bg-white/10 blur-2xl" />

          {/* Confetti / balloons for a celebratory headline. Sits above the
              blobs but below the medallion + text so pieces fly BEHIND the
              content rather than over the words. */}
          <NoticeCelebration kind={celebration} />

          {/* Medallion — the glyph follows the occasion: cake for a birthday,
              popper for a celebration, pin for a pinned notice, megaphone for
              everything else. Gives the modal a focal point above the headline. */}
          <div className="relative mx-auto mb-3.5 flex h-14 w-14 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/30 backdrop-blur-sm">
            {celebration === 'birthday'
              ? <Cake className="h-7 w-7 text-amber-200" />
              : celebration === 'party'
                ? <PartyPopper className="h-7 w-7 text-amber-200" />
                : notice.is_pinned
                  ? <Pin className="h-7 w-7 text-amber-200" />
                  : <Megaphone className="h-7 w-7 text-white" />}
          </div>

          <DialogTitle className="relative text-xl font-bold leading-snug tracking-tight text-white">
            {notice.title}
          </DialogTitle>

          <DialogDescription asChild>
            <div className="relative mt-3 flex flex-wrap items-center justify-center gap-2">
              {/* Category as a translucent chip — the shared NoticeCategoryTag
                  is tuned for light table rows and washes out on the gradient.
                  The category's own colour survives as the leading dot. */}
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white ring-1 ring-inset ring-white/25">
                {notice.category_color && (
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: notice.category_color }}
                  />
                )}
                {notice.category_name}
              </span>
              <span className="text-xs text-white/85">{publishedLabel}</span>
            </div>
          </DialogDescription>
        </div>

        {/* Body — real reading typography: 15px at leading-7, full-strength
            slate, capped measure so a long notice never runs edge to edge. */}
        <div className="px-7 py-6">
          {/* Always left-aligned (per ops): a consistent left edge is easier to
              scan, and centred copy only ever flattered the shortest notices. */}
          <div className="whitespace-pre-line text-left text-[15px] leading-7 text-slate-700">
            {body}
          </div>

          {/* Image gallery — only renders with at least one attachment. Each
              thumbnail opens a lightbox at native size. */}
          {Array.isArray(notice.images) && notice.images.length > 0 && (
            <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-2">
              {notice.images.map((src, i) => (
                <button
                  key={`${src}-${i}`}
                  type="button"
                  onClick={() => setLightboxSrc(src)}
                  className="block aspect-square rounded-lg overflow-hidden border bg-muted hover:opacity-90 transition-opacity"
                  aria-label={`Open image ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={`Notice attachment ${i + 1}`} className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}

          {notice.action_url && (
            <div className="mt-5">
              <Link
                href={notice.action_url}
                target={notice.action_url.startsWith('http') ? '_blank' : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-sm font-medium text-sky-700 hover:bg-sky-100 hover:text-sky-900 transition-colors"
              >
                Open Link <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}
        </div>

        {/* Lightbox — full-screen image viewer, stacked above the dialog. */}
        {lightboxSrc && (
          <div
            className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center p-6"
            onClick={() => setLightboxSrc(null)}
          >
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setLightboxSrc(null); }}
              className="absolute top-4 right-4 rounded-full bg-white/10 hover:bg-white/20 text-white p-2"
              aria-label="Close image"
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

        {/* Single centred acknowledgement — a full-width bar read as a heavy
            call-to-action for what is only "I've seen this". Autofocused so
            Enter dismisses. */}
        <div className="flex justify-center px-7 pb-7">
          <Button
            type="button"
            onClick={onClose}
            autoFocus
            className="h-11 min-w-[10rem] rounded-xl px-10 text-sm font-semibold shadow-sm"
          >
            OK
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
