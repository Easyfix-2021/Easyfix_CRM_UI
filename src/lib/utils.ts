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

export function statusLabel(code: number): string {
  const map: Record<number, string> = {
    0: 'Booked', 1: 'Scheduled', 2: 'In Progress', 3: 'Completed',
    5: 'Completed', 6: 'Cancelled', 7: 'Enquiry', 9: 'Call Later', 10: 'Revisit',
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
    0: 'bg-status-booked/10 text-status-booked',
    1: 'bg-status-scheduled/10 text-status-scheduled',
    2: 'bg-status-inprogress/10 text-status-inprogress',
    3: 'bg-status-completed/10 text-status-completed',
    5: 'bg-status-completed/10 text-status-completed',
    6: 'bg-status-cancelled/10 text-status-cancelled',
    10: 'bg-status-revisit/10 text-status-revisit',
  };
  return map[code] ?? 'bg-muted text-muted-foreground';
}
