/*
 * RELATIVE imports of import-free lib modules only: `npm run test:build`
 * compiles src/lib with --rootDir src/lib, so an `@/components/**` import would
 * break the behavioural test. The tone strings are a subset of StatusChipTone
 * (components/ui/StatusChip.tsx) — structurally assignable at the call site,
 * the same arrangement job-app-request.ts uses.
 */
import { istToday } from './due-date';
import { parseIstDateTime } from './format';
import { appRequestOf, type AppRequestFields } from './job-app-request';

type Tone = 'urgent' | 'warning' | 'info' | 'success' | 'neutral';

/*
 * PENDING TO START — THE LIVE STATUS OF ONE JOB, in two parts that answer two
 * different questions:
 *
 *   STATUS  what is waiting on the job. The SAME priority the page's tabs use
 *           (the server partitions the list by it — ptsStateSql in the
 *           backend), so the tab a row sits in and the status it shows can
 *           never disagree:
 *             cancel request → reschedule request → slot missed (appointment
 *             on an earlier day, or none) → due today → upcoming.
 *
 *   TIMING  how close the appointment is, from its date AND time (IST):
 *             Running late — the appointment time has passed
 *             Close loop   — 2 hours or less to go (confirm with the technician)
 *             On-track     — more than 2 hours to go
 *
 * So a missed slot is always Running late, an upcoming job is On-track (except
 * one due within 2 hours of midnight), and today's jobs and open requests can be
 * any of the three. Late starts AT the appointment time — no grace — which is
 * the old CRM's "Running Late" rule (ops' call, 2026-09-17).
 *
 * Check-in is not a state here: checking in moves a job to Pending to Close
 * (status 2), so no job in this bucket has one.
 *
 * Pure functions of (job, now) — the caller owns the clock, so a row and the
 * console open beside it tick together.
 */

export type PtsLiveState = 'cancel' | 'reschedule' | 'missed' | 'today' | 'future';

export type PtsStatusJob = AppRequestFields & { requested_date_time?: string | null };

export const PTS_STATUS: Record<PtsLiveState, { label: string; tone: Tone }> = {
  cancel:     { label: 'Cancel requested',     tone: 'urgent' },
  reschedule: { label: 'Reschedule requested', tone: 'warning' },
  missed:     { label: 'Slot missed',          tone: 'urgent' },
  today:      { label: 'Due today',            tone: 'info' },
  future:     { label: 'Upcoming',             tone: 'neutral' },
};

/** The tab-priority classifier, for ONE job. */
export function ptsStateOf(job: PtsStatusJob | null | undefined, today: string = istToday()): PtsLiveState {
  const req = job ? appRequestOf(job) : null;
  if (req?.kind === 'cancel') return 'cancel';
  if (req?.kind === 'reschedule') return 'reschedule';
  const day = String(job?.requested_date_time ?? '').slice(0, 10);
  if (!day || day < today) return 'missed';
  return day === today ? 'today' : 'future';
}

/* "Close loop" window: this many minutes or fewer before the appointment. */
export const CLOSE_LOOP_MINUTES = 120;

export type AppointmentTimingKind = 'late' | 'close_loop' | 'on_track';

export type AppointmentTiming = {
  kind: AppointmentTimingKind;
  /** Minutes late (kind 'late') or minutes to go (the other two). */
  minutes: number;
  /** Chip text, e.g. "Running late · 2h 10m". */
  label: string;
  tone: Tone;
};

/**
 * Timing of an appointment against `nowMs`. Null when the job has no
 * appointment (it then sits in Slot missed with no time to measure from).
 */
export function appointmentTiming(
  requestedDateTime: string | null | undefined,
  nowMs: number = Date.now(),
): AppointmentTiming | null {
  if (!requestedDateTime) return null;
  const at = parseIstDateTime(String(requestedDateTime)).getTime();
  if (!Number.isFinite(at)) return null;
  if (nowMs > at) {
    const late = Math.floor((nowMs - at) / 60000);
    return { kind: 'late', minutes: late, label: `Running late · ${formatSpan(late)}`, tone: 'urgent' };
  }
  const left = Math.ceil((at - nowMs) / 60000);
  if (left <= CLOSE_LOOP_MINUTES) {
    return { kind: 'close_loop', minutes: left, label: `Close loop · ${formatSpan(left)} left`, tone: 'warning' };
  }
  return { kind: 'on_track', minutes: left, label: `On-track · in ${formatSpan(left)}`, tone: 'success' };
}

/* 45 → "45m", 130 → "2h 10m", 2880 → "2d", 3130 → "2d 4h". */
export function formatSpan(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}
