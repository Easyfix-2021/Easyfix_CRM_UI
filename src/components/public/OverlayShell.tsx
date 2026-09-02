'use client';

import * as React from 'react';
import { X } from 'lucide-react';

/*
 * Shared overlay shell for the public-page dialogs. Plain fixed overlay +
 * responsive card — deliberately NOT the CRM `Dialog` (which would drag in
 * auth-coupled shared code). Bottom-sheet on mobile (full-width, rounded top),
 * centered max-w-md card on desktop; click-outside to dismiss. Shared by
 * job-completion and shared-job.
 */
export function OverlayShell({
  title, onClose, busy, children,
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="bg-card w-full sm:max-w-md rounded-t-2xl sm:rounded-lg shadow-xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        {/*
         * (a) STABLE SURFACE — commit 497cd6e's DialogHeader substitution.
         * These public pages don't use the CRM `Dialog` (see the note above),
         * so this band never picked the shared fix up.
         *
         * `--ink-900` is a text-ramp token and INVERTS, which is right for
         * text and wrong for a plate under a fixed `text-white`:
         *
         *   light  --ink-900  rgb(23,27,31)     17.31:1 vs white ✓
         *   dark   --ink-900  rgb(244,246,247)   1.08:1 vs white ✗
         *
         * `--sidebar` is STABLE and is `210 14.81% 10.59%` in BOTH themes —
         * bit-identical to light `--ink-900` — so the LIGHT theme renders
         * IDENTICALLY and dark goes 1.08 → 17.31:1.
         *
         * The close button has to move with the band. `--ink-300` INVERTS
         * (63.33% → 39.02%) and was legible in dark only because the band
         * behind it was near-white; pinning the band dark in both themes
         * would take it to 2.82:1. `--sidebar-foreground` is STABLE at
         * `212 8.02% 63.33%` — bit-identical to light `--ink-300` — so the
         * icon holds 6.63:1 on the band in BOTH themes and, again, light is
         * unchanged. `hover:text-white` is now on a stable dark plate, so it
         * stays as-is.
         */}
        <div className="bg-sidebar text-white px-5 py-3 flex items-center justify-between rounded-t-2xl sm:rounded-t-lg">
          <h2 className="font-semibold text-base">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy}
            className="text-sidebar-foreground hover:text-white disabled:opacity-50" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}
