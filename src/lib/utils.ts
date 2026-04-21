import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

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
    return opts.assigned ? 'Pending App Ack' : 'Pending Scheduling';
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

export function statusColorClass(code: number): string {
  const map: Record<number, string> = {
    0:  'bg-status-booked/10 text-status-booked',
    1:  'bg-status-scheduled/10 text-status-scheduled',
    2:  'bg-status-inprogress/10 text-status-inprogress',
    3:  'bg-status-completed/10 text-status-completed',
    5:  'bg-status-completed/10 text-status-completed',
    6:  'bg-status-cancelled/10 text-status-cancelled',
    7:  'bg-slate-100 text-slate-700',
    9:  'bg-rose-100 text-rose-700',     // Unconfirmed — attention colour
    10: 'bg-status-revisit/10 text-status-revisit',
    15: 'bg-purple-100 text-purple-700', // Estimate pending
    20: 'bg-status-inprogress/10 text-status-inprogress', // same visual as 2
    21: 'bg-amber-100 text-amber-700',   // On hold — warm warning
  };
  return map[code] ?? 'bg-muted text-muted-foreground';
}
