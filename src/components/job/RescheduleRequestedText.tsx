'use client';

import { formatDate } from '@/lib/utils';
import { displaySlot } from '@/lib/job-slots';
import type { AppRequest } from '@/lib/job-app-request';

/*
 * "08 Jul 2026, 10:30 am · 9AM to 12PM · Reason: Customer Busy" — the
 * technician's reschedule ask as BOTH schedule blocks print it (JobModal's
 * Timeline, and JobContextPanel's row in Reassign Technician). displaySlot with
 * no stored slot derives the band from the asked-for hour; formatDate reads the
 * zone-less value as IST, so there is no conversion to double up.
 */
export function RescheduleRequestedText({ request }: { request: AppRequest }) {
  const at = request.requestedFor ?? '';
  const slot = displaySlot(at, null);
  return (
    <>
      {formatDate(at)}
      {slot && <> · {slot}</>}
      {request.reason && <> · Reason: {request.reason}</>}
    </>
  );
}
