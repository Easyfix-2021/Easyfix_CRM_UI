'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SearchMultiSelect } from './search-multi-select';
import type { SearchOption } from './search-select';
import { IconButton } from './icon-button';
import { cn } from '@/lib/utils';

/*
 * PriceTree — generic shared component for "option-group → price" trees.
 *
 * Used today by Settings → Manage Materials for Brand Prices (top level)
 * and State Price Overrides (nested, one level per brand-price row via
 * `renderChildTree`). Built to be reused later for a third level on the
 * client rate card, so it carries NO fetching and NO domain knowledge —
 * it only knows about `{ id, optionIds, price }` rows and an option list.
 *
 * Domain rules (e.g. "Not Applicable is exclusive of other brands", "an
 * inactive brand still on a row shows a tag") are NOT this component's
 * job — callers express them by shaping `options` (bake a suffix into
 * `label`) and by post-processing the array their `onChange` receives
 * before committing it to state (see MaterialDialog's
 * `enforceNotApplicableExclusivity`).
 *
 * Visual: an optional `parent` block, a vertical rail with elbows
 * connecting each child row, each row = a SearchMultiSelect trigger +
 * removable chips + a ₹ price input + a delete icon, and a trailing
 * "+ addLabel" affordance.
 */

export type PriceTreeOption = { value: number; label: string };
export type PriceTreeRow = {
  id: string;
  optionIds: number[];
  price: number | null;
  /* Optional second ₹ value alongside price (e.g. Tx Share on the client
     material-rate state overrides) — see `showSecondary` below. Unused by
     every caller that doesn't opt in. */
  secondaryPrice?: number | null;
};

export type PriceTreeProps = {
  options: PriceTreeOption[];
  rows: PriceTreeRow[];
  onChange: (rows: PriceTreeRow[]) => void;
  /* Optional descriptive block rendered above the rail (e.g. context about
     what this tree hangs off — a brand-group summary for a nested tree). */
  parent?: React.ReactNode;
  /* Optional slot rendered inline with the section header (right side) —
     e.g. a banner, count, or a link to manage the option catalogue. */
  parentSlot?: React.ReactNode;
  sectionLabel: string;
  addLabel: string;
  /* An option already used by a SIBLING row is disabled on this row's
     picker — a brand (or state) can only sit in one group. Default true. */
  disabledWhenUsed?: boolean;
  minRows?: number;
  requirePrice?: boolean;
  readOnlyOptions?: boolean;
  canEdit: boolean;
  renderChildTree?: (row: PriceTreeRow) => React.ReactNode;
  className?: string;
  emptyText?: string;
  /*
   * Renders a second ₹ input (`row.secondaryPrice`) beside the price column
   * — off by default, so every existing caller (Manage Materials' Brand
   * Prices / State Price Overrides) is unaffected. Still domain-free: the
   * caller supplies the label and the derivation function.
   */
  showSecondary?: boolean;
  secondaryLabel?: string;
  /*
   * Called with the row's NEW price whenever the price input changes, to
   * derive the new secondaryPrice (e.g. `defaultTxShare`). The secondary
   * input's own onChange never calls this — a manual secondary edit is kept
   * until the next price change, by design.
   */
  deriveSecondaryOnPriceChange?: (price: number | null) => number | null;
};

let rowSeq = 0;
export function newPriceTreeRowId(): string {
  rowSeq += 1;
  return `pt_${Date.now()}_${rowSeq}`;
}

export function PriceTree({
  options,
  rows,
  onChange,
  parent,
  parentSlot,
  sectionLabel,
  addLabel,
  disabledWhenUsed = true,
  minRows = 0,
  requirePrice = false,
  readOnlyOptions = false,
  canEdit,
  renderChildTree,
  className,
  emptyText = 'No entries yet.',
  showSecondary = false,
  secondaryLabel = 'Amount',
  deriveSecondaryOnPriceChange,
}: PriceTreeProps) {
  const optionLabelByValue = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const o of options) m.set(o.value, o.label);
    return m;
  }, [options]);

  function usedBySiblings(rowId: string): Set<number> {
    const used = new Set<number>();
    if (!disabledWhenUsed) return used;
    for (const r of rows) {
      if (r.id === rowId) continue;
      for (const id of r.optionIds) used.add(id);
    }
    return used;
  }

  function addRow() {
    onChange([...rows, { id: newPriceTreeRowId(), optionIds: [], price: null }]);
  }
  function removeRow(id: string) {
    onChange(rows.filter((r) => r.id !== id));
  }
  function patchRow(id: string, patch: Partial<PriceTreeRow>) {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeOptionFromRow(id: string, optionId: number) {
    onChange(rows.map((r) => (r.id === id ? { ...r, optionIds: r.optionIds.filter((v) => v !== optionId) } : r)));
  }

  const canRemoveRows = rows.length > minRows;

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{sectionLabel}</div>
        {parentSlot}
      </div>
      {parent && <div className="pl-1">{parent}</div>}

      {rows.length === 0 && (
        <div className="pl-6 text-xs text-muted-foreground">{emptyText}</div>
      )}

      <div className="space-y-0">
        {rows.map((row, idx) => {
          const used = usedBySiblings(row.id);
          const rowOptions: SearchOption[] = options.map((o) => ({
            value: o.value,
            label: o.label,
            disabled: used.has(o.value),
            disabledReason: used.has(o.value) ? 'Already used by another row' : undefined,
          }));
          const isLast = idx === rows.length - 1;
          return (
            <div key={row.id} className="relative pl-6">
              {/* vertical rail segment (full row height, except the very
                  last row only needs the stub down to its own elbow) */}
              <span
                className={cn('absolute left-2 top-0 w-px bg-border', isLast ? 'h-5' : 'bottom-0')}
                aria-hidden="true"
              />
              {/* elbow connecting the rail to this row */}
              <span className="absolute left-2 top-5 h-px w-4 bg-border" aria-hidden="true" />

              <div className="flex items-start gap-2 py-1.5">
                <div className="flex-1 min-w-0 space-y-1">
                  <SearchMultiSelect
                    value={row.optionIds}
                    onChange={(next) => patchRow(row.id, { optionIds: (next as Array<string | number>).map(Number) })}
                    options={rowOptions}
                    disabled={!canEdit || readOnlyOptions}
                    placeholder="Select…"
                  />
                  {row.optionIds.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {row.optionIds.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                        >
                          {optionLabelByValue.get(id) ?? `#${id}`}
                          {canEdit && !readOnlyOptions && (
                            <button
                              type="button"
                              onClick={() => removeOptionFromRow(row.id, id)}
                              className="text-muted-foreground hover:text-foreground"
                              aria-label="Remove"
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="w-32 shrink-0">
                  <div className="relative">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={row.price ?? ''}
                      onChange={(e) => {
                        const price = e.target.value === '' ? null : Number(e.target.value);
                        patchRow(row.id, {
                          price,
                          ...(deriveSecondaryOnPriceChange ? { secondaryPrice: deriveSecondaryOnPriceChange(price) } : {}),
                        });
                      }}
                      disabled={!canEdit}
                      placeholder={requirePrice ? 'Required' : 'Pending'}
                      className="h-9 w-full rounded-md border border-input bg-background pl-5 pr-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </div>
                </div>
                {showSecondary && (
                  <div className="w-32 shrink-0">
                    <div className="relative">
                      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={row.secondaryPrice ?? ''}
                        onChange={(e) => patchRow(row.id, { secondaryPrice: e.target.value === '' ? null : Number(e.target.value) })}
                        disabled={!canEdit}
                        aria-label={secondaryLabel}
                        title={secondaryLabel}
                        placeholder={secondaryLabel}
                        className="h-9 w-full rounded-md border border-input bg-background pl-5 pr-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                  </div>
                )}
                {canEdit && (
                  <IconButton
                    icon={Trash2}
                    label="Remove Row"
                    intent="danger"
                    disabled={!canRemoveRows}
                    onClick={() => removeRow(row.id)}
                  />
                )}
              </div>

              {renderChildTree && row.optionIds.length > 0 && (
                <div className="pl-4 pb-2">{renderChildTree(row)}</div>
              )}
            </div>
          );
        })}
      </div>

      {canEdit && (
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1 pl-6 text-xs text-primary hover:underline"
        >
          <Plus className="size-3.5" /> {addLabel}
        </button>
      )}
    </div>
  );
}
