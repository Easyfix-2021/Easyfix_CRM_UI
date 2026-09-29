'use client';

import { useEffect, useMemo, useState } from 'react';
import { SkillImageLightbox } from '@/components/easyfixer/SkillImageLightbox';
import { cn } from '@/lib/utils';

/*
 * ─── Profile photo, list + modal ────────────────────────────────────────────
 *
 * Same three-state avatar the navbar's identity block renders
 * (components/layout/Navbar.tsx), lifted here so a row and the Add/Edit modal
 * can share one implementation:
 *
 *   1. photo   — <img> straight off the presigned `photo_url`.
 *   2. INITIALS — and this is the COMMON case, not a failure state. Almost
 *      nobody on tbl_user has uploaded a photo, so the monogram is what this
 *      column mostly IS; it gets the solid `bg-primary` plate and
 *      `text-primary-foreground` lettering so it reads as a deliberate
 *      identity chip rather than an empty hole. Both tokens are stable across
 *      :root/.dark, which is what local/no-inverting-surface-with-fixed-
 *      foreground requires of a plate carrying pinned lettering.
 *   3. the URL 404s — the third state nobody designs for. `photo_url` is
 *      presigned and short-lived, so a list left open past its TTL would
 *      otherwise paint a row of broken-image glyphs. onError drops back to the
 *      monogram, which is indistinguishable from having no photo — correct,
 *      because to the viewer it is.
 *
 * ONLY A REAL PHOTO IS CLICKABLE. With no photo there is nothing to enlarge, so
 * the monogram renders as a plain <span> and cannot open an empty lightbox; the
 * button (and its pointer cursor) appears only when a click would show
 * something. `failed` participates in that test, so a 404 removes the
 * affordance too rather than opening a dialog onto the same broken image.
 */
export function UserAvatar({ name, photoUrl, className }: { name: string; photoUrl?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  /* Reset on URL change, or a refreshed list (new presigned URL for the same
     user) would stay stuck on the monogram for the rest of the session. */
  useEffect(() => { setFailed(false); setZoomed(false); }, [photoUrl]);

  /* First letter of the first and last words, so "Priyanka Balasubramaniam"
     reads PB and a single-word name reads one letter rather than a doubled
     one. Uppercased — a lowercased login name would render a lowercase
     monogram. Identical rule to the navbar, deliberately. */
  const initials = useMemo(() => {
    const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    const first = parts[0][0] ?? '';
    const last  = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
    return (first + last).toUpperCase();
  }, [name]);

  const hasPhoto = !!photoUrl && !failed;
  const face = (
    <span
      aria-hidden
      className={cn('flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-xs font-semibold text-primary-foreground', className)}
    >
      {hasPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoUrl!}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : initials}
    </span>
  );

  if (!hasPhoto) return face;

  return (
    <>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        title="Click To Enlarge"
        aria-label={`Enlarge Photo Of ${name}`}
        className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {face}
      </button>
      {/* Closed lightbox costs nothing: DialogContent sits inside Radix's
          DialogPortal, which renders null until `open`, so the per-row
          instances never reach the DOM until one is clicked. */}
      <SkillImageLightbox
        value={zoomed ? { url: photoUrl!, name } : null}
        onClose={() => setZoomed(false)}
      />
    </>
  );
}
