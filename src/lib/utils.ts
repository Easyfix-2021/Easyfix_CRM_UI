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
