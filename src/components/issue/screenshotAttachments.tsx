'use client';

/*
 * SCREENSHOT ATTACHMENTS — the one set of rules, for the three surfaces that
 * attach images to an issue.
 *
 * Until 2026-09-16 there was exactly one: the report form inside
 * IssueReporter. Then the owner asked for images on COMMENTS too, and comments
 * are written from TWO places — the reporter widget's thread and the Issue
 * Queue's detail dialog. Three copies of "which MIME types, how many, how big,
 * and what happens when one of a batch is wrong" is three chances to answer a
 * user differently for the same mistake, and the caps have to match the
 * backend's multer config exactly or the refusal arrives as a 400 after a 5 MB
 * upload instead of instantly.
 *
 * So: the state and the validation live in useScreenshotAttachments(), and the
 * markup in <ScreenshotField/>. A caller supplies neither.
 */

import * as React from 'react';
import { Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/ui/toast';

/*
 * Mirrors multer's cap and the route's allow-set in routes/admin/issues.js.
 * Checked here so an oversized paste is refused instantly rather than after an
 * upload the server then rejects.
 */
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const ACCEPT_ATTR = 'image/png,image/jpeg,image/webp,image/gif';

/** Mirrors MAX_SCREENSHOTS in routes/admin/issues.js. Enforced here so the
 *  sixth attachment is refused with a sentence rather than a 400. */
export const MAX_SCREENSHOTS = 5;

/*
 * The multipart field name is 'screenshot' — SINGULAR — on every surface,
 * because multer's .array('screenshot', N) is what the backend mounts and a
 * plural name would arrive as MulterError: Unexpected field. Declared once so
 * a second caller cannot guess 'screenshots'.
 */
export const SCREENSHOT_FIELD = 'screenshot';

export type ScreenshotAttachments = ReturnType<typeof useScreenshotAttachments>;

export function useScreenshotAttachments() {
  const [files, setFiles] = React.useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = React.useState<string[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);

  /* Local previews only — every URL is revoked when the set changes, so a long
   * session that pastes a dozen screenshots does not pin a dozen blobs in
   * memory. The whole list is rebuilt rather than diffed: createObjectURL is
   * free next to the render it triggers, and a diff here would be a cache with
   * an invalidation bug waiting in it. */
  React.useEffect(() => {
    if (!files.length) {
      setPreviewUrls([]);
      return;
    }
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviewUrls(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  /*
   * APPENDS. Picking files twice, or pasting twice, adds to the set rather
   * than replacing it — the capture routes are used together (paste the
   * screen, then browse for the log), and a picker that silently discarded the
   * first attachment was the original complaint.
   *
   * Each rejection reason is reported separately and the acceptable files in
   * the same batch are still kept: dropping four good screenshots because the
   * fifth was a PDF is not a helpful reading of "one of these is wrong".
   */
  const acceptFiles = React.useCallback((candidates: ArrayLike<File> | null | undefined) => {
    const incoming = Array.from(candidates ?? []);
    if (!incoming.length) return;

    const wrongType = incoming.filter((f) => !ALLOWED_MIME.has(f.type));
    const tooBig = incoming.filter((f) => ALLOWED_MIME.has(f.type) && f.size > MAX_SCREENSHOT_BYTES);
    const ok = incoming.filter((f) => ALLOWED_MIME.has(f.type) && f.size <= MAX_SCREENSHOT_BYTES);

    if (wrongType.length) {
      showToast({ variant: 'error', message: 'Only PNG, JPEG, WEBP Or GIF Screenshots Are Accepted.' });
    }
    if (tooBig.length) {
      showToast({ variant: 'error', message: 'Each Screenshot Must Be Under 5 MB.' });
    }
    if (!ok.length) return;

    setFiles((prev) => {
      const room = MAX_SCREENSHOTS - prev.length;
      if (room <= 0) {
        showToast({ variant: 'error', message: `You Can Attach Up To ${MAX_SCREENSHOTS} Screenshots.` });
        return prev;
      }
      if (ok.length > room) {
        showToast({ variant: 'error', message: `Only ${room} More Screenshot${room === 1 ? '' : 's'} Can Be Attached.` });
      }
      return [...prev, ...ok.slice(0, room)];
    });
  }, []);

  /* The clipboard. Win+Shift+S / Cmd+Ctrl+Shift+4 put the capture here and
   * nowhere else, so a paste anywhere in the form attaches it. */
  const onPaste = React.useCallback((e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (imgs.length) {
      e.preventDefault();
      acceptFiles(imgs);
    }
  }, [acceptFiles]);

  /* The input's value is cleared alongside the state on every removal: without
   * it, re-picking the SAME file fires no change event, so a screenshot
   * removed by mistake could not be re-added. */
  const clear = React.useCallback(() => {
    setFiles([]);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const removeAt = React.useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  return { files, previewUrls, acceptFiles, onPaste, clear, removeAt, inputRef, setFiles };
}

/*
 * Append the attachments to a FormData under the field name multer expects.
 * Repeated under ONE name — .array() collects them in this order, which
 * becomes tbl_crm_issue_image.sort_order.
 */
export function appendScreenshots(fd: FormData, files: File[]) {
  for (const f of files) fd.append(SCREENSHOT_FIELD, f);
}

/*
 * The picker + previews. `compact` drops the caption and shrinks the grid for
 * a comment box, where the control sits under a two-row textarea rather than
 * in a full form.
 */
export function ScreenshotField({
  attachments,
  compact,
  disabled,
  extraAction,
}: {
  attachments: ScreenshotAttachments;
  compact?: boolean;
  disabled?: boolean;
  /* The report form's Capture Screen button, which a comment box has no use
   * for — a reply is about something already on screen, not about the page the
   * reply is being typed on. */
  extraAction?: React.ReactNode;
}) {
  const { files, previewUrls, acceptFiles, clear, removeAt, inputRef } = attachments;
  const full = files.length >= MAX_SCREENSHOTS;

  return (
    <div className="flex flex-col gap-2">
      {!compact && (
        <span className="text-xs font-medium text-muted-foreground">
          Screenshots (Optional) {files.length ? `— ${files.length} Of ${MAX_SCREENSHOTS}` : ''}
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => acceptFiles(e.target.files)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={disabled || full}
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip className="h-4 w-4" aria-hidden="true" />
          {files.length ? 'Add More' : compact ? 'Attach Images' : 'Choose Files'}
        </Button>
        {extraAction}
        {files.length > 1 && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={clear}>
            Remove All
          </Button>
        )}
        {compact && files.length > 0 && (
          <span className="text-xs text-muted-foreground">{files.length} Of {MAX_SCREENSHOTS}</span>
        )}
      </div>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          Capture Screen Grabs This Tab; Or Paste Screenshots Anywhere In This Form. Up To {MAX_SCREENSHOTS}, 5 MB Each.
        </p>
      )}

      {previewUrls.length > 0 && (
        <div className={compact ? 'flex flex-wrap gap-2' : 'grid grid-cols-2 gap-2'}>
          {previewUrls.map((url, i) => (
            <div key={url} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={`Screenshot ${i + 1}`}
                className={compact
                  ? 'h-16 w-16 rounded border object-cover'
                  : 'h-28 w-full rounded border object-cover'}
              />
              <button
                type="button"
                aria-label={`Remove Screenshot ${i + 1}`}
                onClick={() => removeAt(i)}
                className="absolute right-1 top-1 rounded-full bg-card p-1 text-foreground shadow-sm transition-colors hover:bg-muted"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
