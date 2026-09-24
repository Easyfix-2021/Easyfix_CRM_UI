'use client';

/*
 * QuickSight — MTD Client Report: the three controls sections 5 to 11 need and
 * ./shared does not have.
 *
 *   ReconcileNote  the quiet line a section prints when the server's own check
 *                  for THAT section came back false
 *   FindBox        the search input the city table and the job list carry
 *   ScopeChip      the "Days open: 3–5 days ✕" / "Showing: …" chip
 *
 * EVERYTHING ELSE COMES FROM ./shared — num, dash, SectionCard, SubHeading,
 * LocalTable, TableFrame / TableHead / MessageRow / BodyRows. This file is
 * deliberately thin: the tab was built by two hands at once and a second table
 * kit beside the first is exactly the mess that would leave behind. These
 * three are here because they are the only pieces sections 5 to 11 need that
 * sections 1 to 4 never did.
 *
 * Nothing here fetches.
 */

import { AlertTriangle, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { MtdChecks } from '../types';

/**
 * The one line a section prints when the server's own arithmetic for it did
 * not add up.
 *
 * `checks` is the report's per-identity flags; `keys` are the ones THIS
 * section owns. A key the response does not carry is treated as fine — the
 * backend is free to add a check without the frontend having to ship first —
 * so only a key that is explicitly false raises the note.
 *
 * It is a quiet line under the heading, not a hidden section: the numbers are
 * still the best the server has, and hiding them would leave a reader with no
 * way to see what went wrong. The server has already logged the failure, so
 * this is a warning to the reader, not an alert to anyone on call.
 */
export function ReconcileNote({ checks, keys }: { checks?: MtdChecks; keys: readonly string[] }) {
  if (!checks) return null;
  const failed = keys.filter((k) => checks[k] === false);
  if (failed.length === 0) return null;
  return (
    <p className="flex items-start gap-2 rounded-md border border-urgent-strong/40 bg-urgent-tint/40 px-3 py-2 text-xs text-muted-foreground">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-urgent-strong" aria-hidden />
      <span>
        <span className="font-medium text-foreground">This section does not add up.</span>{' '}
        Its parts no longer sum to its total ({failed.join(', ')}), which the server has logged as an error.
        Treat these figures as indicative and report the window before acting on them.
      </span>
    </p>
  );
}

/** The search input beside a table heading. Controlled; the caller debounces. */
export function FindBox({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <label className="relative block w-52">
      <span className="sr-only">{label}</span>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8"
      />
    </label>
  );
}

/**
 * The chip that names a narrowing the reader applied elsewhere on the page —
 * the days-open band driving "Why cancelled", or the matrix cell driving the
 * job list. Saying what is in force and offering to clear it is all it does.
 */
export function ScopeChip({
  label,
  value,
  onClear,
  clearLabel,
}: {
  label: string;
  value: string;
  onClear?: () => void;
  clearLabel: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel}
          title={clearLabel}
          className="-mr-1 rounded-full p-0.5 text-muted-foreground hover:bg-primary/20 hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </span>
  );
}
