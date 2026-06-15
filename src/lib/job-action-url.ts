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

export type JobAction = 'create' | 'view' | 'edit' | 'confirm' | 'assign' | 'reassign' | 'schedule';

const KNOWN_ACTIONS: ReadonlySet<JobAction> = new Set<JobAction>([
  'create', 'view', 'edit', 'confirm', 'assign', 'reassign', 'schedule',
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

  /** Build the URL with only `jobId` + `action` + optional `extras` mutated; other params kept. */
  const buildUrl = useCallback(
    (next: {
      action: JobAction | null;
      jobId?: number | null;
      /*
       * Extra query params layered on top of the canonical action/jobId
       * pair (2026-05-28). Used to deep-link the modal to a specific
       * sub-state — currently `viewTab=<TabValue>` so a list-row pill
       * can land the operator straight on e.g. the Services tab.
       *
       * URL key is `viewTab` deliberately — the bare `tab` key is owned
       * by /jobs + /my-orders for their LIST status-tab selector and
       * collides if reused here. Keys passed with `null` values are
       * deleted so a previous deep-link's viewTab is cleared when the
       * new push doesn't carry one.
       */
      extras?: Record<string, string | null>;
    }) => {
      const p = new URLSearchParams(sp);
      // Strip the canonical keys + legacy aliases so the URL never
      // carries both shapes at once. Also strip `viewTab` so a previous
      // tab-deep-link doesn't leak into the next modal open without
      // an explicit tab pick.
      p.delete('action');
      p.delete('jobId');
      p.delete('view');
      p.delete('new');
      p.delete('viewTab');
      if (next.action) {
        p.set('action', next.action);
        if (next.jobId != null) p.set('jobId', String(next.jobId));
      }
      if (next.extras) {
        for (const [k, v] of Object.entries(next.extras)) {
          if (v == null) p.delete(k);
          else           p.set(k, v);
        }
      }
      const q = p.toString();
      return q ? `${pathname}?${q}` : pathname;
    },
    [pathname, sp],
  );

  const openJobAction = useCallback(
    (
      action: JobAction,
      jobId?: number | null,
      /*
       * Optional sub-state for the action. Today only `tab` is read by
       * the modal's ViewBody — see JobModal.tsx where the list page
       * reads `viewTab` from the URL and threads to <Tabs defaultValue>.
       * The caller still passes `{ tab: 'services' }` here for
       * readability; we map it to the `viewTab` URL key internally to
       * avoid collision with the list's existing `?tab=` selector.
       */
      opts?: { tab?: string },
    ) => {
      // First open from a clean URL → push so Back closes the modal.
      // Re-targeting an already-open modal (e.g. view → confirm on
      // the same row) → replace to avoid history pollution.
      const currentAction = sp.get('action') || (sp.get('view') ? 'view' : sp.get('new') === '1' ? 'create' : null);
      const url = buildUrl({
        action,
        jobId: jobId ?? null,
        extras: opts?.tab ? { viewTab: opts.tab } : undefined,
      });
      if (currentAction) router.replace(url, { scroll: false });
      else                router.push(url,    { scroll: false });
    },
    [router, buildUrl, sp],
  );

  const closeJobAction = useCallback(() => {
    // buildUrl already strips `tab` along with the action/jobId keys
    // so the URL returns to its pre-modal state cleanly.
    const url = buildUrl({ action: null });
    router.replace(url, { scroll: false });
  }, [router, buildUrl]);

  return { openJobAction, closeJobAction };
}
