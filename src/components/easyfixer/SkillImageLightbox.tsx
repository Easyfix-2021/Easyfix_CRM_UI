'use client';

import * as React from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

/* `kind: 'video'` plays inline instead of opening a tab (2026-09-30, JobModal
   Images tab — tbl_job_image holds customer .mp4 clips beside the photos). */
export type SkillImageLightboxValue = {
  url: string;
  name: string;
  kind?: 'image' | 'video';
  /* Re-resolves a fresh URL. A presigned S3 URL dies after 5 min, and a
     <video> keeps range-requesting it — pause, come back, press play: 403. */
  refresh?: () => Promise<string | null>;
} | null;

/*
 * On a media error, fetch a fresh URL once and resume where playback stopped.
 * `retried` re-arms after a successful load, so each later expiry recovers too.
 * Keyed by the opening URL at the call site, so a new clip starts clean.
 */
function LightboxVideo({ url, refresh, className }: { url: string; refresh?: () => Promise<string | null>; className: string }) {
  const [src, setSrc] = React.useState(url);
  const resumeAt = React.useRef(0);
  const retried = React.useRef(false);
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      src={src}
      controls
      autoPlay
      playsInline
      className={className}
      onLoadedMetadata={(e) => {
        retried.current = false;
        if (resumeAt.current) { e.currentTarget.currentTime = resumeAt.current; resumeAt.current = 0; }
      }}
      onError={async (e) => {
        if (!refresh || retried.current) return;
        retried.current = true;
        resumeAt.current = e.currentTarget.currentTime;
        const next = await refresh().catch(() => null);
        if (next) setSrc(next);
      }}
    />
  );
}

export function SkillImageLightbox({
  value, onClose, wide = false,
}: {
  value: SkillImageLightboxValue;
  onClose: () => void;
  /* Near-full-viewport, for page screenshots: at the default 2xl a full-width
     capture comes out SMALLER than the thumbnail it was opened from. */
  wide?: boolean;
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
      <DialogContent className={wide ? '!max-w-none w-[calc(100vw-48px)]' : 'sm:max-w-2xl'} noPadding>
        <DialogHeader className="px-6 py-4 shrink-0">
          <DialogTitle className="text-base">{value?.name}</DialogTitle>
        </DialogHeader>
        {value?.url && (
          <div className="flex items-center justify-center p-6 pt-0">
            {value.kind === 'video' ? (
              <LightboxVideo
                key={value.url}
                url={value.url}
                refresh={value.refresh}
                className={`${wide ? 'max-h-[80vh]' : 'max-h-[70vh]'} max-w-full rounded bg-black`}
              />
            ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={value.url}
              alt={value.name}
              className={`${wide ? 'max-h-[80vh]' : 'max-h-[70vh]'} max-w-full object-contain rounded`}
            />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
