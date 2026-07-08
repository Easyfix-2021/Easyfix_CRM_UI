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
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-lg shadow-xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <div className="bg-slate-900 text-white px-5 py-3 flex items-center justify-between rounded-t-2xl sm:rounded-t-lg">
          <h2 className="font-semibold text-base">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy}
            className="text-slate-300 hover:text-white disabled:opacity-50" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}
