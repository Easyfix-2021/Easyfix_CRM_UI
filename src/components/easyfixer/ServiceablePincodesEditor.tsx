'use client';
/*
 * ServiceablePincodesEditor — the technician's serviceable-pincode multi-select.
 *
 * Lifted verbatim (2026-09-28) out of the verification page, which had been its
 * only home, so the New Registration 2 "Work & Coverage" tab can offer the SAME
 * editor instead of a second implementation that would drift from it. Both
 * callers render this one component; behaviour below is unchanged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Search, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useFetch, useDebouncedValue } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { showToast } from '@/components/ui/toast';

/*
 * Multi-select of pincodes the technician will accept jobs in. Persisted
 * to tbl_efr_serviceable_pincode_map via /admin/easyfixers/:id/
 * serviceable-pincodes (GET + PUT).
 *
 * Load model (2026-06-11 redesign — server-side typeahead):
 *   - While the dropdown is open, the search input (debounced 300ms via
 *     useDebouncedValue) is sent as `q` to
 *     /admin/pincodes?limit=100&includeInactive=false.
 *   - Empty query intentionally fetches the first 100 rows so the
 *     on-focus dropdown still shows results.
 *   - useFetch's module cache dedupes repeat queries; the full ~155k-row
 *     catalog is never downloaded to the browser.
 *
 * Bulk-paste (operator productivity):
 *   - When the search input contains comma/space/newline separators AND
 *     enough digits for 2+ pincodes, an "Add All Matching Pincodes"
 *     button appears next to the search; Enter triggers the same flow.
 *   - Codes are parsed, 6-digit-validated, and resolved via
 *     POST /admin/pincodes/lookup-many. Matched rows merge into the chip
 *     set; unmatched codes surface in a toast.
 *
 * State model mirrors DeepSkillOptionMapping: `original` is the Set
 * captured on first fetch (re-anchored after Save); `selected` is the
 * working set; Save is disabled until divergence.
 */

export type PincodeChip = {
  pincode_id: number;
  pincode: string;
  location: string | null;
  city_name: string | null;
  state_name: string | null;
};

type PincodeSearchRow = PincodeChip;

// Canonical label for both the picker OPTIONS and the selected chips (#8):
// "<pincode> - <location> - <city_name>". Only genuinely-empty parts drop out.
export function pincodeLabel(p: { pincode: string; location?: string | null; city_name?: string | null }): string {
  const loc  = (p.location ?? '').trim();
  const city = (p.city_name ?? '').trim();
  return [String(p.pincode), loc || null, city || null].filter(Boolean).join(' - ');
}

export function ServiceablePincodesEditor({ efrId, onReload }: { efrId: number; onReload?: () => Promise<void> }) {
  const [selected, setSelected] = useState<Map<number, PincodeChip>>(new Map());
  const [original, setOriginal] = useState<Map<number, PincodeChip>>(new Map());
  const [search, setSearch] = useState('');
  const [bulkLookupBusy, setBulkLookupBusy] = useState(false);
  // Auto-create-on-no-match (#6): which 6-digit term is being ensured right now
  // (drives the in-dropdown "Adding…" copy) + a transient "Added <pincode>" hint
  // shown briefly after a successful silent create. `ensuredCodes` memoises the
  // codes we've already attempted this session so the no-match effect fires at
  // most once per code (prevents a debounce re-render from re-POSTing).
  const [ensuringCode, setEnsuringCode] = useState<string | null>(null);
  const [ensuredHint, setEnsuredHint] = useState<string | null>(null);
  const ensuredCodes = useRef<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Initial load — fetch current serviceable pincodes for this efr.
  // The response is reshaped into a Map<pincodeId, chip> that backs
  // BOTH `selected` and `original` (dirty-tracking). useFetch returns
  // a single `data` value; threading two derived Map states through
  // it would just hide a setEffect-on-data dance. Targeted disable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        // eslint-disable-next-line no-restricted-syntax
        const resp = await api.get<{ items: PincodeChip[] }>(
          `/admin/easyfixers/${efrId}/serviceable-pincodes`
        );
        if (cancelled) return;
        const items = resp?.items ?? [];
        const map = new Map<number, PincodeChip>();
        for (const p of items) {
          map.set(Number(p.pincode_id), {
            pincode_id: Number(p.pincode_id),
            pincode: String(p.pincode),
            location: p.location ?? null,
            city_name: p.city_name ?? null,
            state_name: p.state_name ?? null,
          });
        }
        setSelected(new Map(map));
        setOriginal(new Map(map));
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Failed to load serviceable pincodes');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [efrId]);

  // Click-outside to close the dropdown.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Bulk-paste detection heuristic:
  //   • input must contain a comma, space, or newline (separator), AND
  //   • digits-only length ≥ 12 (i.e. at least 2 pincodes worth).
  // Threshold 12 keeps incidental whitespace from triggering while a real
  // paste like "110001, 110002" passes.
  const isBulkInput = useMemo(() => {
    if (!/[,\s\n]/.test(search)) return false;
    const digitsOnly = search.replace(/\D/g, '');
    return digitsOnly.length >= 12;
  }, [search]);

  // Server-side typeahead — debounced q search, limit 100. Empty query
  // intentionally fetches the first 100 rows so the on-focus dropdown
  // still shows results. useFetch's module cache dedupes repeat queries.
  // (status param omitted — BE's status enum is LOCAL/TRAVEL, a derived
  // classification, not active/inactive; includeInactive=false filters.)
  const dq = useDebouncedValue(search.trim(), 300);
  const searchKey = open && !isBulkInput
    ? `/admin/pincodes?limit=100&includeInactive=false${dq ? `&q=${encodeURIComponent(dq)}` : ''}`
    : null;
  const { data: searchData, loading: searchLoading } = useFetch<{ items: PincodeSearchRow[] }>(searchKey);
  const filteredResults = isBulkInput ? [] : (searchData?.items ?? []);

  function toggle(row: PincodeSearchRow) {
    const id = Number(row.pincode_id);
    const next = new Map(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.set(id, {
        pincode_id: id,
        pincode: String(row.pincode),
        location: row.location ?? null,
        city_name: row.city_name ?? null,
        state_name: row.state_name ?? null,
      });
    }
    setSelected(next);
  }

  function removeChip(id: number) {
    const next = new Map(selected);
    next.delete(id);
    setSelected(next);
  }

  async function handleBulkAdd() {
    if (bulkLookupBusy) return;
    const codes = search
      .split(/[,\s\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => /^\d{6}$/.test(p));
    if (codes.length === 0) {
      showToast({ variant: 'error', message: 'No Valid Pincodes Found In Input' });
      return;
    }
    setBulkLookupBusy(true);
    setError(null);
    try {
      const resp = await api.post<{ items: PincodeSearchRow[]; notFound: string[] }>(
        `/admin/pincodes/lookup-many`,
        { pincodes: codes }
      );
      const items = Array.isArray(resp?.items) ? resp.items : [];
      const notFound = Array.isArray(resp?.notFound) ? resp.notFound : [];
      const next = new Map(selected);
      for (const it of items) {
        const id = Number(it.pincode_id);
        next.set(id, {
          pincode_id: id,
          pincode: String(it.pincode),
          location: it.location ?? null,
          city_name: it.city_name ?? null,
          state_name: it.state_name ?? null,
        });
      }
      setSelected(next);
      setSearch('');
      if (items.length > 0) {
        showToast({
          variant: 'success',
          message: `Added ${items.length} Pincode${items.length === 1 ? '' : 's'}`,
        });
      }
      if (notFound.length > 0) {
        const preview = notFound.slice(0, 5).join(', ');
        const suffix = notFound.length > 5 ? '…' : '';
        showToast({
          variant: 'error',
          message: `${notFound.length} pincodes not found: ${preview}${suffix}`,
        });
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Bulk lookup failed';
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setBulkLookupBusy(false);
    }
  }

  // #6 — Auto-create a missing pincode on no-match. Silently POSTs
  // /admin/pincodes/ensure { pincode }; the BE is idempotent (returns the
  // existing row if it already exists) and geocodes + find-or-creates the city/
  // state for a brand-new Indian pincode. On success the returned row is merged
  // into `selected` (same shape as toggle()) and a brief "Added <pincode>" hint
  // is shown. A 400 (non-Indian / ungeocodable) surfaces inline via `error`.
  const ensureAndAdd = useCallback(async (code: string) => {
    const pin = String(code).trim();
    if (!/^\d{6}$/.test(pin)) return;
    // Fire at most once per code per session.
    if (ensuredCodes.current.has(pin)) return;
    ensuredCodes.current.add(pin);
    setEnsuringCode(pin);
    setError(null);
    try {
      const resp = await api.post<{
        pincode_id: number; pincode: string; location?: string | null;
        city_name: string | null; state_name: string | null; created: boolean;
      }>(`/admin/pincodes/ensure`, { pincode: pin });
      if (!resp?.pincode_id) return;
      const id = Number(resp.pincode_id);
      setSelected((prev) => {
        const next = new Map(prev);
        next.set(id, {
          pincode_id: id,
          pincode: String(resp.pincode),
          location: resp.location ?? null,
          city_name: resp.city_name ?? null,
          state_name: resp.state_name ?? null,
        });
        return next;
      });
      setSearch('');
      setOpen(false);
      setEnsuredHint(`Added ${resp.pincode}`);
    } catch (e) {
      // Allow a retry on transient failure: drop the memo so the operator can
      // re-trigger by re-typing the same code.
      ensuredCodes.current.delete(pin);
      setError(e instanceof ApiError ? e.message : `Could not add pincode ${pin}`);
    } finally {
      setEnsuringCode(null);
    }
  }, []);

  // No-match watcher: once the debounced query is a complete 6-digit pincode and
  // the (settled) typeahead returned zero rows, silently ensure it. Guards:
  // dropdown open, not a bulk paste, search has finished loading, and no result.
  useEffect(() => {
    if (!open || isBulkInput || searchLoading) return;
    if (!/^\d{6}$/.test(dq)) return;
    if (filteredResults.length > 0) return;
    void ensureAndAdd(dq);
  }, [open, isBulkInput, searchLoading, dq, filteredResults.length, ensureAndAdd]);

  // Auto-dismiss the "Added <pincode>" hint after a short beat.
  useEffect(() => {
    if (!ensuredHint) return;
    const t = setTimeout(() => setEnsuredHint(null), 3000);
    return () => clearTimeout(t);
  }, [ensuredHint]);

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && isBulkInput) {
      e.preventDefault();
      void handleBulkAdd();
    }
  }

  const dirty = useMemo(() => {
    if (selected.size !== original.size) return true;
    for (const k of selected.keys()) if (!original.has(k)) return true;
    return false;
  }, [selected, original]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const pincodeIds = Array.from(selected.keys());
      await api.put(`/admin/easyfixers/${efrId}/serviceable-pincodes`, { pincodeIds });
      // Re-fetch + re-anchor original to the new server state.
      const resp = await api.get<{ items: PincodeChip[] }>(
        `/admin/easyfixers/${efrId}/serviceable-pincodes`
      );
      const items = resp?.items ?? [];
      const map = new Map<number, PincodeChip>();
      for (const p of items) {
        map.set(Number(p.pincode_id), {
          pincode_id: Number(p.pincode_id),
          pincode: String(p.pincode),
          location: p.location ?? null,
          city_name: p.city_name ?? null,
          state_name: p.state_name ?? null,
        });
      }
      setSelected(new Map(map));
      setOriginal(new Map(map));
      showToast({ variant: 'success', message: 'Serviceable Pincodes Updated' });
      // Refresh parent payload so the Additional Details progress bar
      // reflects the new pincode count.
      if (onReload) await onReload();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed to save serviceable pincodes';
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSaving(false);
    }
  }

  const chips = useMemo(
    () => Array.from(selected.values()).sort((a, b) => a.pincode.localeCompare(b.pincode)),
    [selected]
  );

  return (
    <div className="border-t pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-ink-700">Serviceable Pincodes</h4>
          <p className="text-xs text-ink-500">
            Pincodes Where This Technician Will Accept Jobs. Type To Search, Or Paste A Comma/Space Separated List To Bulk-Add.
          </p>
        </div>
        <span className="text-xs text-ink-500">
          {selected.size} Pincode{selected.size === 1 ? '' : 's'} Selected
        </span>
      </div>

      {loading ? (
        <div className="text-xs text-ink-500">Loading…</div>
      ) : (
        <>
          <div ref={containerRef} className="relative">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-500 pointer-events-none" />
                <Input
                  value={search}
                  placeholder="Search By Pincode, Location Or City, Or Paste A List…"
                  onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
                  onFocus={() => setOpen(true)}
                  onKeyDown={onSearchKeyDown}
                  className="pl-8"
                />
              </div>
              {/* Hover pinned to dark green in both themes — see the Proceed
                  gate near the top of this file. */}
              {isBulkInput && (
                <Button
                  type="button"
                  onClick={() => void handleBulkAdd()}
                  disabled={bulkLookupBusy}
                  className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white whitespace-nowrap"
                >
                  {bulkLookupBusy ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding…
                    </span>
                  ) : (
                    'Add All Matching Pincodes'
                  )}
                </Button>
              )}
            </div>
            {open && !isBulkInput && (
              <div className="absolute z-20 mt-1 w-full rounded-md border border-ink-100 bg-popover shadow-lg max-h-72 overflow-auto">
                {searchLoading && filteredResults.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-ink-500 inline-flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading Pincodes…
                  </div>
                ) : filteredResults.length === 0 ? (
                  ensuringCode && /^\d{6}$/.test(dq) ? (
                    <div className="px-3 py-3 text-xs text-ink-500 inline-flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding Pincode {ensuringCode}…
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-xs text-ink-500">No Pincodes Match.</div>
                  )
                ) : (
                  <>
                    {filteredResults.map((r) => {
                      const id = Number(r.pincode_id);
                      const isSelected = selected.has(id);
                      return (
                        <button
                          type="button"
                          key={id}
                          onClick={() => toggle(r)}
                          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-ink-50"
                        >
                          <span className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              readOnly
                              checked={isSelected}
                              className="h-4 w-4 accent-success pointer-events-none"
                            />
                            <span className="font-medium text-ink-900">{pincodeLabel(r)}</span>
                          </span>
                          {isSelected && <Check className="h-4 w-4 text-success shrink-0" />}
                        </button>
                      );
                    })}
                    {filteredResults.length >= 100 && (
                      <div className="px-3 py-1.5 text-xs text-ink-500 border-t bg-ink-50/60">
                        Showing First 100 Matches — Refine Your Search Or Paste A List To Bulk-Add.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {isBulkInput && (
              <div className="mt-1 text-xs text-ink-500">
                Press Enter Or Click The Button To Resolve And Add All Pincodes.
              </div>
            )}
          </div>

          {/* Selected chips */}
          {chips.length === 0 ? (
            <div className="rounded border border-dashed border-ink-100 bg-ink-50 p-3 text-xs text-ink-500">
              No Serviceable Pincodes Selected Yet — Type Above To Search Or Paste A List To Bulk-Add.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {chips.map((c) => (
                <span
                  key={c.pincode_id}
                  className="inline-flex items-center gap-1.5 rounded-full bg-info-tint border border-info/30 text-info-strong pl-3 pr-1.5 py-0.5 text-xs"
                  title={[c.city_name, c.state_name].filter(Boolean).join(', ') || undefined}
                >
                  <span className="font-medium">{pincodeLabel(c)}</span>
                  <button
                    type="button"
                    onClick={() => removeChip(c.pincode_id)}
                    className="rounded-full p-0.5 hover:bg-info/20"
                    aria-label={`Remove ${c.pincode}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {ensuredHint && (
            <div className="text-xs text-success inline-flex items-center gap-1">
              <Check className="h-3.5 w-3.5" /> {ensuredHint}
            </div>
          )}
          {error && <div className="text-xs text-urgent">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <Button disabled={saving || !dirty} onClick={save} className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white">
              {saving ? 'Saving…' : 'Save Serviceable Pincodes'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
