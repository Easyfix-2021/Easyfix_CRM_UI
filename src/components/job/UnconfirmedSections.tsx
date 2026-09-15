'use client';

import { useEffect, useRef, useState } from 'react';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { buildJobsKey } from '@/lib/jobs-query';
import { reconcileSectionTotals } from '@/lib/section-totals';
import {
  ReorderableSections,
  SectionFrame,
  type SectionControls,
} from '@/components/ui/reorderable-sections';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { UnconfirmedJobsTable, type UnconfirmedJobRow } from './UnconfirmedJobsTable';
import type { ComponentProps } from 'react';

/*
 * My Orders -> Unconfirmed, split into five independently-paged sections.
 *
 * WHAT CHANGED, AND WHY IT HAD TO. The first cut took the page's current page
 * of rows and grouped them in the browser. That is wrong in a way a screenshot
 * makes obvious: with 84 matching orders the headings read 0 / 0 / 2 / 8 / 0 —
 * they summed to TEN, the page size, not to 84. A section was never showing
 * "the Overdue jobs"; it was showing "the Overdue jobs that happened to fall on
 * page 1", and paging the shared footer reshuffled every heading. Counts that
 * look authoritative and are not are worse than no counts.
 *
 * So each section now runs its OWN query against /admin/jobs with `section=`
 * and its own limit/offset, exactly as PendingToStartView's three appointment
 * buckets do. That buys three things the grouped version could not have:
 *   - `total` is the section's real total, so the chip is the whole book;
 *   - a section can page past what is on screen;
 *   - the page's search box reaches every section and every page, because `q`
 *     goes to the server rather than filtering an already-truncated array.
 *
 * MEMBERSHIP IS STILL THE SERVER'S. The predicate lives in
 * client-request.service.js (sectionPredicate) beside the JS classifier it
 * mirrors, and check:sections compares the two over the real book.
 *
 * ORDER, COLLAPSE, DRAG, KEYBOARD AND THE SLIDE ARE NOT HERE ANY MORE. They
 * were built and debugged on this page, then lifted into
 * <ReorderableSections>/<SectionFrame> (components/ui/reorderable-sections.tsx)
 * so Pending to Start could have the SAME interaction rather than a lookalike.
 * For a while both files carried it; this one now renders through the shared
 * component, which is the only copy. The reasoning for each piece is written up
 * there. What stays here is what is Unconfirmed's own: the two localStorage
 * keys, the per-section fetch, the count-only fetch for a shut section, the
 * per-section footer, and the totals reconciliation.
 */

// `/admin/jobs` Joi caps limit at 500, so "All" must send 500 and not the
// helper's 1000 default (which 400s). Same value as /my-orders and /jobs.
const JOBS_MAX_LIMIT = 500;

const ORDER_KEY = 'easyfix.crm.unconfirmed.sectionOrder.v1';
/*
 * Collapsed state, stored SEPARATELY from the order. One combined blob would
 * mean a change to either shape invalidates both, and an operator who had
 * carefully arranged their order would lose it to a change in how collapse is
 * remembered.
 *
 * What is stored is the operator's EXPLICIT choices only — a map of
 * key -> collapsed. A section with no entry is on AUTO: open if it has jobs,
 * shut if it does not (the rule is applied below, in SectionCard). That is the
 * difference between "the operator closed this" and "there is nothing in it",
 * and only the first should survive the day a section fills up.
 *
 * v1 stored a bare ARRAY of collapsed keys, which could not express that
 * distinction. The shared component still reads and converts that shape rather
 * than discarding it, so nobody's arrangement resets on deploy.
 */
const COLLAPSED_KEY = 'easyfix.crm.unconfirmed.sectionCollapsed.v1';

type Section = { key: string; label: string };
type MetaResp = { meta: Section[] };
type Resp = { items: UnconfirmedJobRow[]; total: number; limit: number; offset: number };
type TableProps = ComponentProps<typeof UnconfirmedJobsTable>;
/*
 * The tab's request shape, built ONCE by the page (status pin, owner scope,
 * search, sort) and extended here with `section` + this section's page window.
 * Passing the whole object rather than named props means a filter the page adds
 * later reaches all five sections without touching this file.
 */
type JobsQuery = Record<string, string | number | undefined>;

export function UnconfirmedSections({
  query,
  pageTotal,
  onMagicLinkSent,
  ...tableProps
}: Omit<TableProps, 'rows' | 'loading'> & { query: JobsQuery; pageTotal: number | null }) {
  /*
   * The section LIST comes from the server so a sixth section is a backend
   * change, not a frontend deploy. Sent without `ids`, which the endpoint
   * answers from SECTION_META alone — no query, no rows.
   */
  const metaReq = useFetch<MetaResp>('/admin/jobs/unconfirmed-sections');
  const meta = metaReq.data?.meta;

  // Each section reports its own total up so they can be added together.
  const [totals, setTotals] = useState<Record<string, number>>({});

  /*
   * Post-mutation refresh signal.
   *
   * ⚠ invalidateFetch ALONE DOES NOT REFRESH A MOUNTED SECTION, which is the
   * trap this exists to close. It evicts the module-level cache and notifies
   * `invalidationListeners` — but only useFetchOnce subscribes to those.
   * useFetch re-runs on `[key, enabled, tick]`, and an eviction changes
   * neither: the key is a pure function of the query, so after a magic-link
   * send or a reschedule it is byte-identical and the effect never re-runs.
   * Eviction only helps a LATER mount, and these sections never unmount.
   *
   * Before this component fetched its own rows, the page's own reload was
   * enough — the rows on screen were the page's rows. Now they are not, so
   * without this bump the "Link Sent" pill never appears (inviting a duplicate
   * send) and a rescheduled job keeps its old date and stays in the wrong
   * section until the operator changes page, search, sort or tab.
   *
   * PendingToStartView solves it exactly this way; see its bumpReload().
   */
  const [reloadKey, setReloadKey] = useState(0);
  function handleMutation() {
    invalidateFetch((k) => k.startsWith('/admin/jobs'));
    setReloadKey((k) => k + 1);
    // Still tell the page: its own query feeds the "N matching orders" header,
    // and a mutation can change that count.
    onMagicLinkSent?.();
  }

  // Reported by each section as its count arrives. Guarded so a repeat of the
  // same number is not a state write, which would re-render on every refetch.
  function reportTotal(key: string, total: number) {
    setTotals((prev) => (prev[key] === total ? prev : { ...prev, [key]: total }));
  }

  /*
   * THE ARITHMETIC THAT CATCHES WHAT NO SINGLE SECTION CAN. Both times this
   * page has been wrong, every section looked individually plausible and the
   * headings simply did not add up to the tab total. See lib/section-totals.ts.
   * Read off `meta`, not the displayed order — the sum is the same set either
   * way, and the order now lives inside <ReorderableSections>.
   */
  const reconciliation = reconcileSectionTotals({
    totals: (meta ?? []).map((sec) => (sec.key in totals ? totals[sec.key] : null)),
    pageTotal,
  });

  if (metaReq.error) {
    return (
      <div className="px-4 py-3 text-xs text-warning-strong bg-warning-tint">
        The section list could not be loaded, so Unconfirmed orders cannot be grouped.
        Reload the page to try again.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/*
        * Said out loud, on the page, rather than logged. Both times these
        * sections have been wrong the screen looked entirely reasonable — the
        * only tell was that the headings did not sum to the tab total.
        */}
      {reconciliation.status === 'mismatch' && (
        <div
          role="status"
          className="mx-3 mt-3 rounded-lg border border-warning bg-warning-tint px-3 py-2 text-xs text-warning-strong"
        >
          <strong className="font-semibold">These groupings are not trustworthy.</strong>{' '}
          {reconciliation.message}
        </div>
      )}

      {/* px-3 pt-3: the inset each card used to carry as mx-3, plus the gap
          that keeps the first card off the toolbar above it. Each card still
          carries its own mb-3, so the last supplies the bottom gap. */}
      <ReorderableSections
        sections={meta}
        orderKey={ORDER_KEY}
        collapsedKey={COLLAPSED_KEY}
        className="px-3 pt-3"
      >
        {(s, controls) => (
          <SectionCard
            section={s}
            controls={controls}
            query={query}
            onTotal={(t) => reportTotal(s.key, t)}
            reloadKey={reloadKey}
            onMagicLinkSent={handleMutation}
            tableProps={tableProps}
          />
        )}
      </ReorderableSections>
    </div>
  );
}

/*
 * One section: its own page window, its own query, its own footer, inside the
 * shared frame.
 *
 * Split into a component because each section needs independent `page` /
 * `pageSize` state, and hooks cannot be called in a loop inside the parent.
 * Same reason PendingToStartView has a per-bucket component.
 */
function SectionCard({
  section, controls, query, onTotal, reloadKey, onMagicLinkSent, tableProps,
}: {
  section: Section;
  controls: SectionControls;
  query: JobsQuery;
  onTotal: (total: number) => void;
  reloadKey: number;
  onMagicLinkSent?: TableProps['onMagicLinkSent'];
  tableProps: Omit<TableProps, 'rows' | 'loading' | 'onMagicLinkSent'>;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  const limit = pageSizeToLimit(pageSize, JOBS_MAX_LIMIT);

  /*
   * A COLLAPSED section still needs its count — that is most of the point of
   * collapsing one — but not its rows. limit=1 fetches the `total` the chip
   * shows without pulling a page of records nothing will render. Expanding
   * changes the key, so the real page is fetched then.
   *
   * Only an EXPLICITLY shut section fetches count-only. A section on auto has
   * to fetch its rows regardless — it cannot know whether to open until the
   * count arrives, and fetching 1 row now and 10 a moment later would double
   * the requests and flash the table in.
   */
  const countOnly = controls.explicitCollapsed === true;
  const key = buildJobsKey({
    ...query,
    section: section.key,
    limit: countOnly ? 1 : limit,
    offset: countOnly ? 0 : page * limit,
  });
  const { data, loading, refetch } = useFetch<Resp>(key);

  /*
   * A filter or search change makes the current page number meaningless — page
   * 4 of a 60-row section is empty once a search narrows it to 8. Reset to the
   * first page, but NOT on the initial render, which would fight the mount.
   * Keyed on a serialised copy because `query` is a fresh object every render.
   */
  const queryKey = JSON.stringify(query);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setPage(0);
  }, [queryKey]);

  // Refetch when the parent signals a mutation. Skips the initial render,
  // which the key-driven fetch above already covers.
  const firstReload = useRef(true);
  useEffect(() => {
    if (firstReload.current) { firstReload.current = false; return; }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  // Report upward so the parent can add the sections together.
  useEffect(() => {
    if (data) onTotal(data.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  /*
   * AUTO: open when it has jobs, shut when it does not — an operator scanning
   * five headings should not have to open three empty ones to learn they are
   * empty. An explicit click wins forever after (the shared component pins it).
   * While the count is unknown it stays OPEN, so the table never flashes shut.
   * An em dash rather than a count until then: a 0 that means "not loaded yet"
   * is indistinguishable from a 0 that means "empty".
   */
  return (
    <SectionFrame
      label={section.label}
      count={data ? total : null}
      collapsed={controls.explicitCollapsed ?? (data ? total === 0 : false)}
      controls={controls}
    >
      <div className="overflow-x-auto">
        <UnconfirmedJobsTable
          rows={rows}
          loading={loading}
          onMagicLinkSent={onMagicLinkSent}
          {...tableProps}
        />
      </div>
      {/* Its own footer, over its own total — the whole point of the change.
          Rendered only once a response has arrived so it never shows "1 / 0"
          against an unknown total. */}
      {data && total > 0 && (
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
        />
      )}
    </SectionFrame>
  );
}
