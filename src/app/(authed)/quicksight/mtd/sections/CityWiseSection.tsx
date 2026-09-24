'use client';

/*
 * QuickSight — MTD Client Report, section 8: City-Wise Orders Created And
 * Completed.
 *
 * A table, not a chart — the MIS report has it as one, and it is the right
 * shape: a hundred cities are a list to search and sort, not a hundred bars.
 *
 * THE TWO COLUMNS ARE NOT THE SAME JOBS. Orders Created counts tickets RAISED
 * in the window, by ticket-created date; Completed counts jobs CLOSED in the
 * window, by checkout date — mostly other jobs, raised in other months. A city
 * completing more than it created is normal and is not a reconciliation
 * failure. Each column sums to its own KPI tile, and to nothing else.
 *
 * `state` IS THE MODAL STATE, not the first one seen: city names repeat across
 * states, so the server sends whichever state most of that city's jobs carry.
 * It is a label, not a key — two genuinely different cities of the same name
 * are one row here, exactly as they are one row in the MIS report.
 *
 * '(City not given)' IS PINNED BELOW EVERY PAGE and never sorted or paged
 * away. It is real work — it is inside both KPI tiles — so a reader who sorts
 * by Completed and lands on page three is still entitled to see it, and
 * otherwise would not. The one exception is a search that matches nothing
 * else: it then becomes the body, because a footer is not drawn over an empty
 * table and a row somebody searched for must not vanish.
 *
 * THE TOTALS ROW FOLLOWS THE SEARCH. With an empty box it is every city and
 * therefore equals the two KPI tiles; with something typed it is the matching
 * cities only and says so, because a "Total" that silently ignored the filter
 * above it would be the one number on the card nobody could check.
 */

import { useMemo, useState } from 'react';
import { useDebouncedValue } from '@/lib/hooks';
import type { MtdChecks, MtdCityRow } from '../types';
import { LocalTable, SectionCard, dash, num, type Column } from './shared';
import { FindBox, ReconcileNote } from './report-parts';

/* mtd-report.service.js BLANK_CITY — the label for jobs that carry no city. */
const BLANK_CITY = '(City not given)';

const COLUMNS: ReadonlyArray<Column<MtdCityRow>> = [
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State', render: (r) => dash(r.state) },
  { key: 'created', label: 'Orders Created', align: 'right', render: (r) => num(r.created) },
  { key: 'completed', label: 'Completed', align: 'right', render: (r) => num(r.completed) },
];

/** One row rendered in the footer: the pinned blank-city line, or the totals. */
function FootRow({ cells, strong }: { cells: readonly [string, string, string, string]; strong?: boolean }) {
  const base = strong ? 'border-t-2 border-border bg-muted/60 font-semibold' : 'bg-muted/30';
  return (
    <tr>
      <td className={base}>{cells[0]}</td>
      <td className={base}>{cells[1]}</td>
      <td className={`${base} !text-right tabular-nums`}>{cells[2]}</td>
      <td className={`${base} !text-right tabular-nums`}>{cells[3]}</td>
    </tr>
  );
}

export function CityWiseSection({
  cities,
  checks,
}: {
  cities: readonly MtdCityRow[];
  checks?: MtdChecks;
}) {
  const [query, setQuery] = useState('');
  /*
   * Typing re-filters a list the page already holds, so the debounce is not
   * about requests — it is so a long list does not re-sort and re-page on
   * every keystroke.
   */
  const needle = useDebouncedValue(query, 200).trim().toLowerCase();

  const view = useMemo(() => {
    const matches = (r: MtdCityRow) => needle === ''
      || r.city.toLowerCase().includes(needle)
      || (r.state ?? '').toLowerCase().includes(needle);

    const shown = cities.filter(matches);
    const named = shown.filter((r) => r.city !== BLANK_CITY);
    const blank = shown.find((r) => r.city === BLANK_CITY) ?? null;
    /*
     * When the search matches ONLY the blank-city row it becomes the body: the
     * table draws no footer over an empty body, so a pinned row would
     * disappear exactly when somebody went looking for it.
     *
     * `rows` is decided in here rather than during render because LocalTable
     * returns to the first page whenever the rows ARRAY IDENTITY changes. A
     * fresh array built on every render would do that on every render, and
     * setting state during render on every render does not converge.
     */
    const onlyBlank = named.length === 0 && blank !== null;
    return {
      rows: onlyBlank && blank ? [blank] : named,
      blank,
      onlyBlank,
      created: shown.reduce((s, r) => s + r.created, 0),
      completed: shown.reduce((s, r) => s + r.completed, 0),
      shownCount: shown.length,
      /* Named cities in the whole report — what the subtitle counts when
       * nothing is typed, since '(City not given)' is not a city. */
      namedTotal: cities.filter((r) => r.city !== BLANK_CITY).length,
    };
  }, [cities, needle]);

  const searching = needle !== '';

  const subtitle = searching
    ? `Showing ${num(view.shownCount)} of ${num(cities.length)} rows · orders created by ticket created date, completed by closure date`
    : `${num(view.namedTotal)} ${view.namedTotal === 1 ? 'city' : 'cities'} · orders created by ticket created date, completed by closure date`;

  return (
    <SectionCard
      title="8. City-Wise Orders Created And Completed"
      subtitle={subtitle}
      tools={(
        <FindBox
          value={query}
          onChange={setQuery}
          placeholder="Find a city or state"
          label="Find a city or state"
        />
      )}
    >
      <ReconcileNote checks={checks} keys={['cities']} />
      <LocalTable<MtdCityRow>
        rows={view.rows}
        columns={COLUMNS}
        rowKey={(r) => `${r.city}|${r.state ?? ''}`}
        emptyText={searching ? `No city matches “${query.trim()}”.` : 'No orders in this view.'}
        pageSize={20}
        footer={(
          <>
            {!view.onlyBlank && view.blank && (
              <FootRow cells={[view.blank.city, '—', num(view.blank.created), num(view.blank.completed)]} />
            )}
            <FootRow
              cells={[searching ? 'Total (shown)' : 'Total', '', num(view.created), num(view.completed)]}
              strong
            />
          </>
        )}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        Orders Created and Completed are not the same jobs: the first counts tickets raised in the selected
        dates, the second counts jobs closed in them — mostly jobs raised in earlier months. A city completing
        more than it created is normal. With the search box empty, the two totals are the Orders Created and
        Completed tiles at the top of the tab.
      </p>
    </SectionCard>
  );
}
