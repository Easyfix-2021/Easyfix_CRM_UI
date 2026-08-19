import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { TONE_SURFACE_CLASSES, type StatusChipTone } from '@/components/ui/StatusChip';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

/*
 * IST 'now' as a fixed-width wall-clock string 'YYYY-MM-DDTHH:mm'. Built from
 * Intl parts (not `new Date().toISOString()`) so it's the IST clock regardless
 * of the browser's local timezone, and fixed-width so it compares
 * LEXICOGRAPHICALLY against another same-format string.
 */
export function istNowWallClock(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

/*
 * appointmentIsPast(requestedDateTime) — has the job's promised slot already
 * gone, in IST? Mirrors the SERVER rule in routes/admin/jobs.js verbatim, which
 * refuses to reschedule INTO the past or to offer a job whose slot has passed;
 * keep the two in step or the UI will promise something the API rejects.
 *
 * A DATE-ONLY value carries no promised time, so it is judged by DATE — never
 * coerced to 00:00, which would wrongly call "today, time unspecified" past.
 *
 * Deliberately NOT folded into magicLinkRescheduleGate below: that gate treats
 * a date-only value as 'none' and changing it would alter the magic-link flow.
 */
export function appointmentIsPast(requestedDateTime: string | null | undefined): boolean {
  if (!requestedDateTime) return false;
  const raw = String(requestedDateTime).replace(' ', 'T');
  const now = istNowWallClock();   // fixed-width, so lexicographic IS chronological
  if (raw.length <= 10) return raw.slice(0, 10) < now.slice(0, 10);
  return raw.slice(0, 16) < now.slice(0, 16);
}

/*
 * Reschedule gate for "Send Magic Link" on Unconfirmed orders, keyed on the
 * job's appointment (`requested_date_time`, an IST wall-clock string from the BE):
 *   'mandatory' — appointment is in the PAST (datetime < IST now). Includes a
 *                 slot that already passed earlier today. Ops must reschedule
 *                 before the link goes out.
 *   'optional'  — appointment is LATER TODAY (>= now, same IST calendar day).
 *                 Offer a reschedule but let ops send as-is.
 *   'none'      — appointment is a future day. Send directly.
 *
 * Compares IST WALL-CLOCK strings, never `new Date(a) < new Date(b)` — that
 * compares instants and misfires across the +05:30 boundary near midnight.
 */
export function magicLinkRescheduleGate(
  requestedDateTime: string | null | undefined,
): 'mandatory' | 'optional' | 'none' {
  if (!requestedDateTime) return 'none';
  // BE format is 'YYYY-MM-DD HH:mm:ss' (IST); normalise to 'YYYY-MM-DDTHH:mm'.
  const appt = String(requestedDateTime).replace(' ', 'T').slice(0, 16);
  if (appt.length < 16) return 'none';
  const now = istNowWallClock();
  if (appt < now) return 'mandatory';
  if (appt.slice(0, 10) === now.slice(0, 10)) return 'optional';
  return 'none';
}

/*
 * relativeTime(iso) → "just now" / "3 min ago" / "2 hr ago" / "5 days ago".
 *
 * Small, dependency-free formatter (the repo has no Intl.RelativeTimeFormat
 * helper). Falls back to the absolute formatDate() for anything older than a
 * day-ish so very stale timestamps stay legible. Invalid / future dates clamp
 * to "just now".
 *
 * Extracted here (from LiveLocationPopover) so any consumer needing a live
 * "N min ago" label — e.g. the Offered-to list in ScheduleAssignModal — can
 * share one implementation next to formatDate.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 0) return 'just now';
  if (diffSec < 45) return 'just now';
  if (diffSec < 90) return '1 min ago';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  return formatDate(iso);
}

/*
 * toIstClockTime(d) → "HH:MM" (IST 24-hour clock).
 *
 * Produces the value the legacy companion time-text columns store
 * (`requested_time`, `original_appointment_time` on tbl_job). Use it when
 * submitting those fields instead of shipping a full ISO datetime — the
 * column only holds HH:MM, and a 24-char ISO trips the backend validator's
 * length cap (see EasyFix_Backend/validators/job.validator.js).
 *
 * Inputs from <input type="datetime-local"> are NAIVE wall-clock strings
 * ("YYYY-MM-DDTHH:MM", no timezone) — already IST as the operator typed
 * them. We take that HH:MM verbatim so the result is correct regardless of
 * the browser's timezone (no Date parsing, no UTC round-trip). Only when a
 * caller passes a real instant (ISO with a Z/offset, or a Date) do we
 * project into Asia/Kolkata.
 */
export function toIstClockTime(d: string | Date | null | undefined): string {
  if (!d) return '';
  if (typeof d === 'string') {
    const hasExplicitZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(d.trim());
    const naive = d.match(/T(\d{2}):(\d{2})/);
    if (!hasExplicitZone && naive) return `${naive[1]}:${naive[2]}`;
  }
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Kolkata',
  }).format(date);
}

/*
 * Canonical job_status labels — sourced from the DB truth documented in
 * EasyFix_Backend/services/job.service.js (updated 2026-04-20) and matching
 * the legacy `HomeAction.getJobUIStatus()` classifier 1:1.
 *
 * Base codes:
 *   0  Booked (sub-split below by fk_easyfixter_id)
 *   1  Scheduled (accepted on app, pending start)
 *   2, 20  Checked in (in progress)
 *   3, 5  Closed
 *   6  Cancelled
 *   7  Enquiry
 *   9  Unconfirmed
 *   10 Closed from App (estimate approved/rejected)
 *   15 Estimate Pending Approval
 *   21 Fulfilment On Hold
 *
 * Lifecycle sub-state (matches legacy's `getJobUIStatus`):
 *   status = 0 + fk_easyfixter_id IS NULL     → "Pending Scheduling"
 *   status = 0 + fk_easyfixter_id IS NOT NULL → "Pending App Ack"
 *
 * Callers pass `{ assigned: boolean }` when they know the tech-presence at
 * render time (jobs list, job modal). Callers that only have the code pass
 * nothing and get the base "Booked" label.
 *
 * Unknown codes render as "Status N" to surface schema drift loudly instead
 * of swallowing it silently.
 */
export function statusLabel(code: number, opts?: { assigned?: boolean | null }): string {
  // BOOKED sub-state: legacy disambiguates by tech presence. Only applies when
  // caller tells us whether the job has a tech — otherwise we fall through
  // to the base "Booked" label.
  if (code === 0 && opts && opts.assigned !== undefined && opts.assigned !== null) {
    // 'Pending for Scheduling' matches the tab name in lib/job-tabs.ts and the
    // name ops actually use — the chip and the tab must read the same.
    return opts.assigned ? 'Pending App Ack' : 'Pending for Scheduling';
  }
  const map: Record<number, string> = {
    0:  'Booked',
    1:  'Scheduled',
    2:  'In Progress',
    3:  'Completed',
    5:  'Completed',
    6:  'Cancelled',
    7:  'Enquiry',
    9:  'Unconfirmed',
    10: 'Closed from App',
    15: 'Estimate Pending',
    20: 'In Progress',
    21: 'On Hold',
  };
  return map[code] ?? `Status ${code}`;
}

/*
 * Expands legacy `(T)` prefix in tbl_easyfixer.efr_name → "Trainee …".
 * Legacy CRM used this naming convention to mark technicians in training
 * (all T-prefixed rows have is_technician_verified=NULL and incomplete
 * profile percentages). Applying this at render time keeps the underlying
 * value untouched (no DB writes) while giving operators a readable label.
 *
 * Matches both "(T) Name" and " (T) Name" (leading whitespace is common in
 * real data). Case-insensitive. Non-matching names pass through unchanged.
 */
export function formatEasyfixerName(name: string | null | undefined): string {
  if (!name) return '';
  const match = name.match(/^\s*\(T\)\s*(.+)$/i);
  if (!match) return name;
  return `Trainee · ${match[1].trim()}`;
}

/*
 * statusColorClass — bare tint surface (`bg-*-tint text-*-strong`) for a job
 * status, used where the shape is a plain span rather than a `<StatusChip />`.
 *
 * It DELEGATES to `statusTone()` and looks the answer up in StatusChip's own
 * `TONE_SURFACE_CLASSES`. Previously this held a second, hand-maintained
 * code→colour table alongside `statusTone()`, and the two had already drifted
 * (this one still pointed at a `status-*` palette that no longer exists, so
 * half the statuses rendered no colour at all). Now there is exactly one
 * code→meaning mapping and exactly one meaning→classes mapping.
 */
export function statusColorClass(code: number): string {
  return TONE_SURFACE_CLASSES[statusTone(code)];
}

/*
 * statusTone — THE code→meaning mapping for job statuses. Returns a
 * `StatusChipTone` token consumable by the shared `<StatusChip />` primitive
 * at `src/components/ui/StatusChip.tsx`. Use this when rendering a status
 * via `<StatusChip tone={statusTone(code)} />` so every consumer reaches
 * the same one-component-one-shape pill (added 2026-05-30 to retire the
 * copy-pasted `<span className="rounded-full ...">` snippets across tables).
 *
 * `statusColorClass()` above is derived from this — do not add a colour
 * decision anywhere else.
 */
export type StatusTone = StatusChipTone;

export function statusTone(code: number): StatusTone {
  const map: Record<number, StatusTone> = {
    0:  'info',    // Booked
    1:  'info',    // Scheduled
    2:  'warning', // In Progress
    3:  'success', // Completed
    5:  'success', // Completed (alt)
    6:  'urgent',  // Cancelled
    7:  'neutral', // Enquiry
    9:  'urgent',  // Unconfirmed — attention colour
    10: 'gold',    // Revisit
    15: 'gold',    // Estimate pending
    20: 'warning', // In progress (alt — same visual as 2)
    21: 'warning', // On hold — warm warning
  };
  return map[code] ?? 'neutral';
}
