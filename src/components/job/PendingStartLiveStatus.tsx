'use client';

import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { StatusChip } from '@/components/ui/StatusChip';
import { formatDate } from '@/lib/utils';
import {
  PTS_STATUS, ptsStateOf, appointmentTiming, type PtsStatusJob,
} from '@/lib/pending-start-status';

/*
 * The Pending to Start status pair — WHAT is waiting (status chip) and HOW
 * CLOSE the appointment is (timing chip) — rendered one way for the My Orders
 * row and the job console. The rule lives in lib/pending-start-status.ts.
 */

/** Current time, refreshed every minute, so timing chips move without a reload. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/*
 * TIMING IS NOT A PILL. The status above it is ("Slot missed"), and when both
 * were red pills a missed slot read as two copies of one label. Timing is a
 * reading, not a state, so it renders as a clock and coloured text — the same
 * colour meaning (red late, amber close loop, green on track), a different
 * shape, so the two can never be mistaken for each other.
 */
const TIMING_TEXT = {
  urgent: 'text-urgent-strong',
  warning: 'text-warning-strong',
  success: 'text-success-strong',
  info: 'text-info-strong',
  neutral: 'text-muted-foreground',
} as const;

export function PtsTimingChip({ requestedDateTime, now }: {
  requestedDateTime: string | null | undefined;
  now: number;
}) {
  const timing = appointmentTiming(requestedDateTime, now);
  const tone = timing?.tone ?? 'neutral';
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium ${TIMING_TEXT[tone]}`}
      title={timing
        ? `Appointment ${formatDate(String(requestedDateTime))} · Close loop starts 2 hours before, Running late at the appointment time`
        : 'This job has no appointment time'}
    >
      <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {timing ? timing.label : 'No appointment time'}
    </span>
  );
}

export function PendingStartLiveStatus({ job, now, className }: {
  job: PtsStatusJob;
  now: number;
  className?: string;
}) {
  const status = PTS_STATUS[ptsStateOf(job)];
  return (
    <span className={`inline-flex flex-col items-start gap-1 ${className ?? ''}`}>
      <StatusChip tone={status.tone}>{status.label}</StatusChip>
      <PtsTimingChip requestedDateTime={job.requested_date_time} now={now} />
    </span>
  );
}
