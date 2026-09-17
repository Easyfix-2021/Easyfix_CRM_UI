'use client';

import { useEffect, useState } from 'react';
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

export function PtsTimingChip({ requestedDateTime, now }: {
  requestedDateTime: string | null | undefined;
  now: number;
}) {
  const timing = appointmentTiming(requestedDateTime, now);
  if (!timing) {
    return <StatusChip tone="neutral" size="sm">No appointment time</StatusChip>;
  }
  return (
    <StatusChip
      tone={timing.tone}
      size="sm"
      title={`Appointment ${formatDate(String(requestedDateTime))} · Close loop starts 2 hours before, Running late at the appointment time`}
    >
      {timing.label}
    </StatusChip>
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
