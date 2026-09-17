'use client';

import { useEffect, useMemo, useState } from 'react';
import { Lock, Minus, Plus, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchSelect } from '@/components/ui/search-select';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useFetch } from '@/lib/hooks';

/*
 * ServicesOneListDialog — Edit Services as ONE list, rate card first. Used by
 * the Uplifted tab of Schedule & Assign only; the Current tab keeps the basket
 * editor so the two can be compared on real jobs before one replaces the other.
 *
 * WHY A LIST OF CHECKBOXES AND NOT A BASKET. The basket let an operator "add"
 * a product the job already carried, and the server's add path answers that by
 * OVERWRITING the quantity — "add one more" silently cut a qty-2 line to 1. In a
 * list where every rate-card product is exactly one row, the product already on
 * the job is simply ticked: there is no second way to add it, so the duplicate
 * cannot be expressed at all. Same shape as the legacy CRM's Edit Service.
 *
 * WHY ONE SAVE. Every change here is staged and sent as the COMPLETE desired set
 * (PUT /admin/jobs/:id/services), applied server-side in one transaction. The
 * per-row autosave it replaces is what let a quantity saved on blur race the
 * dialog closing; with one write there is nothing to race, and a half-applied
 * edit cannot exist.
 *
 * RULES THE SERVER ALSO ENFORCES (the UI states them so nobody learns them from
 * an error): at least one service; quantity 1–100; the job's category is fixed,
 * except that a job with NO category picks one here, once; a line from another
 * category that is already on the job can be kept or dropped, never added.
 */

type Product = {
  service_id: number;
  name: string;
  code?: string | null;
  service_type_id: number;
  service_type_name: string;
  unit_client: number | null;
  unit_tx: number | null;
  on_job_qty: number | null;
  job_service_id: number | null;
};
type Foreign = {
  job_service_id: number;
  service_id: number;
  name: string;
  service_type_name?: string | null;
  service_catg_name?: string | null;
  quantity: number;
  unit_client: number | null;
  unit_tx: number | null;
};
type Catalog = {
  category: { id: number; name: string; source: 'job' | 'services' } | null;
  categories?: Array<{ id: number; name: string }>;
  types: Array<{ service_type_id: number; name: string }>;
  products: Product[];
  foreign: Foreign[];
};

type Line = { checked: boolean; qty: number };
type View = 'all' | 'on' | 'changed';

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export function ServicesOneListDialog({ open, jobId, onClose, onSaved }: {
  open: boolean;
  jobId: number | null;
  onClose: () => void;
  /** The host re-reads the job (and re-ranks) — services drive the ranking. */
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  /* Only asked for on a job with no category: the catalog is reloaded for the
     category picked here, and the save sets it on the job. */
  const [pickedCategory, setPickedCategory] = useState('');
  const key = open && jobId
    ? `/admin/jobs/${jobId}/service-catalog${pickedCategory ? `?categoryId=${pickedCategory}` : ''}`
    : null;
  const { data: catalog, loading, error, refetch } = useFetch<Catalog>(key);

  const [lines, setLines] = useState<Record<number, Line>>({});
  const [typesOn, setTypesOn] = useState<Set<number>>(new Set());
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>('all');
  const [saving, setSaving] = useState(false);

  /*
   * The ORIGINAL state, from the catalog — what "changed" is measured against.
   * Seeded each time a catalog lands (open, category pick), so reopening never
   * shows a previous session's staged edits.
   */
  const initial = useMemo(() => {
    const m: Record<number, Line> = {};
    for (const p of catalog?.products ?? []) m[p.service_id] = { checked: p.on_job_qty != null, qty: p.on_job_qty ?? 1 };
    for (const f of catalog?.foreign ?? []) m[f.service_id] = { checked: true, qty: f.quantity };
    return m;
  }, [catalog]);

  useEffect(() => {
    if (!catalog) return;
    setLines(initial);
    setTypesOn(new Set((catalog.products ?? []).filter((p) => p.on_job_qty != null).map((p) => p.service_type_id)));
  }, [catalog, initial]);

  useEffect(() => {
    if (!open) { setPickedCategory(''); setQ(''); setView('all'); }
  }, [open]);

  const needsCategory = !!catalog && !catalog.category && !pickedCategory;

  function statusOf(id: number): 'on' | 'added' | 'removed' | 'changed' | 'off' {
    const was = initial[id];
    const now = lines[id];
    if (!now || !was) return 'off';
    if (was.checked && !now.checked) return 'removed';
    if (!was.checked && now.checked) return 'added';
    if (was.checked && now.qty !== was.qty) return 'changed';
    return was.checked ? 'on' : 'off';
  }

  const allIds = useMemo(
    () => [...(catalog?.products ?? []).map((p) => p.service_id), ...(catalog?.foreign ?? []).map((f) => f.service_id)],
    [catalog],
  );
  const diff = useMemo(() => {
    const d = { added: 0, changed: 0, removed: 0 };
    for (const id of allIds) {
      const st = statusOf(id);
      if (st === 'added') d.added++;
      else if (st === 'changed') d.changed++;
      else if (st === 'removed') d.removed++;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allIds, lines, initial]);
  const dirty = diff.added + diff.changed + diff.removed > 0;

  const priced = [
    ...(catalog?.products ?? []).map((p) => ({ id: p.service_id, client: p.unit_client, tx: p.unit_tx })),
    ...(catalog?.foreign ?? []).map((f) => ({ id: f.service_id, client: f.unit_client, tx: f.unit_tx })),
  ];
  const ticked = priced.filter((p) => lines[p.id]?.checked);
  const totalClient = ticked.reduce((n, p) => n + Number(p.client ?? 0) * (lines[p.id]?.qty ?? 1), 0);
  const totalTx = ticked.reduce((n, p) => n + Number(p.tx ?? 0) * (lines[p.id]?.qty ?? 1), 0);

  /* One place decides whether Save can run, and the hint says why not. */
  const blocker = needsCategory ? 'Pick the service category first'
    : ticked.length === 0 ? 'A job needs at least one service'
      : !dirty ? 'No changes to save'
        : '';

  function setLine(id: number, patch: Partial<Line>) {
    setLines((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { checked: false, qty: 1 }), ...patch } }));
  }

  async function requestClose() {
    if (dirty && !saving) {
      const ok = await confirm({
        title: 'Discard unsaved service changes?',
        description: 'The ticks and quantities you changed have not been saved.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    onClose();
  }

  async function save() {
    if (!jobId || blocker) return;
    setSaving(true);
    try {
      const services = allIds
        .filter((id) => lines[id]?.checked)
        .map((id) => ({ service_id: id, quantity: lines[id].qty }));
      await api.put(`/admin/jobs/${jobId}/services`, {
        ...(catalog && !catalog.category && pickedCategory ? { categoryId: Number(pickedCategory) } : {}),
        services,
      });
      const parts = [
        diff.added && `${diff.added} added`,
        diff.changed && `${diff.changed} quantity changed`,
        diff.removed && `${diff.removed} removed`,
      ].filter(Boolean);
      showToast({ variant: 'success', message: `Services Saved · ${parts.join(' · ')}` });
      refetch();
      onSaved();
      onClose();
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not save services' }) });
    } finally {
      setSaving(false);
    }
  }

  const needle = q.trim().toLowerCase();
  const matches = (name: string, code?: string | null) =>
    !needle || name.toLowerCase().includes(needle) || String(code ?? '').toLowerCase().includes(needle);
  const keep = (id: number) => {
    const st = statusOf(id);
    if (view === 'on') return !!lines[id]?.checked;
    if (view === 'changed') return st === 'added' || st === 'removed' || st === 'changed';
    return true;
  };

  /*
   * A type's products show when the type is selected OR one of them is ticked —
   * so a line already on the job can never vanish behind a type filter.
   */
  const groups = (catalog?.types ?? []).map((t) => ({
    type: t,
    items: (catalog?.products ?? []).filter((p) => p.service_type_id === t.service_type_id
      && (typesOn.has(t.service_type_id) || !!lines[p.service_id]?.checked)
      && matches(p.name, p.code) && keep(p.service_id)),
  })).filter((g) => g.items.length > 0);
  const foreign = (catalog?.foreign ?? []).filter((f) => matches(f.name, f.service_catg_name) && keep(f.service_id));

  const rowTone: Record<string, string> = {
    on: 'bg-success-tint/40', changed: 'bg-success-tint/40', added: 'bg-info-tint/60', removed: 'bg-urgent-tint/60', off: '',
  };
  const tag: Record<string, [string, string] | undefined> = {
    on: ['On job', 'border-success bg-success-tint text-success-strong'],
    added: ['Will be added', 'border-info bg-info-tint text-info-strong'],
    removed: ['Will be removed', 'border-urgent bg-urgent-tint text-urgent-strong'],
    changed: ['Qty changed', 'border-warning bg-warning-tint text-warning-strong'],
  };

  function renderRow(id: number, name: string, sub: string | null, unitClient: number | null, unitTx: number | null) {
    const line = lines[id] ?? { checked: false, qty: 1 };
    const st = statusOf(id);
    const t = tag[st];
    const client = line.checked && unitClient != null ? unitClient * line.qty : null;
    const tx = line.checked && unitTx != null ? unitTx * line.qty : null;
    const margin = unitClient ? Math.round(((Number(unitClient) - Number(unitTx ?? 0)) / Number(unitClient)) * 1000) / 10 : null;
    return (
      <tr key={id} className={`border-b ${rowTone[st]}`}>
        <td className="px-3 py-1.5">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={line.checked}
            disabled={saving}
            aria-label={`Select ${name}`}
            onChange={(e) => setLine(id, { checked: e.target.checked })}
          />
        </td>
        <td className="px-2 py-1.5">
          <span className={`font-medium ${st === 'removed' ? 'text-urgent-strong line-through' : ''}`}>{name}</span>
          {t && <span className={`ml-2 inline-block rounded-full border px-1.5 text-xs font-medium ${t[1]}`}>{t[0]}</span>}
          {sub && <span className="block text-xs text-muted-foreground">{sub}</span>}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">{unitClient == null ? '—' : inr(Number(unitClient))}</td>
        <td className="px-2 py-1.5 text-right">
          {line.checked ? (
            <span className="inline-flex items-center overflow-hidden rounded-md border">
              <button type="button" aria-label="Decrease quantity" disabled={saving || line.qty <= 1}
                onClick={() => setLine(id, { qty: Math.max(1, line.qty - 1) })}
                className="grid h-7 w-7 place-items-center hover:bg-muted disabled:text-muted-foreground">
                <Minus className="h-3.5 w-3.5" />
              </button>
              <input
                className="h-7 w-10 border-x bg-transparent text-center tabular-nums"
                inputMode="numeric"
                aria-label="Quantity"
                value={line.qty}
                disabled={saving}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n)) setLine(id, { qty: Math.min(100, Math.max(1, n)) });
                }}
              />
              <button type="button" aria-label="Increase quantity" disabled={saving || line.qty >= 100}
                onClick={() => setLine(id, { qty: Math.min(100, line.qty + 1) })}
                className="grid h-7 w-7 place-items-center hover:bg-muted disabled:text-muted-foreground">
                <Plus className="h-3.5 w-3.5" />
              </button>
            </span>
          ) : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">{client == null ? '—' : inr(client)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">{tx == null ? '—' : inr(tx)}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">{margin == null || !line.checked ? '—' : `${margin.toFixed(1)}%`}</td>
      </tr>
    );
  }

  return (
    // eslint-disable-next-line no-restricted-syntax
    <Dialog open={open} onOpenChange={(o) => { if (!o) void requestClose(); }}>
      <DialogContent className="!max-w-5xl !max-h-[calc(100vh-48px)] flex flex-col !p-0 gap-0 overflow-hidden">
        <DialogHeader className="!mx-0 !mt-0 !mb-0 shrink-0 px-6 py-4">
          <DialogTitle>Edit Services · Job #{jobId}</DialogTitle>
        </DialogHeader>

        {loading && !catalog ? (
          <p className="p-6 text-sm text-muted-foreground">Loading the rate card…</p>
        ) : error && !catalog ? (
          <p className="p-6 text-sm text-urgent-strong">Could not load the rate card: {error}</p>
        ) : catalog ? (
          <>
            <div className="grid shrink-0 gap-3 border-b bg-muted/30 px-6 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Service category</p>
                {catalog.category ? (
                  <div className="flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium"
                    title="A job keeps its service category.">
                    <Lock className="h-3.5 w-3.5 text-muted-foreground" />{catalog.category.name}
                    <span className="ml-auto text-xs font-normal text-muted-foreground">fixed for this job</span>
                  </div>
                ) : (
                  /* No category on the job: pick it ONCE here; saving sets it and
                     it is fixed from then on. */
                  <SearchSelect
                    value={pickedCategory}
                    onChange={(v) => setPickedCategory(String(v || ''))}
                    options={(catalog.categories ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
                    placeholder="Pick the category (set once for this job)"
                  />
                )}
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Service types</p>
                <div className="flex flex-wrap gap-1.5">
                  {catalog.types.length === 0 && (
                    <span className="text-xs text-muted-foreground">{needsCategory ? 'Pick a category to see its types.' : 'No service types on this client’s rate card.'}</span>
                  )}
                  {catalog.types.map((t) => {
                    const on = typesOn.has(t.service_type_id);
                    const n = (catalog.products ?? []).filter((p) => p.service_type_id === t.service_type_id && lines[p.service_id]?.checked).length;
                    return (
                      <button
                        key={t.service_type_id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setTypesOn((prev) => {
                          const next = new Set(prev);
                          if (next.has(t.service_type_id)) next.delete(t.service_type_id); else next.add(t.service_type_id);
                          return next;
                        })}
                        className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-sidebar bg-sidebar text-sidebar-foreground' : 'bg-background text-muted-foreground hover:text-foreground'}`}
                      >
                        {t.name}{n > 0 ? ` · ${n}` : ''}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-6 py-2">
              <div className="relative min-w-[220px] flex-1">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products by name or code" className="pl-8" />
              </div>
              {(['all', 'on', 'changed'] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  title={v === 'all'
                    ? 'Every product in this category for this client'
                    : v === 'on' ? 'Only the products ticked on this job'
                      : 'Only what you have added, removed or changed quantity on — not saved yet'}
                  className={`rounded-full border px-2.5 py-1 text-xs ${view === v ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {v === 'all' ? 'All' : v === 'on' ? 'On this job' : 'Changed'}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="sticky top-0 z-[1] bg-background">
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="w-10 px-3 py-2" />
                    <th className="px-2 py-2 font-semibold">Product</th>
                    <th className="px-2 py-2 text-right font-semibold">Unit ₹</th>
                    <th className="px-2 py-2 text-right font-semibold">Qty</th>
                    <th className="px-2 py-2 text-right font-semibold">Client ₹</th>
                    <th className="px-2 py-2 text-right font-semibold">TX ₹</th>
                    <th className="px-3 py-2 text-right font-semibold">EF margin</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <GroupRows key={g.type.service_type_id} title={g.type.name} count={g.items.length}>
                      {g.items.map((p) => renderRow(p.service_id, p.name, p.code ?? null, p.unit_client, p.unit_tx))}
                    </GroupRows>
                  ))}
                  {foreign.length > 0 && (
                    <GroupRows title="Not in this job’s category — keep, or untick to remove" count={foreign.length} tone="warn">
                      {foreign.map((f) => renderRow(
                        f.service_id, f.name,
                        [f.service_catg_name, f.service_type_name].filter(Boolean).join(' · ') || null,
                        f.unit_client, f.unit_tx,
                      ))}
                    </GroupRows>
                  )}
                  {groups.length === 0 && foreign.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-6 py-8 text-center text-sm text-muted-foreground">
                        {needsCategory ? 'Pick the service category to load its products.'
                          : 'No products to show. Select a service type above, or clear the search.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-t bg-muted/30 px-6 py-3">
              <div className="text-sm">
                <p className="flex flex-wrap gap-x-4">
                  <span><b className="font-semibold">{ticked.length}</b> service{ticked.length === 1 ? '' : 's'}</span>
                  <span>Client <b className="font-semibold tabular-nums">{inr(totalClient)}</b></span>
                  <span>TX <b className="font-semibold tabular-nums">{inr(totalTx)}</b></span>
                  <span>EF margin <b className="font-semibold tabular-nums">{totalClient ? (((totalClient - totalTx) / totalClient) * 100).toFixed(1) : '0.0'}%</b></span>
                </p>
                <p className={`text-xs ${blocker && blocker !== 'No changes to save' ? 'text-urgent-strong' : 'text-muted-foreground'}`}>
                  {dirty
                    ? `Pending: ${[diff.added && `${diff.added} to add`, diff.changed && `${diff.changed} quantity change${diff.changed === 1 ? '' : 's'}`, diff.removed && `${diff.removed} to remove`].filter(Boolean).join(' · ')}`
                    : 'No unsaved changes'}
                  {blocker && blocker !== 'No changes to save' ? ` — ${blocker}` : ''}
                </p>
              </div>
              <div className="ml-auto flex gap-2">
                {/* Cancel leaves the editor (asking first if there are unsaved
                    changes). Save stands out once there is something to save:
                    a count on the label and a ring, so an edit made further up
                    the list is not left behind by a faded button. */}
                <Button variant="outline" onClick={() => { void requestClose(); }} disabled={saving}>Cancel</Button>
                <Button
                  onClick={save}
                  disabled={!!blocker || saving}
                  className={dirty && !blocker ? 'ring-2 ring-primary/40 ring-offset-2 ring-offset-background' : undefined}
                >
                  {saving ? 'Saving…' : dirty && !blocker
                    ? `Save changes (${diff.added + diff.changed + diff.removed})`
                    : 'Save changes'}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function GroupRows({ title, count, tone, children }: {
  title: string; count: number; tone?: 'warn'; children: React.ReactNode;
}) {
  return (
    <>
      <tr className={tone === 'warn' ? 'bg-warning-tint text-warning-strong' : 'bg-muted/50 text-muted-foreground'}>
        <td colSpan={7} className="px-3 py-1.5 text-xs font-semibold">
          {title}<span className="ml-2 font-normal">{count} product{count === 1 ? '' : 's'}</span>
        </td>
      </tr>
      {children}
    </>
  );
}
