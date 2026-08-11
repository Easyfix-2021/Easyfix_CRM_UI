'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { EasyfixerLifecycleChip } from '@/components/easyfixer/EasyfixerLifecycleChip';
import {
  crmTransitionTargets,
  LIFECYCLE_GUIDE_GROUPS,
  LIFECYCLE_GUIDE_RULES,
} from '@/lib/easyfixer-lifecycle-guide';
import type { EasyfixerLifecycleStatus } from '@/lib/easyfixer-lifecycle';
import { cn } from '@/lib/utils';

/**
 * An info affordance (the ⓘ icon) that, on click, opens a modal documenting the
 * whole lifecycle transition flow — for every status, what it can move to and
 * why some moves are intentionally not offered. Content is a static reference
 * (see `@/lib/easyfixer-lifecycle-guide`); no data fetch.
 *
 * Designed to sit inside the Change-Lifecycle dialog next to the "New Status"
 * picker, which is exactly where "why are only these options available?" comes
 * up. Pass `currentStatus` to highlight the technician's current state so the
 * operator immediately sees "you are here → these are your options and why".
 *
 * Pass `availableTransitions` (the exact set the New-Status dropdown offers for
 * THIS technician — already filtered for verification, manager mapping and the
 * operator's scheduling permission) to show the technician-specific options on
 * the current-status card, alongside the general rule. Leave it null when the
 * guide is opened read-only (no dropdown in play), and the card shows the
 * general graph only.
 */
export function LifecycleTransitionGuideDialog({
  currentStatus = null,
  availableTransitions = null,
  className,
}: {
  currentStatus?: EasyfixerLifecycleStatus | null;
  availableTransitions?: EasyfixerLifecycleStatus[] | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="View the lifecycle transition guide"
        title="View the lifecycle transition guide"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-help',
          className,
        )}
      >
        <Info className="size-4" />
        <span className="sr-only">View the lifecycle transition guide</span>
      </button>

      {/* eslint-disable-next-line no-restricted-syntax */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          noPadding
          className="sm:max-w-3xl max-h-[92vh] flex flex-col gap-0 overflow-hidden"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>Lifecycle Transition Guide</DialogTitle>
            <DialogDescription>
              How Ops can move a technician between statuses — and why some moves are not offered.
            </DialogDescription>
          </DialogHeader>

          {/* Scrollable body — the only region that scrolls; footer stays put. */}
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-4">
            <section>
              <h3 className="mb-2 text-sm font-semibold">How Transitions Work</h3>
              <ul className="space-y-1.5">
                {LIFECYCLE_GUIDE_RULES.map((rule) => (
                  <li key={rule} className="flex gap-2 text-xs text-slate-700">
                    <span className="mt-1 size-1.5 shrink-0 rounded-full bg-sky-500" aria-hidden />
                    <span>{rule}</span>
                  </li>
                ))}
              </ul>
            </section>

            {LIFECYCLE_GUIDE_GROUPS.map((group) => (
              <section key={group.title} className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">{group.title}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">{group.blurb}</p>
                </div>
                <div className="space-y-2">
                  {group.entries.map((entry) => {
                    const targets = crmTransitionTargets(entry.status);
                    const isCurrent = currentStatus === entry.status;
                    // Only the current technician's card gets the "for this
                    // technician" set, and only when the caller supplied it
                    // (i.e. an actionable dropdown is in play).
                    const showActual = isCurrent && availableTransitions != null;
                    return (
                      <article
                        key={entry.status}
                        className={cn(
                          'rounded-lg border p-3',
                          isCurrent
                            ? 'border-sky-300 bg-sky-50/70 ring-1 ring-sky-200'
                            : 'bg-slate-50/60',
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <EasyfixerLifecycleChip value={entry.status} size="md" />
                          {isCurrent && (
                            <span className="rounded-full bg-sky-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                              Current
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 text-xs text-slate-600">{entry.summary}</p>

                        {showActual && (
                          <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50/70 p-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                              Available For This Technician Now
                            </p>
                            {availableTransitions && availableTransitions.length ? (
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {availableTransitions.map((target) => (
                                  <EasyfixerLifecycleChip key={target} value={target} />
                                ))}
                              </div>
                            ) : (
                              <p className="mt-1 text-xs italic text-emerald-800/80">
                                No status changes are available for this technician right now.
                              </p>
                            )}
                            <p className="mt-1 text-[11px] text-emerald-800/70">
                              Reflects this technician&apos;s verification, manager mapping and your permissions.
                            </p>
                          </div>
                        )}

                        <div className="mt-2">
                          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {showActual ? 'General Rule' : 'Can Move To'}
                          </p>
                          {targets.length ? (
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {targets.map((target) => (
                                <EasyfixerLifecycleChip key={target} value={target} />
                              ))}
                            </div>
                          ) : (
                            <p className="mt-1 text-xs italic text-muted-foreground">
                              No manual CRM changes from this status.
                            </p>
                          )}
                        </div>

                        <div className="mt-2">
                          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            Why
                          </p>
                          <p className="mt-0.5 text-xs text-slate-700">{entry.why}</p>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default LifecycleTransitionGuideDialog;
