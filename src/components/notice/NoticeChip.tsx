'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/*
 * NoticeChip — a single coloured tag rendering a notice's category +
 * (optionally) its title. Shared between the dashboard strip, the
 * All-Notices table, and the Compose preview card.
 *
 * The category color is set as the chip background tint at low opacity
 * with a darker text — same shape as the spec wireframe (INCENTIVE
 * WEATHER POLICY UPDATE). We accept the colour as a hex string from
 * the BE so a newly-added category renders correctly without any code
 * change here.
 */

export function NoticeCategoryTag({
  name,
  color,
  className,
}: {
  name: string;
  color: string;
  className?: string;
}) {
  // We pass the hex through inline style because Tailwind can't tint
  // by arbitrary runtime colours without a generated config. The tag
  // uses ~15% colour for the background + the raw colour for text +
  // border, which keeps it legible across every hex in the seed.
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : 'hsl(var(--neutral))';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap',
        className,
      )}
      style={{
        color: safeColor,
        backgroundColor: `${safeColor}22`,         // 22 ≈ 13% alpha in hex
        border: `1px solid ${safeColor}55`,
      }}
    >
      {name}
    </span>
  );
}

/* Wider chip showing the category tag + the notice title, used in the
 * dashboard strip's expanded view and in detail modals. */
export function NoticeTitleChip({
  categoryName,
  categoryColor,
  title,
  unread = false,
  onClick,
  className,
}: {
  categoryName: string;
  categoryColor: string;
  title: string;
  unread?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left transition-colors hover:bg-muted',
        'min-w-0 max-w-md',
        className,
      )}
    >
      <NoticeCategoryTag name={categoryName} color={categoryColor} />
      <span className="text-[13px] font-medium truncate">{title}</span>
      {unread && (
        <span
          aria-label="Unread"
          className="ml-auto inline-block h-2 w-2 rounded-full bg-info shrink-0"
        />
      )}
    </button>
  );
}
