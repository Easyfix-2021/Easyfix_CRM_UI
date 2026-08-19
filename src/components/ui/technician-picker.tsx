'use client';

/*
 * TechnicianPicker — server-side typeahead over /shared/lookup/easyfixers.
 *
 * Use this instead of preloading `useLookup().toOpts.easyfixers` when the bench
 * is too large to ship in one payload (the lookup defaults to a 5000-row limit
 * and the technician master is well past that). The query is debounced and sent
 * to the server; SearchSelect runs in ASYNC mode.
 *
 * ⚠ THE PINNED-OPTION TRICK IS LOAD-BEARING. In async mode SearchSelect renders
 * exactly the options it is given and does NO client-side filtering. The moment
 * the operator types a new query the server returns a different page, the
 * selected row falls out of it, and the trigger loses its label — the field
 * looks empty even though a technician is selected. So the picked option is
 * held in local state and merged back into the list. The same reason
 * `handleChange` returns early when the re-selected value IS the pinned one:
 * `rows.find` misses it, and clearing a choice the operator just re-affirmed is
 * worse than doing nothing.
 *
 * Extracted from the rewards/ledger page (which still carries its own copy —
 * migrating it is a mechanical import swap, deliberately left out of the change
 * that created this file).
 */

import * as React from 'react';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { useFetch, useDebouncedValue } from '@/lib/hooks';
import { formatEasyfixerName } from '@/lib/utils';

/* The row shape GET /shared/lookup/easyfixers returns (the fields we render). */
export type EasyfixerLite = {
  efr_id: number;
  efr_name: string;
  efr_no: string;
  city_name: string | null;
};

/* "Name · Mobile · City" so the typeahead matches on any of the three.
 * formatEasyfixerName expands the legacy "(T)" prefix to "Trainee · …". */
export function techLabel(t: EasyfixerLite): string {
  return `${formatEasyfixerName(t.efr_name)} · ${t.efr_no}${t.city_name ? ` · ${t.city_name}` : ''}`;
}

export function techOption(t: EasyfixerLite): SearchOption {
  return { value: t.efr_id, label: techLabel(t) };
}

export function TechnicianPicker({
  value,
  onPick,
  placeholder,
  allLabel,
  className,
  disabled,
}: {
  value: number | '';
  /* Reports the whole row, not just the id, so callers can name the technician
     in confirms, toasts and headings without a second lookup. */
  onPick: (t: EasyfixerLite | null) => void;
  placeholder: string;
  /* When set, prepends a clear-the-filter option with this label. */
  allLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = React.useState('');
  const dq = useDebouncedValue(query, 300);
  const [picked, setPicked] = React.useState<SearchOption | null>(null);

  const key = dq.trim()
    ? `/shared/lookup/easyfixers?q=${encodeURIComponent(dq.trim())}`
    : '/shared/lookup/easyfixers';
  const lookup = useFetch<EasyfixerLite[]>(key);
  const rows = React.useMemo(() => lookup.data ?? [], [lookup.data]);

  const options = React.useMemo<SearchOption[]>(() => {
    const out: SearchOption[] = rows.map(techOption);
    if (picked && !out.some((o) => String(o.value) === String(picked.value))) {
      out.unshift(picked);
    }
    return allLabel ? [{ value: '', label: allLabel }, ...out] : out;
  }, [rows, picked, allLabel]);

  function handleChange(v: string) {
    if (!v) {
      setPicked(null);
      onPick(null);
      return;
    }
    const row = rows.find((r) => String(r.efr_id) === String(v)) ?? null;
    if (row) {
      setPicked(techOption(row));
      onPick(row);
      return;
    }
    // Re-selecting the PINNED option: it is not in the current server page, so
    // `rows.find` misses it. Keep the existing selection rather than clearing
    // a choice the operator just re-affirmed.
    if (picked && String(picked.value) === String(v)) return;
    onPick(null);
  }

  return (
    <SearchSelect
      value={value}
      onChange={handleChange}
      options={options}
      onQueryChange={setQuery}
      placeholder={lookup.loading ? 'Loading Technicians…' : placeholder}
      emptyText={lookup.error ? 'Technician Lookup Failed' : 'No Technicians Match'}
      className={className}
      disabled={disabled}
    />
  );
}
