'use client';

/*
 * Tools to Carry + Products at Site (V3 Phase 4, spec 4.4/4.5, CRM section).
 * Rendered inside JobModal's Services tab, below the services table.
 *
 * Both editors are hidden unless the operator holds `isJobEdit` — "the same
 * action key the CRM job edit uses" (PHASE4-SPEC.md's own phrasing for the
 * backend gate on PUT/POST/DELETE .../tools and .../site-products). The
 * caller (ServicesTabBody) already resolves this once via `canEditJob` for
 * the Description pencil, so it's threaded down as a prop instead of a
 * second `useMe()` call here.
 *
 *   Tools to Carry   — GET /admin/jobs/:id/tools ({items:[{id,name}]}) + GET
 *                       /admin/tools (master list, reused from
 *                       settings/service-types's own Tools picker) feed a
 *                       SearchMultiSelect; Save PUTs the whole replacement set.
 *   Products at Site — GET /admin/jobs/:id/site-products (rows); add posts
 *                       {name, qty, brand?}; remove DELETEs a row, behind
 *                       useConfirm (no native confirm()).
 */

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Wrench, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { api, ApiError, type JobToolsResponse, type ToolOption, type JobSiteProduct } from '@/lib/api';
import { toolSelectionChanged, toolIdsFromResponse } from '@/lib/job-extras';

export function ToolsAndProductsSection({ jobId, canEdit }: { jobId: number; canEdit: boolean }) {
  // Hidden entirely without the permission — not just read-only — per spec
  // ("Both hidden unless the operator has the same action permission").
  if (!canEdit) return null;
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
      <ToolsToCarryEditor jobId={jobId} />
      <ProductsAtSiteEditor jobId={jobId} />
    </div>
  );
}

// ─── Tools to Carry ──────────────────────────────────────────────────────

function toolsKey(jobId: number) { return `/admin/jobs/${jobId}/tools`; }

function ToolsToCarryEditor({ jobId }: { jobId: number }) {
  const current = useFetch<JobToolsResponse>(toolsKey(jobId));
  const { data: toolsData } = useFetch<ToolOption[] | { items?: ToolOption[] }>('/admin/tools?limit=500');
  const options = useMemo(() => {
    const arr: ToolOption[] = Array.isArray(toolsData) ? toolsData : (toolsData?.items ?? []);
    return arr.map((t) => ({ value: Number(t.tool_id), label: t.tool_name }));
  }, [toolsData]);

  // toolIdsFromResponse (lib/job-extras.ts): the first build read a `toolIds`
  // field the backend never sends, so the editor showed NO current tools and
  // Save replaced the job's real list with whatever was just picked.
  const serverIds = useMemo(() => toolIdsFromResponse(current.data), [current.data]);
  const [selected, setSelected] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  // Re-seed local selection whenever the server value changes (job switch,
  // or a fresh fetch after Save) — mirrors the seed-on-fetch pattern the
  // Manage Service Types Tools picker uses.
  useEffect(() => { setSelected(serverIds); }, [serverIds]);

  const dirty = toolSelectionChanged(serverIds, selected);

  async function save() {
    setSaving(true);
    try {
      await api.putJobTools(jobId, selected);
      showToast({ variant: 'success', message: 'Tools to Carry updated' });
      invalidateFetch((k) => k === toolsKey(jobId));
      current.refetch();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed to save tools' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      <div className="flex items-center gap-1.5 font-medium text-sm">
        <Wrench className="size-4" /> Tools to Carry
      </div>
      <SearchMultiSelect
        value={selected}
        onChange={(next) => setSelected(next.map(Number))}
        options={options}
        placeholder={current.loading ? 'Loading…' : '— Select tools —'}
        selectedLabel="tools"
        disabled={current.loading}
      />
      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

// ─── Products at Site ────────────────────────────────────────────────────

function siteProductsKey(jobId: number) { return `/admin/jobs/${jobId}/site-products`; }

function ProductsAtSiteEditor({ jobId }: { jobId: number }) {
  const { data, loading, refetch } = useFetch<JobSiteProduct[] | { items?: JobSiteProduct[] }>(siteProductsKey(jobId));
  const rows: JobSiteProduct[] = Array.isArray(data) ? data : (data?.items ?? []);

  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [brand, setBrand] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const confirm = useConfirm();

  const qtyNum = Number(qty);
  const canAdd = name.trim().length > 0 && Number.isFinite(qtyNum) && qtyNum >= 1 && !adding;

  function refresh() {
    invalidateFetch((k) => k === siteProductsKey(jobId));
    refetch();
  }

  async function add() {
    if (!canAdd) return;
    setAdding(true);
    try {
      await api.addJobSiteProduct(jobId, { name: name.trim(), qty: qtyNum, brand: brand.trim() || undefined });
      showToast({ variant: 'success', message: 'Product added' });
      setName(''); setQty('1'); setBrand('');
      refresh();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed to add product' });
    } finally {
      setAdding(false);
    }
  }

  async function remove(row: JobSiteProduct) {
    const ok = await confirm({
      title: 'Remove Product?',
      description: `Remove "${row.name}" from Products at Site?`,
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!ok) return;
    setRemovingId(row.id);
    try {
      await api.deleteJobSiteProduct(jobId, row.id);
      showToast({ variant: 'success', message: 'Product removed' });
      refresh();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed to remove product' });
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      <div className="flex items-center gap-1.5 font-medium text-sm">
        <Package className="size-4" /> Products at Site · {rows.length}
      </div>
      {loading && rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">No products recorded at site.</div>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 py-1.5">
              <span>
                {row.name} <span className="text-muted-foreground">× {row.qty}</span>
                {row.brand && <span className="text-muted-foreground"> · {row.brand}</span>}
              </span>
              <button
                type="button"
                title="Remove"
                aria-label={`Remove ${row.name}`}
                className="inline-flex items-center justify-center w-7 h-7 rounded border bg-card border-urgent text-urgent-strong hover:bg-destructive/15 disabled:opacity-50"
                onClick={() => remove(row)}
                disabled={removingId === row.id}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-[1fr_72px_1fr_auto] gap-1.5 items-end pt-1">
        <div>
          <Label className="text-xs">Name *</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Product name" maxLength={160} />
        </div>
        <div>
          <Label className="text-xs">Qty *</Label>
          <Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">Brand</Label>
          <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Optional" maxLength={80} />
        </div>
        <Button size="sm" onClick={add} disabled={!canAdd}>
          <Plus className="size-3.5 mr-1" /> {adding ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </div>
  );
}
