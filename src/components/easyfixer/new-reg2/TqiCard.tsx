'use client';
/*
 * TQI — Technician Quality Index.
 *
 * Six weighted criteria over the last 12 months of closed jobs, computed by
 * GET /admin/easyfixers/:id/tqi. Each bar carries its own weight, read from the
 * response rather than written here, so the labels cannot drift from the
 * weights that were actually applied.
 *
 * NO SCORE is a real state, distinct from a low one: a technician who has
 * completed nothing in the window has not performed badly, and showing him 0
 * would rank him below someone genuinely struggling.
 */
import { useFetch } from '@/lib/hooks';
import { SectionCard } from './ui';
import type { Tqi } from './types';

/*
 * Bands, not a gradient: a reader needs to know "is this a problem" at a
 * glance, and three states answer that where a continuous ramp does not.
 */
function toneFor(pct: number): string {
  if (pct >= 85) return 'bg-success';
  if (pct >= 60) return 'bg-warning';
  return 'bg-destructive';
}

export function TqiCard({ efrId }: { efrId: number }) {
  const { data, loading, error } = useFetch<Tqi>(`/admin/easyfixers/${efrId}/tqi`);

  return (
    <SectionCard
      title="TQI — Technician Quality Index"
      icon={<span>⭐</span>}
      right={<span>weighted criteria · last 12 months</span>}
    >
      {loading && !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-urgent">Could not load the quality index.</p>
      ) : !data || data.score == null ? (
        <p className="text-sm text-muted-foreground">
          No jobs completed in the last 12 months, so there is nothing to score yet.
        </p>
      ) : (
        <div className="flex flex-col gap-5 md:flex-row md:items-start">
          <div className="shrink-0 md:w-40">
            <div className={`text-4xl font-semibold ${data.score >= 85 ? 'text-success' : data.score >= 60 ? 'text-warning' : 'text-destructive'}`}>
              {data.score}
            </div>
            <div className="text-xs text-muted-foreground">/ 100 · last 12 months</div>
            <div className="mt-1 text-xs text-muted-foreground">
              from {data.jobs} closed job{data.jobs === 1 ? '' : 's'}
            </div>
          </div>

          <div className="flex-1 space-y-2.5">
            {data.criteria.map((c) => (
              <div key={c.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-ink-900">
                    {c.label} <span className="text-muted-foreground">· {c.weight}%</span>
                  </span>
                  <span className="font-mono text-[13px] tabular-nums text-ink-900">
                    {c.percent == null ? '—' : `${c.percent}%`}
                  </span>
                </div>
                <span className="mt-0.5 block h-2 w-full overflow-hidden rounded-full bg-muted">
                  {c.percent != null && (
                    <span
                      className={`block h-full rounded-full ${toneFor(c.percent)}`}
                      style={{ width: `${Math.max(1, Math.min(100, c.percent))}%` }}
                    />
                  )}
                </span>
              </div>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              A criterion with no sample is left out and its weight shared across the rest, so a
              technician is never marked down for a rating his customers did not give.
            </p>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
