/*
 * Duration formatters shared by the Call Tracking report's table (page.tsx) and
 * its KPI tiles (CallTrackingCharts.tsx). Both need the SAME rendering of the
 * same seconds values, so they live here rather than being written twice.
 *
 * Built on the canonical `fmtDuration` from '@/lib/format' (the running-clock
 * m:ss formatter used by the live-call panels) — these wrappers only add the
 * two things a REPORT needs that a live timer doesn't:
 *
 *   fmtSecs      null → '—'  ("nothing to measure", not "zero seconds").
 *                A report cell must not render an absent average as 0:00 —
 *                avgDurationSecs is null when no call had a duration recorded,
 *                which is a different fact from "the calls were 0 seconds long".
 *
 *   fmtTalkTime  rolls past an hour into h:mm:ss. Aggregate talk time for a day
 *                or a busy job routinely exceeds 60 minutes, and the shared
 *                formatter would print "125:30" for two hours.
 */

import { fmtDuration } from '@/lib/format';

/** A single call / average duration as m:ss — '—' when there is nothing to show. */
export function fmtSecs(secs: number | null): string {
  return secs == null ? '—' : fmtDuration(secs);
}

/** An AGGREGATE duration (total talk time) as m:ss, or h:mm:ss past an hour. */
export function fmtTalkTime(secs: number | null): string {
  if (secs == null) return '—';
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  if (h === 0) return fmtDuration(s);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
