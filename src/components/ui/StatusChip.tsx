/*
 * StatusChip — shared pill badge for status indicators across the CRM.
 *
 * Replaces the ad-hoc `<span className="inline-flex rounded-full px-2 py-0.5 ...">`
 * snippets that were copy-pasted across UnconfirmedJobsTable, JobModal,
 * NoticeBoard, etc., each with slight visual drift (padding, border-radius,
 * font-weight, border-on-or-off). One component, one shape, one source of
 * truth — drift becomes impossible.
 *
 * API
 *   <StatusChip tone="urgent">Unconfirmed</StatusChip>
 *   <StatusChip tone="warning" size="sm" title="…">Draft</StatusChip>
 *   <StatusChip tone="info" size="sm">Link Sent</StatusChip>
 *
 * Props
 *   - tone:  semantic colour token (resolves to bg/text/border classes)
 *   - size:  'sm' for sub-status / metadata pills,
 *            'md' for primary status (default)
 *   - title: native tooltip text (rendered on hover)
 *   - children: chip label (kept short — single Title Case word/phrase)
 *
 * Tone palette is intentionally additive — add new tones when a new
 * semantic colour is needed rather than passing raw Tailwind classes from
 * outside. Keeps the visual system tight.
 *
 * Every tone resolves to a BRAND TOKEN (bg-*-tint / text-*-strong), never a
 * raw Tailwind palette class, so a chip follows the theme and renders in dark
 * mode. `TONE_SURFACE_CLASSES` is exported because `statusColorClass()` in
 * `src/lib/utils.ts` renders the same palette without the border — it consumes
 * this table rather than keeping a second copy that can drift.
 */

import * as React from 'react';

export type StatusChipTone =
  /* ── Preferred spellings — semantic meaning families ────────────────── */
  | 'urgent'     // Unconfirmed, Cancelled, Escalated — needs attention
  | 'warning'    // Draft, In Progress, On Hold — work in flight
  | 'info'       // Link Sent, Scheduled — informational / neutral-positive
  | 'success'    // Customer Submitted, Completed
  | 'gold'       // Revisit, Quotation, grade — earned / distinct accent
  | 'neutral'    // Unknown, Enquiry — default fallback
  /* ── Legacy aliases — kept so existing call sites keep compiling ────── */
  | 'red'        // → urgent
  | 'rose'       // → urgent
  | 'amber'      // → warning
  | 'orange'     // → warning
  | 'sky'        // → info
  | 'emerald'    // → success
  | 'violet'     // → gold
  | 'slate';     // → neutral

export type StatusChipSize = 'sm' | 'md';

/*
 * Tint background + on-tint text, no border. Shared with `statusColorClass()`
 * so the code→colour decision lives in exactly one place.
 */
export const TONE_SURFACE_CLASSES: Record<StatusChipTone, string> = {
  urgent:  'bg-urgent-tint text-urgent-strong',
  warning: 'bg-warning-tint text-warning-strong',
  info:    'bg-info-tint text-info-strong',
  success: 'bg-success-tint text-success-strong',
  gold:    'bg-gold-tint text-gold-strong',
  neutral: 'bg-neutral-tint text-neutral-strong',
  // Aliases — same values as the semantic name they point at.
  red:     'bg-urgent-tint text-urgent-strong',
  rose:    'bg-urgent-tint text-urgent-strong',
  amber:   'bg-warning-tint text-warning-strong',
  orange:  'bg-warning-tint text-warning-strong',
  sky:     'bg-info-tint text-info-strong',
  emerald: 'bg-success-tint text-success-strong',
  violet:  'bg-gold-tint text-gold-strong',
  slate:   'bg-neutral-tint text-neutral-strong',
};

const TONE_BORDER_CLASSES: Record<StatusChipTone, string> = {
  urgent:  'border-urgent/30',
  warning: 'border-warning/30',
  info:    'border-info/30',
  success: 'border-success/30',
  gold:    'border-gold/30',
  neutral: 'border-neutral/30',
  red:     'border-urgent/30',
  rose:    'border-urgent/30',
  amber:   'border-warning/30',
  orange:  'border-warning/30',
  sky:     'border-info/30',
  emerald: 'border-success/30',
  violet:  'border-gold/30',
  slate:   'border-neutral/30',
};

const SIZE_CLASSES: Record<StatusChipSize, string> = {
  // sm — sub-status pills (Draft, Link Sent). 12px is the identity document's
  // type floor, so this is the smallest a chip is allowed to be; it stays
  // visually subordinate to the md chip through weight, not size.
  sm: 'text-xs font-semibold px-2 py-0.5',
  // md — primary status chip (Unconfirmed, Scheduled). Matches the
  // existing legacy job-status badge size so visual rhythm is unchanged.
  md: 'text-xs font-medium px-2 py-0.5',
};

export interface StatusChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusChipTone;
  size?: StatusChipSize;
}

export function StatusChip({
  tone,
  size = 'md',
  className,
  children,
  ...rest
}: StatusChipProps) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full border whitespace-nowrap',
        SIZE_CLASSES[size],
        TONE_SURFACE_CLASSES[tone],
        TONE_BORDER_CLASSES[tone],
        className ?? '',
      ].join(' ')}
      {...rest}
    >
      {children}
    </span>
  );
}

export default StatusChip;
