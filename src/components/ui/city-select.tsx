'use client';

import React from 'react';
import { api } from '@/lib/api';
import { SearchSelect, type SearchOption } from './search-select';

type CityRow = { city_id: number; city_name: string; state_id: number | null };

/*
 * CitySelect — server-side typeahead for the ~11k-row city master.
 *
 * Unlike a plain <SearchSelect options={allCities}>, this NEVER preloads the
 * whole table. It:
 *   - queries GET /shared/lookup/cities?q=<typed> (debounced ~250ms) as the
 *     user types, so any city is reachable and NEWLY-ADDED cities show up on
 *     the next search (no 30-min sessionStorage staleness);
 *   - resolves a preselected `value` (city_id) → its name via ?ids= so the
 *     trigger shows the city name, not a bare id, when editing an existing row.
 *
 * onChange returns BOTH the id and the resolved name so callers that need the
 * label (e.g. to display or cache it) don't have to re-fetch.
 */
export function CitySelect({
  value,
  onChange,
  placeholder = '— Select city —',
  disabled,
  required,
  stateId,
}: {
  value: string | number | '';
  onChange: (cityId: string, cityName: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Optional: scope the search to one state. */
  stateId?: number;
}) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<SearchOption[]>([]);
  const [selectedOpt, setSelectedOpt] = React.useState<SearchOption | null>(null);
  // Per-instance query cache — dies on unmount, so a freshly-opened picker
  // re-queries and picks up newly-added cities. Avoids refetching a query the
  // user already ran within the same mount.
  const cacheRef = React.useRef<Map<string, SearchOption[]>>(new Map());

  // Resolve a preselected value (e.g. a saved job's city_id) → its label so the
  // closed trigger shows the city name instead of an id.
  React.useEffect(() => {
    const idStr = String(value ?? '');
    if (!idStr) { setSelectedOpt(null); return; }
    if (selectedOpt && String(selectedOpt.value) === idStr) return;
    let cancelled = false;
    api
      .get<CityRow[]>('/shared/lookup/cities', { ids: idStr })
      .then((rows) => {
        if (cancelled) return;
        const r = rows?.[0];
        if (r) setSelectedOpt({ value: String(r.city_id), label: r.city_name });
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // Intentionally keyed on `value` only — selectedOpt is compared inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Debounced server search on the typed query.
  React.useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return; }
    const key = `${stateId ?? ''}:${q.toLowerCase()}`;
    const cached = cacheRef.current.get(key);
    if (cached) { setResults(cached); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .get<CityRow[]>('/shared/lookup/cities', { q, limit: 50, ...(stateId ? { stateId } : {}) })
        .then((rows) => {
          if (cancelled) return;
          const opts: SearchOption[] = (rows || []).map((r) => ({
            value: String(r.city_id),
            label: r.city_name,
          }));
          cacheRef.current.set(key, opts);
          setResults(opts);
        })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, stateId]);

  // Keep the selected option pinned at the top so its label always renders,
  // even before/without a matching search.
  const options = React.useMemo(() => {
    if (selectedOpt && !results.some((o) => String(o.value) === String(selectedOpt.value))) {
      return [selectedOpt, ...results];
    }
    return results;
  }, [selectedOpt, results]);

  return (
    <SearchSelect
      value={String(value ?? '')}
      onChange={(v) => {
        const opt = options.find((o) => String(o.value) === String(v)) || null;
        if (opt) setSelectedOpt(opt);
        onChange(String(v), opt?.label ?? '');
      }}
      options={options}
      onQueryChange={setQuery}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      emptyText={query.trim() ? 'No matching cities' : 'Type to search cities…'}
    />
  );
}
