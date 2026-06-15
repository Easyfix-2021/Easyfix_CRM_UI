'use client';

/*
 * QuickSightFilterBar — DRYs the recurring multi-select filter set shared
 * by most QuickSight reports (Open Orders, Client Performance, Vertical
 * Orders, City/Technician Performance, Employee Productivity, …).
 *
 * Filters: Clients, Verticals, Service Categories, Zonal Managers,
 * Project Managers. Each is the canonical SearchMultiSelect (searchable,
 * multi, empty = "all") — NOT a forked variant. Every filter is fully
 * controlled (value + onChange) so the parent page owns filter state and
 * keys its useFetch on the serialized state (per the fetch-hooks rule).
 *
 * Lookup sourcing:
 *   - Clients / Verticals / Service Categories come from the shared
 *     `useLookup` hook's `toOpts` (already cached + admin-gated).
 *   - Zonal Managers + Project Managers are NOT in useLookup yet. The BE
 *     /api/shared/lookup/project-managers endpoint is being added in
 *     parallel; until useLookup exposes them, the parent injects the
 *     options via `zonalManagerOptions` / `projectManagerOptions` (typed
 *     SearchOption[]). When omitted, that filter simply isn't rendered —
 *     so a report only shows the filters it actually uses.
 *
 * Each filter is independently opt-in via the `show` prop. A report that
 * only filters by Client + Vertical passes show={{ clients:true,
 * verticals:true }} and gets a clean 2-column row.
 */

import { useMemo } from 'react';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import type { SearchOption } from '@/components/ui/search-select';
import { useLookup } from '@/lib/use-lookup';

export type QuickSightFilterValue = Array<string | number>;

/*
 * Which filters to render. Each defaults to false — a report opts into
 * exactly the filters it supports. Zonal/Project managers additionally
 * require their options to be supplied (see below); enabling the flag
 * without options renders the control with an empty list.
 */
export type QuickSightFilterToggles = {
  clients?: boolean;
  verticals?: boolean;
  serviceCategories?: boolean;
  zonalManagers?: boolean;
  projectManagers?: boolean;
};

export type QuickSightFilterBarProps = {
  show: QuickSightFilterToggles;

  clients?: QuickSightFilterValue;
  onClientsChange?: (next: QuickSightFilterValue) => void;

  verticals?: QuickSightFilterValue;
  onVerticalsChange?: (next: QuickSightFilterValue) => void;

  serviceCategories?: QuickSightFilterValue;
  onServiceCategoriesChange?: (next: QuickSightFilterValue) => void;

  zonalManagers?: QuickSightFilterValue;
  onZonalManagersChange?: (next: QuickSightFilterValue) => void;
  /*
   * Zonal Manager options (tbl_city.state_user). Injected because
   * useLookup doesn't expose this lookup yet. Required to render the
   * Zonal Managers filter.
   */
  zonalManagerOptions?: SearchOption[];

  projectManagers?: QuickSightFilterValue;
  onProjectManagersChange?: (next: QuickSightFilterValue) => void;
  /*
   * Project Manager options (tbl_vertical_mapping user_type 1/2). Injected
   * from the parallel /api/shared/lookup/project-managers endpoint until
   * useLookup exposes it. Required to render the Project Managers filter.
   */
  projectManagerOptions?: SearchOption[];

  disabled?: boolean;
  className?: string;
};

/* Small labelled wrapper so every filter shares the same Title-Case label
 * treatment without repeating markup. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export function QuickSightFilterBar({
  show,
  clients = [],
  onClientsChange,
  verticals = [],
  onVerticalsChange,
  serviceCategories = [],
  onServiceCategoriesChange,
  zonalManagers = [],
  onZonalManagersChange,
  zonalManagerOptions,
  projectManagers = [],
  onProjectManagersChange,
  projectManagerOptions,
  disabled,
  className,
}: QuickSightFilterBarProps) {
  const lookup = useLookup();

  // Service-category options sorted A→Z for predictable scanning.
  const svcCatOpts = useMemo(
    () =>
      [...lookup.toOpts.serviceCategories].sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
    [lookup.toOpts.serviceCategories],
  );

  return (
    <div
      className={[
        'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3',
        className ?? '',
      ].join(' ')}
    >
      {show.clients && (
        <Field label="Clients">
          <SearchMultiSelect
            value={clients}
            onChange={(v) => onClientsChange?.(v)}
            options={lookup.toOpts.clients}
            placeholder="All Clients"
            selectedLabel="clients"
            disabled={disabled}
          />
        </Field>
      )}

      {show.verticals && (
        <Field label="Verticals">
          <SearchMultiSelect
            value={verticals}
            onChange={(v) => onVerticalsChange?.(v)}
            options={lookup.verticals.map((x) => ({
              value: x.vertical_id,
              label: x.vertical_name,
            }))}
            placeholder="All Verticals"
            selectedLabel="verticals"
            disabled={disabled}
          />
        </Field>
      )}

      {show.serviceCategories && (
        <Field label="Service Categories">
          <SearchMultiSelect
            value={serviceCategories}
            onChange={(v) => onServiceCategoriesChange?.(v)}
            options={svcCatOpts}
            placeholder="All Service Categories"
            selectedLabel="categories"
            disabled={disabled}
          />
        </Field>
      )}

      {show.zonalManagers && (
        <Field label="Zonal Managers">
          <SearchMultiSelect
            value={zonalManagers}
            onChange={(v) => onZonalManagersChange?.(v)}
            options={zonalManagerOptions ?? []}
            placeholder="All Zonal Managers"
            selectedLabel="managers"
            disabled={disabled}
          />
        </Field>
      )}

      {show.projectManagers && (
        <Field label="Project Managers">
          <SearchMultiSelect
            value={projectManagers}
            onChange={(v) => onProjectManagersChange?.(v)}
            options={projectManagerOptions ?? []}
            placeholder="All Project Managers"
            selectedLabel="managers"
            disabled={disabled}
          />
        </Field>
      )}
    </div>
  );
}
