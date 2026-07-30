'use client';

/*
 * JobRefLink — a Job # cell that opens the Job workspace, on any page, without
 * hand-rolling the /jobs URL.
 *
 * The problem it solves: reports linked a Job # with
 *   <Link href={`/jobs?jobId=${id}&action=view`}>
 * which NAVIGATES to Manage Jobs. Closing the modal there left the operator on
 * /jobs — not the report they came from — because the shared close helper
 * (useJobActionNav.closeJobAction) is pathname-relative. Each report also
 * re-hand-wrote the `/jobs?jobId=&action=` schema.
 *
 * Two usage shapes, both centralising that schema here:
 *
 *   IN PLACE (default) — opens the modal OVER the current page; closing returns
 *   here. Requires a <JobModalHost/> (separate module) mounted once on the page:
 *
 *     <JobRefLink jobId={j.jobId} />        // in a cell
 *     <JobModalHost />                       // once on the page
 *
 *   NEW TAB — `newTab` renders a plain external link to /jobs (no host, no
 *   JobModal in this page's bundle — see the deliberate split below). Use when a
 *   drill-down lists many jobs and the operator wants to keep the list open
 *   while inspecting several:
 *
 *     <JobRefLink jobId={j.jobId} newTab>…</JobRefLink>
 *
 * Link inside a child dialog (in-place mode)? Pass `beforeOpen={closeThatDialog}`
 * so the dialog closes first — one modal at a time.
 *
 * ⚠ This module deliberately does NOT import JobModal. JobModal is heavy
 * (~200 kB); only <JobModalHost> (its own module) pulls it in, so a report that
 * only needs `newTab` links doesn't bundle a modal it never renders. Keep it
 * that way.
 *
 * Built 2026-07-30, generalising the inline fix first shipped on Offer Acceptance.
 */

import type { ReactNode } from 'react';

import { useJobActionNav, type JobAction } from '@/lib/job-action-url';

/** The canonical deep-link URL for a job action — the ONE place this schema lives. */
export function jobActionHref(jobId: number, action: JobAction = 'view'): string {
  return `/jobs?jobId=${jobId}&action=${action}`;
}

export function JobRefLink({
  jobId, action = 'view', children, className, beforeOpen, newTab = false,
}: {
  jobId: number;
  /** JobModal action to open (default 'view'). */
  action?: JobAction;
  children?: ReactNode;
  className?: string;
  /** In-place mode only: runs before opening — e.g. close a parent drill dialog. */
  beforeOpen?: () => void;
  /** Open /jobs in a new browser tab instead of the in-place host. */
  newTab?: boolean;
}) {
  // Hook is called unconditionally (rules of hooks); unused in the newTab branch.
  const { openJobAction } = useJobActionNav();
  const cls = className ?? 'text-sky-700 hover:underline';

  if (newTab) {
    return (
      <a href={jobActionHref(jobId, action)} target="_blank" rel="noreferrer" className={cls}>
        {children ?? `#${jobId}`}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => { beforeOpen?.(); openJobAction(action, jobId); }}
      className={cls}
    >
      {children ?? `#${jobId}`}
    </button>
  );
}
