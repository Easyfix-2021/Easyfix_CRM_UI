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
 *   <StatusChip tone="red">Unconfirmed</StatusChip>
 *   <StatusChip tone="amber" size="sm" title="…">Draft</StatusChip>
 *   <StatusChip tone="sky" size="sm">Link Sent</StatusChip>
 *
 * Props
 *   - tone:  semantic colour token (resolves to bg/text/border classes)
 *   - size:  'sm' (10px text) for sub-status / metadata pills,
 *            'md' (12px text) for primary status (default)
 *   - title: native tooltip text (rendered on hover)
 *   - children: chip label (kept short — single Title Case word/phrase)
 *
 * Tone palette is intentionally additive — add new tones when a new
 * semantic colour is needed rather than passing raw Tailwind classes from
 * outside. Keeps the visual system tight.
 */

import * as React from 'react';

export type StatusChipTone =
  | 'red'        // Unconfirmed, Cancelled — needs attention / negative
  | 'amber'      // Draft, In Progress, Reminder — work in flight
  | 'sky'        // Link Sent, Scheduled — informational / neutral-positive
  | 'emerald'    // Customer Submitted, Completed — success
  | 'slate'      // Unknown, neutral — default fallback
  | 'violet'     // Revisit, Quotation — distinct accent
  | 'rose'       // Escalated, Critical — urgent
  | 'orange';    // Pending Approval, Warn — between amber and red

export type StatusChipSize = 'sm' | 'md';

const TONE_CLASSES: Record<StatusChipTone, string> = {
  red:     'bg-red-100 text-red-800 border-red-300',
  amber:   'bg-amber-100 text-amber-800 border-amber-300',
  sky:     'bg-sky-100 text-sky-800 border-sky-300',
  emerald: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  slate:   'bg-slate-100 text-slate-700 border-slate-300',
  violet:  'bg-violet-100 text-violet-800 border-violet-300',
  rose:    'bg-rose-100 text-rose-800 border-rose-300',
  orange:  'bg-orange-100 text-orange-800 border-orange-300',
};

const SIZE_CLASSES: Record<StatusChipSize, string> = {
  // sm — sub-status pills (Draft, Link Sent). 10px so two pills can sit
  // next to a 12px primary chip without dominating visually.
  sm: 'text-[10px] font-semibold px-2 py-0.5',
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
        TONE_CLASSES[tone],
        className ?? '',
      ].join(' ')}
      {...rest}
    >
      {children}
    </span>
  );
}

export default StatusChip;
