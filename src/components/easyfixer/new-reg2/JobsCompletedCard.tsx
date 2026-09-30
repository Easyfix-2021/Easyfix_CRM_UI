'use client';
/*
 * Jobs completed IN THE LAST 12 MONTHS, split by service category or vertical.
 *
 * The window is what makes the card readable: across the last year not one
 * completed job is missing a category or a vertical, and none sits in a
 * retired category — so every bar is a real, current thing. Lifetime, those
 * three cases account for tens of thousands of rows the reader cannot act on.
 * The lifetime total keeps its own tile at the top of this tab.
 *
 * WHAT IT COUNTS. Completed jobs that carry a transaction row — the same set
 * the earnings tile sums, so the two can be read against each other. The
 * backend returns both breakdowns and the total in ONE call
 * (GET /admin/easyfixers/:id/job-category-summary), so switching Category ⇄
 * Vertical is instant and never refetches.
 *
 * THE TOTAL IS THE SUM OF THE BARS, not a separately counted number, so the
 * card cannot contradict itself.
 *
 * RETIRED CATEGORIES are hidden behind a reveal rather than dropped. 16 of the
 * 21 categories are retired and 2,212 completed jobs sit in them — jobs the
 * technician did and was paid for. Dropping them would make the bars disagree
 * with earnings for no stated reason. The same reveal holds jobs completed
 * before 2021, when no category was recorded at all.
 */
import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { SectionCard } from './ui';

type CategoryRow = {
  category_id: number | null;
  category_name: string | null;
  is_active: boolean;
  jobs: number;
};
type VerticalRow = { vertical_id: number | null; vertical_name: string | null; jobs: number };
type Summary = {
  window_months: number;
  total_completed: number;
  by_category: CategoryRow[];
  by_vertical: VerticalRow[];
};

type Mode = 'category' | 'vertical';

function Bars({ rows }: { rows: Array<{ key: string; label: string; jobs: number; muted?: boolean }> }) {
  // Scale against the largest bar SHOWN, so revealing retired categories does
  // not silently rescale the ones already on screen.
  const max = Math.max(...rows.map((r) => r.jobs), 1);
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-3">
          <span className={`w-44 shrink-0 text-[13px] ${r.muted ? 'text-muted-foreground' : 'font-medium text-ink-900'}`}>
            {r.label}
          </span>
          <span className="h-4 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className={`block h-full rounded-full ${r.muted ? 'bg-ink-300' : 'bg-primary'}`}
              style={{ width: `${Math.max(2, Math.round((r.jobs / max) * 100))}%` }}
            />
          </span>
          <span className="w-12 shrink-0 text-right font-mono text-[13px] tabular-nums text-ink-900">{r.jobs}</span>
        </div>
      ))}
    </div>
  );
}

export function JobsCompletedCard({ efrId }: { efrId: number }) {
  const { data, loading, error } = useFetch<Summary>(`/admin/easyfixers/${efrId}/job-category-summary`);
  const [mode, setMode] = useState<Mode>('category');
  const [showRetired, setShowRetired] = useState(false);

  const categories = useMemo(() => data?.by_category ?? [], [data]);
  const activeRows = categories.filter((c) => c.is_active);
  const retiredRows = categories.filter((c) => !c.is_active);
  const retiredJobs = retiredRows.reduce((n, c) => n + c.jobs, 0);

  const rows = mode === 'vertical'
    ? (data?.by_vertical ?? []).map((v) => ({
      key: `v${v.vertical_id ?? 'none'}`,
      label: v.vertical_name ?? 'No vertical',
      jobs: v.jobs,
      muted: v.vertical_name == null,
    }))
    : [
      ...activeRows.map((c) => ({
        key: `c${c.category_id}`,
        label: c.category_name ?? `Category ${c.category_id}`,
        jobs: c.jobs,
      })),
      ...(showRetired
        ? retiredRows.map((c) => ({
          key: `c${c.category_id ?? 'none'}`,
          // category_id 0/null is the pre-2021 sentinel — those jobs predate
          // categories entirely, which is a different thing from "retired".
          label: c.category_name ?? 'Before categories were recorded',
          jobs: c.jobs,
          muted: true,
        }))
        : []),
    ];

  const shown = rows.reduce((n, r) => n + r.jobs, 0);
  const total = data?.total_completed ?? 0;

  return (
    <SectionCard
      title={`Jobs completed · last ${data?.window_months ?? 12} months`}
      icon={<span>🧩</span>}
      right={
        <span className="inline-flex overflow-hidden rounded-lg border">
          {(['category', 'vertical'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1 text-xs capitalize ${
                // --sidebar, not --ink-900: ink-900 INVERTS between themes
                // (10.6% lightness light, 96.3% dark) so white text on it
                // collapses in one of the two. --sidebar holds one value.
                mode === m ? 'bg-sidebar text-white' : 'bg-card text-muted-foreground hover:text-foreground'
              }`}
            >
              {m}
            </button>
          ))}
        </span>
      }
    >
      {loading && !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-urgent">Could not load the job breakdown.</p>
      ) : total === 0 ? (
        <p className="text-sm text-muted-foreground">No jobs completed in the last 12 months.</p>
      ) : (
        <>
          <Bars rows={rows} />

          <div className="mt-3 flex items-center justify-between border-t pt-2.5">
            <span className="text-sm text-muted-foreground">Total completed · last 12 months</span>
            <span className="font-mono text-base font-semibold tabular-nums text-ink-900">{total}</span>
          </div>

          {mode === 'category' && retiredJobs > 0 && (
            <button
              type="button"
              onClick={() => setShowRetired((v) => !v)}
              className="mt-2 text-xs text-primary hover:underline"
            >
              {showRetired
                ? 'Hide retired categories'
                : `Show ${retiredJobs} more job${retiredJobs === 1 ? '' : 's'} in retired categories`}
            </button>
          )}
          {mode === 'category' && !showRetired && shown !== total && (
            <p className="mt-1 text-xs text-muted-foreground">
              The bars above show {shown} of {total}; the rest sit in categories no longer offered.
            </p>
          )}
        </>
      )}
    </SectionCard>
  );
}
