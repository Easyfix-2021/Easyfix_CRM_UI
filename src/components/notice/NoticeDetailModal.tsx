'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, X as XIcon } from 'lucide-react';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NoticeCelebration } from './NoticeCelebration';
import { themeForNotice, pinnedIcon } from './noticeThemes';
import { api } from '@/lib/api';
import { invalidateFetch } from '@/lib/hooks';
import type { Notice } from '@/lib/notice-types';

/*
 * Notice detail card — opens from the dashboard strip, the All-Notices list, or
 * the auto-flash queue (NoticeFlash).
 *
 * Presentation: this is a BROADCAST ANNOUNCEMENT, not a data form, so it does
 * not use the shared DialogHeader/Footer chrome (flat slate band +
 * right-aligned button row) that every CRUD modal wears. It renders
 * `noPadding` and owns its layout:
 *   - a themed hero (see noticeThemes.ts — aurora / spotlight / celebration, or
 *     a light "quiet" card for routine notices) with a medallion above the
 *     headline, so the eye lands on a symbol before it lands on text;
 *   - a headline that WRAPS (it used to be truncated, and was also physically
 *     overlapped by the dialog's absolute close X — hence `hideClose`);
 *   - body copy at reading size/leading, left-aligned;
 *   - ONE centred primary "OK": a read-only announcement has no confirm/cancel
 *     branch, so a second dismissal was noise.
 *
 * Behaviour: on open of an UNREAD notice, POST mark-read exactly once (ref-
 * gated so re-renders don't churn HTTP), then invalidate the active-notices
 * cache AND call `onRead` — see the prop note, eviction alone is not enough.
 */

export function NoticeDetailModal({
  notice,
  open,
  onClose,
  onRead,
  footer,
  stackDepth = 0,
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
  /*
   * Replaces the default OK button. NoticeFlash uses this to render the deck's
   * "1 of 3 · Next →" controls without forking the whole card.
   */
  footer?: (ctx: { buttonClass: string }) => React.ReactNode;
  /*
   * How many further notices are queued behind this one. Renders as stacked
   * "paper" edges peeking above the card. Drawn with layered box-shadows rather
   * than real elements: DialogContent is `overflow-hidden` (it has to be, so
   * the hero's gradient respects the rounded corners), which would clip any
   * ghost card positioned above it. Box-shadow paints outside the box, so it
   * survives the clip and costs no extra DOM.
   */
  stackDepth?: number;
}) {
  const markedRef = React.useRef<number | null>(null);
  /*
   * Lightbox — tapping a thumbnail opens it fullscreen. Esc / click outside
   * closes. Lives inside the modal's portal so it stacks above the dialog
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
        onRead?.(readId);
      } catch {
        // Silent — read tracking is best-effort.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, notice]);

  if (!notice) return null;

  const theme = themeForNotice(notice);
  const isPinned = !!notice.is_pinned;
  const Medallion = isPinned ? pinnedIcon() : theme.icon;
  const body = notice.body ?? '';

  const publishedLabel = notice.publish_at
    ? new Date(notice.publish_at).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : 'Draft — not published';

  const categoryChipDark = (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white ring-1 ring-inset ring-white/25">
      {notice.category_color && (
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: notice.category_color }} />
      )}
      {notice.category_name}
    </span>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        hideClose
        noPadding
        className={
          /*
           * BOUNDED HEIGHT + INTERNAL SCROLL (2026-08-13).
           *
           * Base DialogContent is `fixed top-1/2 -translate-y-1/2` with
           * `overflow-hidden` and NO max-height. A notice longer than the
           * viewport therefore grew the card past the screen in BOTH
           * directions, could not scroll internally, and could not be scrolled
           * into view from the page because it is `fixed` — so the footer's
           * dismiss button became unreachable and the notice was unclosable
           * except by Esc. A blocking modal must never be able to hide its own
           * way out.
           *
           * `max-h-[85vh]` + `flex flex-col` here, with the hero and footer
           * `shrink-0` and only the body scrolling, matches what the other
           * long modals in this app already do (settings/pincodes,
           * settings/deep-skills). It is a call-site fix, not a base one,
           * because that is this codebase's convention and 105 dialogs is too
           * wide a blast radius to change blind.
           */
          'sm:max-w-[32rem] rounded-2xl border-0 flex flex-col max-h-[85vh] '
          + (stackDepth >= 2
            ? 'shadow-[0_25px_50px_-12px_rgb(0_0_0_/_0.4),0_-9px_0_-4px_rgb(255_255_255_/_0.9),0_-18px_0_-8px_rgb(255_255_255_/_0.65)]'
            : stackDepth === 1
              ? 'shadow-[0_25px_50px_-12px_rgb(0_0_0_/_0.4),0_-9px_0_-4px_rgb(255_255_255_/_0.9)]'
              : 'shadow-2xl')
        }
      >
        {theme.heroClass ? (
          /* Dark themed hero — aurora / spotlight / celebration. */
          <div className={`relative shrink-0 overflow-hidden px-6 pt-7 pb-6 text-center ${theme.heroClass}`}>
            {/* Static depth blobs. The animated layers are CSS ::before/::after
                from the theme class, so they cost no extra DOM. */}
            <div className="pointer-events-none absolute -top-16 -right-12 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
            <div className="pointer-events-none absolute -bottom-20 -left-14 h-44 w-44 rounded-full bg-white/10 blur-2xl" />

            {/* Confetti flies BEHIND the medallion + text, never over the words. */}
            <NoticeCelebration kind={theme.celebration} />

            <div className="relative mx-auto mb-3.5 flex h-14 w-14 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/30 backdrop-blur-sm">
              <Medallion className={`h-7 w-7 ${isPinned ? 'text-amber-200' : theme.iconClass}`} />
            </div>

            {/* Pinned notices get the shimmer sweep — the one piece of "glow
                type" we borrow, reserved so it stays special. */}
            <DialogTitle
              className={`relative text-xl font-bold leading-snug tracking-tight ${isPinned ? 'nb-shimmer' : 'text-white'}`}
            >
              {notice.title}
            </DialogTitle>

            <DialogDescription asChild>
              <div className="relative mt-3 flex flex-wrap items-center justify-center gap-2">
                {categoryChipDark}
                <span className="text-xs text-white/85">{publishedLabel}</span>
              </div>
            </DialogDescription>
          </div>
        ) : (
          /* Quiet card — routine/policy notices. Deliberately calm: no hero, no
             motion, just a coloured rail. Not every notice deserves fireworks. */
          <div className="flex shrink-0 gap-4 px-6 pt-6">
            <div className={`w-1.5 shrink-0 rounded-full ${theme.railClass}`} />
            <div className="min-w-0">
              <DialogTitle className="text-left text-lg font-bold leading-snug text-slate-900">
                {notice.title}
              </DialogTitle>
              <DialogDescription asChild>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 font-semibold uppercase tracking-wide text-slate-600">
                    {notice.category_color && (
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: notice.category_color }} />
                    )}
                    {notice.category_name}
                  </span>
                  <span>{publishedLabel}</span>
                </div>
              </DialogDescription>
            </div>
          </div>
        )}

        {/* Body — reading typography, always left-aligned (a consistent left
            edge scans faster; centred copy only ever flattered the shortest
            notices). Indented on the quiet card to align under its headline. */}
        {/* The ONLY scrolling region. Hero above and footer below are shrink-0,
            so however long the body runs, the dismiss button stays on screen. */}
        <div className={`min-h-0 flex-1 overflow-y-auto ${theme.heroClass ? 'px-7 py-6' : 'px-6 py-5 pl-[3.4rem]'}`}>
          <div className="whitespace-pre-line text-left text-[15px] leading-7 text-slate-700">
            {body}
          </div>

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

        {/* shrink-0 wraps BOTH footers — the default OK and the caller-supplied
            deck footer from NoticeFlash — so neither can be squeezed to nothing
            by a long body. A dismiss control that is present but 0px tall is the
            same bug wearing a different hat. */}
        <div className="shrink-0 bg-white">
          {footer
            ? footer({ buttonClass: theme.buttonClass })
            : (
              /* Single centred acknowledgement — a full-width bar read as a heavy
                 call-to-action for what is only "I've seen this". */
              <div className="flex justify-center px-7 pb-7 pt-1">
                <Button
                  type="button"
                  onClick={onClose}
                  autoFocus
                  className={`h-11 min-w-[10rem] rounded-xl px-10 text-sm font-semibold shadow-sm ${theme.buttonClass}`}
                >
                  OK
                </Button>
              </div>
            )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
