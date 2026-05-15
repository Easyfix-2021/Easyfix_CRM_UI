'use client';

import { Download } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';

/*
 * Shared "Download" button with the canonical green Easyfix CRM
 * styling (emerald-600 bg, white text, disabled-tinted background).
 *
 * Replaces the dozens of:
 *   <Button className="bg-emerald-600 hover:bg-emerald-700 text-white ...">
 *     <Download className="h-4 w-4" /> Download
 *   </Button>
 * sites across the CRM with:
 *   <DownloadButton onClick={downloadXlsx} disabled={!hasRows} downloading={busy} />
 *
 * Design contract (kept identical to the original CallInfoModal pattern):
 *   - emerald-600 background, hover emerald-700
 *   - white text + Download icon (lucide)
 *   - disabled state: 40%-opacity emerald background, not-allowed cursor
 *   - inline-flex with 1.5 gap between icon and label
 *   - height 9 (h-9) — matches the standard Easyfix toolbar control row
 *   - md:w-auto / w-full so it stretches on mobile but stays compact on desktop
 *
 * Callers can override `label` and `loadingLabel` for non-XLSX contexts
 * ("Export CSV", "Saving…") and pass a `title` for the disabled-state
 * tooltip hint that the operator hovers over.
 *
 * Why a dedicated component instead of a Button variant?
 *   - A Button variant would force callers to remember the emerald
 *     classnames AND the Download icon AND the loadingLabel pattern.
 *     Bundling them keeps every download CTA in the CRM visually +
 *     behaviourally identical, which is the point.
 */

export function DownloadButton({
  onClick,
  disabled = false,
  downloading = false,
  label = 'Download',
  loadingLabel = 'Preparing…',
  title,
  className,
  type = 'button',
}: {
  onClick: () => void;
  /*
   * `disabled` ONLY reflects business state (nothing to download,
   * required filter missing, etc.). The component itself disables the
   * button while `downloading` is true so callers don't need to OR the
   * two flags together.
   */
  disabled?: boolean;
  downloading?: boolean;
  label?: string;
  loadingLabel?: string;
  /*
   * Tooltip shown on hover. Particularly useful for explaining WHY
   * the button is disabled ("No rows to export") so the operator
   * doesn't think the page is broken.
   */
  title?: string;
  className?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <Button
      type={type}
      onClick={onClick}
      disabled={disabled || downloading}
      title={title}
      className={cn(
        // md:w-auto / w-full: full-width on mobile so it doesn't look
        // orphaned, fixed-width on desktop where the toolbar has room.
        'md:w-auto w-full h-9 inline-flex items-center gap-1.5',
        // Canonical Easyfix green CTA palette.
        'bg-emerald-600 hover:bg-emerald-700 text-white',
        // Disabled state — keep the brand colour but visibly muted so
        // it doesn't read as a primary CTA when there's nothing to do.
        'disabled:bg-emerald-600/40 disabled:hover:bg-emerald-600/40 disabled:cursor-not-allowed',
        className,
      )}
    >
      <Download className="h-4 w-4" />
      {downloading ? loadingLabel : label}
    </Button>
  );
}
