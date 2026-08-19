'use client';

/*
 * ClientPicker — server-side typeahead over /shared/lookup/clients.
 *
 * The sibling of TechnicianPicker, same shape and same trick. Use this when the
 * caller needs to pick ONE client and cannot rely on `useLookup()`'s preload:
 * that hook fetches `?limit=500` once per session, so past 500 clients the tail
 * is silently absent — the client you wanted simply is not in the list, with no
 * error to explain why. A typeahead has no such ceiling.
 *
 * `useLookup().toOpts.clients` is still the right choice for a filter bar where
 * the full list is small and instant re-filtering matters. Prefer this one for
 * a required "which client is this?" field.
 *
 * ⚠ THE PINNED-OPTION TRICK IS LOAD-BEARING. In async mode SearchSelect renders
 * exactly the options it is given and does NO client-side filtering. The moment
 * the operator types a new query the server returns a different page, the
 * selected row falls out of it, and the trigger loses its label — the field
 * looks empty even though a client is selected. So the picked option is held in
 * local state and merged back into the list. Same reason `handleChange` returns
 * early when the re-selected value IS the pinned one: `rows.find` misses it,
 * and clearing a choice the operator just re-affirmed is worse than doing
 * nothing.
 */

import * as React from 'react';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { useFetch, useDebouncedValue } from '@/lib/hooks';

/* The row shape GET /shared/lookup/clients returns (the fields we render).
 * Note it carries `client_city_id`, not `city_id` — a long-standing legacy
 * column name that trips up anyone copying a city join from elsewhere. */
export type ClientLite = {
  client_id: number;
  client_name: string;
  client_status?: number;
  reference_code?: string | null;
};

export function clientOption(c: ClientLite): SearchOption {
  return {
    value: c.client_id,
    label: c.client_name,
    // Reference code is how ops identify a client on paper, so make it
    // searchable without cluttering the visible label.
    keywords: c.reference_code || undefined,
  };
}

export function ClientPicker({
  value,
  onPick,
  placeholder,
  allLabel,
  className,
  disabled,
  required,
}: {
  value: number | '';
  /* Reports the whole row, not just the id, so callers can name the client in
     headings and toasts without a second lookup. */
  onPick: (c: ClientLite | null) => void;
  placeholder: string;
  /* When set, prepends a clear-the-filter option with this label. */
  allLabel?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const [query, setQuery] = React.useState('');
  const dq = useDebouncedValue(query, 300);
  const [picked, setPicked] = React.useState<SearchOption | null>(null);

  const key = dq.trim()
    ? `/shared/lookup/clients?q=${encodeURIComponent(dq.trim())}&limit=100`
    : '/shared/lookup/clients?limit=100';
  const lookup = useFetch<ClientLite[]>(key);
  const rows = React.useMemo(() => lookup.data ?? [], [lookup.data]);

  const options = React.useMemo<SearchOption[]>(() => {
    const out: SearchOption[] = rows.map(clientOption);
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
    const row = rows.find((r) => String(r.client_id) === String(v)) ?? null;
    if (row) {
      setPicked(clientOption(row));
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
      placeholder={lookup.loading ? 'Loading Clients…' : placeholder}
      emptyText={lookup.error ? 'Client Lookup Failed' : 'No Clients Match'}
      className={className}
      disabled={disabled}
      required={required}
    />
  );
}
