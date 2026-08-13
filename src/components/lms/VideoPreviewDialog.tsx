'use client';

/*
 * VideoPreviewDialog — watch a training video without leaving the CRM.
 *
 * The technician app has always been able to play these; the CRM could not,
 * so an operator curating a course had to open the link in another tab (and,
 * for the legacy rows, discover it did not load at all). This is the one place
 * that plays a training video in the CRM — Training Videos and Manage Courses
 * both mount it rather than each rolling a player that drifts on a control or
 * an aspect ratio.
 *
 * ─── Why two players and not one ─────────────────────────────────────────
 *
 * A YouTube watch URL is a PAGE, not a media file. Handing it to <video src>
 * renders a permanently blank frame with no error — the single most confusing
 * possible failure, because the control bar appears and simply never plays. So
 * YouTube goes through an iframe embed and everything else through <video>.
 * `youTubeId()` makes that decision once, in shared code.
 *
 * Direct .mp4 rows arrive already repaired: the backend rewrites the legacy
 * cleartext scheme and the malformed `core.easyfix_core.in` host before this
 * ever sees them (lms.service.js::normalizeVideoUrl). Without that they would
 * be mixed-content-blocked by the browser on an https CRM.
 */

import * as React from 'react';
import { Video, ExternalLink, AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { youTubeId, youTubeEmbedUrl } from '@/lib/video-url';

export function VideoPreviewDialog({
  open,
  onClose,
  title,
  url,
}: {
  open: boolean;
  onClose: () => void;
  /* Video title, shown in the dialog header so the operator knows what they opened. */
  title: string;
  /* Playable URL as returned by the backend, or null when nothing is linked. */
  url: string | null;
}) {
  const ytId = youTubeId(url);
  const trimmed = String(url ?? '').trim();

  /*
   * The shared close guard, with isDirty pinned false. This dialog is
   * read-only — there is no input and therefore nothing to discard — so the
   * guard never prompts and always closes immediately. Routing through it
   * anyway keeps every Dialog in the codebase on one close path, which is what
   * the lint rule protects: a hand-rolled onOpenChange is how a modal quietly
   * loses its discard prompt later, when someone adds a field to it.
   */
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  /*
   * Belt and braces on top of the `autoPlay` attribute.
   *
   * Safari treats declarative autoplay of an UNMUTED video more strictly than
   * Chrome does, but both allow an explicit play() that follows a user
   * gesture — and this dialog only ever mounts from a Play click, so the
   * document carries fresh user activation. Calling play() directly is the
   * path most likely to be honoured; the attribute covers the case where the
   * element starts on its own first.
   *
   * The rejection is swallowed deliberately. If a browser still refuses, the
   * correct outcome is a paused video with visible controls — not an
   * unhandled promise rejection in the console, and not a toast blaming the
   * operator for their browser's autoplay policy.
   */
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    videoRef.current?.play().catch(() => { /* autoplay blocked — controls remain */ });
  }, [open, trimmed]);

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Video className="size-4 shrink-0" />
            <span className="truncate">{title}</span>
          </DialogTitle>
        </DialogHeader>

        {!trimmed ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <AlertTriangle className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No Video Link</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              This catalogue entry has no video attached yet. Add a YouTube link from
              Edit to make it playable for technicians.
            </p>
          </div>
        ) : ytId ? (
          /*
           * `aspect-video` rather than a fixed height: the dialog is responsive
           * and a hard-coded height letterboxes on one breakpoint and crops on
           * another. allowFullScreen is deliberate — training videos carry
           * on-screen text that is unreadable at dialog size.
           */
          <div className="aspect-video w-full overflow-hidden rounded-md bg-black">
            <iframe
              key={ytId}
              src={youTubeEmbedUrl(ytId)}
              title={title}
              className="h-full w-full"
              /*
               * `autoplay` must be in this list or the `autoplay=1` in the
               * embed URL is ignored — a cross-origin iframe cannot start
               * playback unless the embedding page delegates the permission.
               * Both halves are required; with only one the frame loads
               * paused.
               */
              allow="autoplay; accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        ) : (
          <div className="aspect-video w-full overflow-hidden rounded-md bg-black">
            {/*
              autoPlay because the dialog only opens from an explicit Play
              click. preload is "auto" to match: the earlier "metadata" was
              chosen to avoid pulling a multi-megabyte legacy file for a video
              the operator might not watch — but once they have asked for
              playback, fetching it IS the point.

              `key` forces a fresh element when the url changes — a reused
              <video> keeps playing the previous source's buffered audio.
            */}
            <video
              key={trimmed}
              ref={videoRef}
              src={trimmed}
              controls
              autoPlay
              preload="auto"
              className="h-full w-full"
            />
          </div>
        )}

        {trimmed && (
          <a
            href={trimmed}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <ExternalLink className="size-3" />
            Open Original Link
          </a>
        )}
      </DialogContent>
    </Dialog>
  );
}
