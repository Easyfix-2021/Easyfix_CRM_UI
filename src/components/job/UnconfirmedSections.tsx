'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { GripVertical, ChevronDown, ChevronRight } from 'lucide-react';
import { useFetch } from '@/lib/hooks';
import { StatusChip } from '@/components/ui/StatusChip';
import { UnconfirmedJobsTable } from './UnconfirmedJobsTable';
import type { ComponentProps } from 'react';

/*
 * My Orders -> Unconfirmed, split into five sections on one page.
 *
 * WHAT THIS IS NOT. It is not a rewrite of UnconfirmedJobsTable — that table
 * still owns every column, every sort header and every row action. This groups
 * the rows it is given and renders ONE table per section, so the twelve columns
 * and the Confirm gating have exactly one definition and cannot drift between
 * sections.
 *
 * MEMBERSHIP IS THE SERVER'S ANSWER, NOT THIS FILE'S. A job's section depends
 * on tbl_job_comment rows the browser never sees (a client request, an
 * unreachable outcome), so GET /admin/jobs/unconfirmed-sections classifies and
 * this renders. Re-deriving it here from `requested_date_time` alone would put
 * a job the client has actioned into a date bucket — the exact overlap ops
 * asked us to prevent.
 *
 * ORDER IS THE OPERATOR'S, and it lives in localStorage: a per-viewer display
 * preference, wanted on the next visit, never needed by the server and never
 * worth a column. Reads are wrapped because localStorage THROWS in a private
 * window and in browsers with site data blocked — an unguarded read there takes
 * the whole page down to fix the order of some headings.
 */

const ORDER_KEY = 'easyfix.crm.unconfirmed.sectionOrder.v1';
/*
 * Collapsed state, stored SEPARATELY from the order.
 *
 * One combined blob would mean a future change to either shape invalidates
 * both, and an operator who had carefully arranged their order would lose it to
 * a change in how collapse is remembered. Two keys, two independent lifetimes.
 *
 * The stored value is the COLLAPSED set, not the expanded one, because
 * everything is expanded by default: an absent key, a corrupt value and a
 * first-ever visit then all mean the same correct thing without special-casing.
 * Storing "expanded" would make a new section arrive collapsed and invisible.
 */
const COLLAPSED_KEY = 'easyfix.crm.unconfirmed.sectionCollapsed.v1';

type Section = { key: string; label: string };
type SectionsResp = { sections: Record<string, string>; meta: Section[]; today?: string };
type TableProps = ComponentProps<typeof UnconfirmedJobsTable>;

/*
 * Reconcile a saved order against the sections that actually exist.
 *
 * Not `stored ?? server` — a saved array is a snapshot of the sections that
 * existed the day it was saved. Trusting it wholesale means a section added
 * later never renders (it is in neither the saved list nor anything that
 * appends it), and a section removed later leaves an empty heading forever.
 * Both failures are silent, and the first one hides a whole bucket of jobs.
 *
 * So: keep the saved order for what still exists, drop what does not, and
 * APPEND anything new at the end where it is visible rather than dropping it.
 */
function reconcile(stored: unknown, meta: Section[]): Section[] {
  const known = new Map(meta.map((m) => [m.key, m]));
  const seen = new Set<string>();
  const out: Section[] = [];
  if (Array.isArray(stored)) {
    for (const k of stored) {
      const m = typeof k === 'string' ? known.get(k) : undefined;
      if (m && !seen.has(m.key)) { out.push(m); seen.add(m.key); }
    }
  }
  for (const m of meta) if (!seen.has(m.key)) out.push(m);
  return out;
}

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : []);
  } catch {
    // Private window, blocked site data, corrupt JSON — all expanded, which is
    // the documented default and a correct page.
    return new Set();
  }
}

function loadOrder(meta: Section[]): Section[] {
  try {
    const raw = window.localStorage.getItem(ORDER_KEY);
    return reconcile(raw ? JSON.parse(raw) : null, meta);
  } catch {
    // Private window, blocked site data, or corrupt JSON. The default order is
    // a correct page; a thrown error is not.
    return meta;
  }
}

export function UnconfirmedSections({
  rows, ...tableProps
}: TableProps) {
  /*
   * Classify only the ids on screen. The endpoint caps at 1000 and this page
   * pages well below that, so one call covers a page — and it is keyed on the
   * id list, so paging or filtering refetches while sorting the same rows does
   * not.
   */
  const ids = useMemo(
    () => (rows || []).map((r) => r.job_id).filter(Boolean).join(','),
    [rows],
  );
  const cls = useFetch<SectionsResp>(ids ? `/admin/jobs/unconfirmed-sections?ids=${ids}` : null);

  const meta = cls.data?.meta ?? [];
  const [order, setOrder] = useState<Section[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const dragKey = useRef<string | null>(null);

  // Read once on mount — localStorage is only available in the browser, and
  // reading it during render would differ between the server pass and the
  // client one.
  useEffect(() => { setCollapsed(loadCollapsed()); }, []);

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Applies for this visit; just will not survive a reload.
      }
      return next;
    });
  }

  // Seeded once the server has told us which sections exist, then owned here.
  useEffect(() => {
    if (meta.length) setOrder((prev) => (prev.length ? reconcile(prev.map((s) => s.key), meta) : loadOrder(meta)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cls.data?.meta]);

  function persist(next: Section[]) {
    setOrder(next);
    try {
      window.localStorage.setItem(ORDER_KEY, JSON.stringify(next.map((s) => s.key)));
    } catch {
      // Order still applies for this visit; it just will not survive a reload.
      // Losing a preference is not worth failing the interaction over.
    }
  }

  function dropOn(targetKey: string) {
    const from = dragKey.current;
    dragKey.current = null;
    if (!from || from === targetKey) return;
    const next = order.filter((s) => s.key !== from);
    const moved = order.find((s) => s.key === from);
    const at = next.findIndex((s) => s.key === targetKey);
    if (!moved || at < 0) return;
    next.splice(at, 0, moved);
    persist(next);
  }

  const bySection = useMemo(() => {
    const map = new Map<string, TableProps['rows']>();
    const assign = cls.data?.sections || {};
    for (const r of rows || []) {
      /*
       * A row the classifier has not answered for yet (still loading, or an id
       * the response missed) is held back rather than defaulted into a section.
       * Defaulting would silently file a client-actioned job under a date, and
       * the operator would have no way to tell that from the truth.
       */
      const key = assign[String(r.job_id)];
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return map;
  }, [rows, cls.data?.sections]);

  const unclassified = (rows || []).length - [...bySection.values()].reduce((n, v) => n + v.length, 0);

  return (
    // pt-3 so the first card is not flush against the toolbar above it; the
    // cards carry their own mb-3, so the last one supplies the bottom gap.
    <div className="flex flex-col pt-3">
      {cls.error && (
        <div className="px-4 py-2 text-xs text-warning-strong bg-warning-tint border-b border-ink-100">
          Sections could not be loaded, so the list below is ungrouped. Every job is still shown.
        </div>
      )}

      {/* Ungrouped fallback — a failed classify must never HIDE jobs. */}
      {cls.error ? (
        <UnconfirmedJobsTable rows={rows} {...tableProps} />
      ) : (
        order.map((s) => {
          const list = bySection.get(s.key) || [];
          return (
            <section
              key={s.key}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dropOn(s.key)}
              /* A card per section rather than rows separated by a hairline.
                 With a single border the five sections read as one long table
                 with headings in it — which is what the first cut looked like
                 and why this changed. */
              className="mx-3 mb-3 rounded-lg border border-ink-100 overflow-hidden bg-surface"
            >
              <header
                draggable
                onDragStart={() => { dragKey.current = s.key; }}
                onDragEnd={() => { dragKey.current = null; }}
                className="flex items-center gap-2 px-3 py-2 bg-surface-alt select-none"
              >
                {/* The GRIP is the drag handle, and only the grip. Making the
                    whole header draggable meant a click that moved a pixel
                    started a drag instead of toggling — the two gestures were
                    fighting for the same target. */}
                <span
                  className="cursor-grab active:cursor-grabbing text-ink-300 hover:text-ink-500"
                  title="Drag to reorder this section"
                  aria-hidden
                >
                  <GripVertical className="w-4 h-4" />
                </span>
                <button
                  type="button"
                  onClick={() => toggle(s.key)}
                  aria-expanded={!collapsed.has(s.key)}
                  className="flex items-center gap-1.5 flex-1 text-left"
                  title={collapsed.has(s.key) ? 'Expand' : 'Collapse'}
                >
                  {collapsed.has(s.key)
                    ? <ChevronRight className="w-4 h-4 text-ink-500" aria-hidden />
                    : <ChevronDown className="w-4 h-4 text-ink-500" aria-hidden />}
                  <span className="text-sm font-semibold text-ink-900">{s.label}</span>
                  <StatusChip tone="info" size="sm">{String(list.length)}</StatusChip>
                </button>
              </header>
              {collapsed.has(s.key) ? null : list.length ? (
                <div className="overflow-x-auto">
                  <UnconfirmedJobsTable rows={list} {...tableProps} />
                </div>
              ) : (
                /*
                 * Empty sections keep their heading. Hiding them would save a
                 * line and cost two things: the operator cannot tell "no jobs
                 * here" from "this section is gone", and the drag target
                 * disappears, so an empty section can never be moved back into
                 * the position someone wants it in.
                 */
                <p className="px-4 py-3 text-xs text-ink-500">No jobs in this section.</p>
              )}
            </section>
          );
        })
      )}

      {!cls.error && unclassified > 0 && (
        <p className="px-4 py-2 text-xs text-ink-500">
          {cls.loading
            ? `Grouping ${unclassified} more job${unclassified === 1 ? '' : 's'}…`
            : `${unclassified} job${unclassified === 1 ? '' : 's'} could not be grouped and are not shown above.`}
        </p>
      )}
    </div>
  );
}
