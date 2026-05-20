'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback, useMemo } from 'react';

/*
 * URL-driven Job action state — shared by /jobs and /my-orders.
 *
 * Why this exists:
 *   Modal actions (View / Confirm & Schedule / Assign / Reassign / Book
 *   New Call) used to be opened via local React state. That meant a
 *   teammate couldn't paste a URL like "here's the confirm-schedule
 *   page for Job 384721" and have the recipient land directly on the
 *   action. By moving the open/close state into the URL we get a
 *   shareable, deep-linkable surface for every row-level action.
 *
 * Canonical schema:
 *   /jobs?jobId=384721&action=view
 *   /jobs?jobId=384721&action=confirm
 *   /jobs?jobId=384721&action=assign
 *   /jobs?jobId=384721&action=reassign
 *   /jobs?action=create                  (no jobId — Book New Call)
 *
 * The same schema applies to /my-orders. Other query params (`tab`,
 * `focus`, etc.) are preserved across pushes — the helpers only touch
 * `jobId` and `action`, so a deep-link like
 *   /my-orders?tab=scheduled&jobId=384721&action=view
 * round-trips cleanly when the modal opens then closes back to the
 * scheduled tab.
 *
 * Backward compatibility:
 *   Existing links still work. `useJobActionParams()` promotes
 *   the legacy `?view=N` to `{ jobId: N, action: 'view' }` and
 *   `?new=1` to `{ action: 'create' }`. The promotion is read-only —
 *   we never write the legacy keys back. Any link that lands with the
 *   old shape will be normalised by the page's next URL push.
 */

export type JobAction = 'create' | 'view' | 'edit' | 'confirm' | 'assign' | 'reassign';

const KNOWN_ACTIONS: ReadonlySet<JobAction> = new Set<JobAction>([
  'create', 'view', 'edit', 'confirm', 'assign', 'reassign',
]);

export interface JobActionParams {
  /** Numeric job id when present; null otherwise (create / no-modal). */
  jobId: number | null;
  /** Selected action token, or null if no modal should be open. */
  action: JobAction | null;
}

/** Reads the canonical schema, with promotion of legacy `?view=` / `?new=1`. */
export function useJobActionParams(): JobActionParams {
  const sp = useSearchParams();
  return useMemo(() => {
    // Canonical schema first.
    const rawAction = sp.get('action');
    const rawJobId  = sp.get('jobId');
    if (rawAction && KNOWN_ACTIONS.has(rawAction as JobAction)) {
      const jobId = rawJobId && /^\d+$/.test(rawJobId) ? Number(rawJobId) : null;
      // `create` is the only action that's valid without a jobId.
      if (rawAction === 'create') return { action: 'create', jobId: null };
      return jobId
        ? { action: rawAction as JobAction, jobId }
        : { action: null, jobId: null };
    }
    // Legacy promotion path — keeps old shareable URLs alive.
    const legacyView = sp.get('view');
    if (legacyView && /^\d+$/.test(legacyView)) {
      return { action: 'view', jobId: Number(legacyView) };
    }
    if (sp.get('new') === '1') return { action: 'create', jobId: null };
    return { action: null, jobId: null };
  }, [sp]);
}

/*
 * Pushers + closer. We use `replace` (not `push`) so the browser's
 * back button doesn't accumulate one entry per row click — that would
 * make "back" feel broken on a list page. The exception is the very
 * first transition from list → modal: that one uses `push` so back
 * actually closes the modal as the user expects.
 */
export function useJobActionNav() {
  const router    = useRouter();
  const pathname  = usePathname();
  const sp        = useSearchParams();

  /** Build the URL with only `jobId` + `action` mutated; other params kept. */
  const buildUrl = useCallback(
    (next: { action: JobAction | null; jobId?: number | null }) => {
      const p = new URLSearchParams(sp);
      // Strip the canonical keys + legacy aliases so the URL never
      // carries both shapes at once.
      p.delete('action');
      p.delete('jobId');
      p.delete('view');
      p.delete('new');
      if (next.action) {
        p.set('action', next.action);
        if (next.jobId != null) p.set('jobId', String(next.jobId));
      }
      const q = p.toString();
      return q ? `${pathname}?${q}` : pathname;
    },
    [pathname, sp],
  );

  const openJobAction = useCallback(
    (action: JobAction, jobId?: number | null) => {
      // First open from a clean URL → push so Back closes the modal.
      // Re-targeting an already-open modal (e.g. view → confirm on
      // the same row) → replace to avoid history pollution.
      const currentAction = sp.get('action') || (sp.get('view') ? 'view' : sp.get('new') === '1' ? 'create' : null);
      const url = buildUrl({ action, jobId: jobId ?? null });
      if (currentAction) router.replace(url, { scroll: false });
      else                router.push(url,    { scroll: false });
    },
    [router, buildUrl, sp],
  );

  const closeJobAction = useCallback(() => {
    const url = buildUrl({ action: null });
    router.replace(url, { scroll: false });
  }, [router, buildUrl]);

  return { openJobAction, closeJobAction };
}
