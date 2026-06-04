'use client';

/*
 * Technician Mapping tab — assign technicians to (client × service_type).
 *
 * Backed by:
 *   GET /admin/clients/:clientId/tech-mapping/summary
 *        → per-service-type counts + top-6 city breakdown (cheap; mount cost)
 *   GET /admin/clients/:clientId/tech-mapping/by-service-type/:stId
 *        → full chip list for ONE row (lazy, fires on expand)
 *   GET /admin/clients/:clientId/tech-mapping/eligible      (picker)
 *   PUT /admin/clients/:clientId/tech-mapping               (replace-set per service_type)
 *
 * Perf design (why summary + lazy expand):
 *   - Old flow returned every (mapping × tech) row up front. On a big
 *     client (~163 service types × hundreds of techs) the payload hit
 *     10K+ rows and the tab took ~4.3s to mount.
 *   - New flow mounts with a single GROUP BY query (one row per
 *     service-type), so the wall-of-chips DOM cost and the BE row-blow-up
 *     both disappear from the critical path.
 *   - Chip detail is fetched on demand when the operator expands a row.
 *
 * UX design:
 *   - Intro banner up top explaining what this tab does — operators
 *     kept asking "what's this for?".
 *   - Each service-type renders as a collapsed disclosure row showing
 *     count + top cities. Click to expand → chips group by city.
 *   - Text search filters service-types by name (client-side).
 *   - Editing happens via the per-row "Edit Techs" button (unchanged).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Plus, Pencil, AlertCircle, Users, CheckCircle2, ShieldQuestion,
  ChevronRight, ChevronDown, Info, Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SearchSelect } from '@/components/ui/search-select';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, invalidateFetch, useDebouncedValue } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

type Mapping = {
  mapping_id: number;
  service_type_id: number;
  service_type_name: string | null;
  efr_id: number;
  efr_name: string | null;
  efr_no: string | null;
  efr_mobile: string | null;
  city_name: string | null;
  is_technician_verified: boolean;
  mapping_status: number | null;
};

type SummaryRow = {
  service_type_id: number;
  service_type_name: string | null;
  tech_count: number;
  city_breakdown: { city_name: string; count: number }[];
  other_cities_count: number;
};

type EligibleTech = {
  efr_id: number;
  efr_name: string | null;
  efr_no: string | null;
  city_name: string | null;
  is_technician_verified: boolean;
};

type ServiceType = { service_type_id: number; service_type_name: string };

type Props = {
  clientId: number;
  canEdit: boolean;
};

export function TechMappingTab({ clientId, canEdit }: Props) {
  const summaryKey = `/admin/clients/${clientId}/tech-mapping/summary`;
  const { data: summary, loading, error, refetch } = useFetch<SummaryRow[]>(summaryKey);
  const { data: types } = useFetchOnce<ServiceType[]>(`/shared/lookup/service-types`);

  const [editingTypeId, setEditingTypeId] = useState<number | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  // Search filter (debounced) over service-type name.
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 200);
  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return summary ?? [];
    return (summary ?? []).filter((s) =>
      (s.service_type_name ?? `#${s.service_type_id}`).toLowerCase().includes(q),
    );
  }, [summary, debouncedQuery]);

  const editingRow = editingTypeId
    ? (summary ?? []).find((s) => s.service_type_id === editingTypeId)
    : null;

  // Service-types not yet mapped — for the "Add Mapping" picker.
  const usedTypeIds = useMemo(
    () => new Set((summary ?? []).map((s) => s.service_type_id)),
    [summary],
  );
  const availableTypes = useMemo(
    () => (types ?? []).filter((t) => !usedTypeIds.has(t.service_type_id)),
    [types, usedTypeIds],
  );

  function toggleExpand(id: number) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function onSavedFromDialog() {
    invalidateFetch((k) =>
      k === summaryKey
      || k.startsWith(`/admin/clients/${clientId}/tech-mapping/by-service-type/`),
    );
    refetch();
  }

  const totalTypes = summary?.length ?? 0;
  const totalTechs = useMemo(
    () => (summary ?? []).reduce((sum, s) => sum + s.tech_count, 0),
    [summary],
  );

  return (
    <div className="pt-2 space-y-3">
      {/* Intro banner — operators kept asking what this tab does */}
      <div className="rounded border border-sky-200 bg-sky-50 p-2.5 text-xs text-sky-900 flex gap-2">
        <Info className="size-4 shrink-0 mt-0.5 text-sky-700" />
        <div className="space-y-0.5">
          <div className="font-medium">What is Tech Mapping?</div>
          <div className="text-sky-800/90">
            This list controls which Easyfixer technicians are approved to take jobs
            for each service type this client has subscribed to. The auto-allocation
            engine uses this list as the eligibility pool when assigning a tech to a
            new job. Click a row to see the technicians; use <span className="font-medium">Edit Techs</span> to change the set.
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Users className="size-3.5" />
          {loading
            ? 'Loading…'
            : `${totalTypes} service-type${totalTypes === 1 ? '' : 's'} mapped · ${totalTechs} tech assignment${totalTechs === 1 ? '' : 's'}`}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="size-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter service types…"
              className="h-8 pl-7 w-56 text-xs"
            />
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => setAddingNew(true)} disabled={!types || availableTypes.length === 0}>
              <Plus className="size-3.5 mr-1" /> Add Mapping
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}

      {loading && totalTypes === 0 && (
        <div className="space-y-1">
          {[0, 1, 2].map((i) => <div key={i} className="rounded border bg-card animate-pulse h-12" />)}
        </div>
      )}

      {!loading && totalTypes === 0 && (
        <div className="text-sm text-muted-foreground italic">
          No technicians mapped. {canEdit ? 'Click "Add Mapping" to assign technicians per service type.' : ''}
        </div>
      )}

      {!loading && totalTypes > 0 && filtered.length === 0 && (
        <div className="text-xs text-muted-foreground italic">
          No service types match "{debouncedQuery}".
        </div>
      )}

      <div className="space-y-1.5">
        {filtered.map((row) => (
          <SummaryRowCard
            key={row.service_type_id}
            row={row}
            clientId={clientId}
            isExpanded={expanded.has(row.service_type_id)}
            canEdit={canEdit}
            onToggle={() => toggleExpand(row.service_type_id)}
            onEdit={() => setEditingTypeId(row.service_type_id)}
          />
        ))}
      </div>

      {editingRow && (
        <TechPickerDialog
          clientId={clientId}
          serviceTypeId={editingRow.service_type_id}
          serviceTypeName={editingRow.service_type_name}
          onClose={() => setEditingTypeId(null)}
          onSaved={onSavedFromDialog}
        />
      )}

      {addingNew && (
        <AddMappingDialog
          clientId={clientId}
          availableTypes={availableTypes}
          onClose={() => setAddingNew(false)}
          onSaved={onSavedFromDialog}
        />
      )}
    </div>
  );
}

/* ─── Collapsed row (counts + city breakdown chip, expand to load) ── */

function SummaryRowCard({
  row, clientId, isExpanded, canEdit, onToggle, onEdit,
}: {
  row: SummaryRow;
  clientId: number;
  isExpanded: boolean;
  canEdit: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="rounded border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/30"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isExpanded
            ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
          {/*
            Always show the `service_type_id` as a chip alongside the
            name. Two different service_type_id rows in tbl_service_type
            can share the same `service_type_name` (e.g. multiple
            "1 - Furniture Unpack & Install/Assembly" rows differ only
            by id), which would otherwise render as visually-identical
            duplicate rows. The id chip disambiguates them so operators
            know they're editing distinct mapping sets.
          */}
          <span className="font-medium truncate">
            {row.service_type_name ?? `Service Type #${row.service_type_id}`}
          </span>
          <span className="text-[10px] font-mono shrink-0 px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground">
            #{row.service_type_id}
          </span>
          <span className="text-muted-foreground text-xs shrink-0">
            · {row.tech_count} tech{row.tech_count === 1 ? '' : 's'}
          </span>
        </div>
        <div className="hidden sm:flex items-center gap-1 flex-wrap justify-end max-w-[55%]">
          {row.city_breakdown.slice(0, 4).map((c) => (
            <span
              key={c.city_name}
              className="text-[10px] bg-slate-100 text-slate-700 border border-slate-200 rounded px-1.5 py-0.5"
            >
              {c.city_name} <span className="text-slate-500">· {c.count}</span>
            </span>
          ))}
          {(row.city_breakdown.length > 4 || row.other_cities_count > 0) && (
            <span className="text-[10px] text-muted-foreground">
              +{(row.city_breakdown.length - 4 > 0 ? row.city_breakdown.length - 4 : 0) + row.other_cities_count} more
            </span>
          )}
        </div>
        {canEdit && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onEdit(); } }}
            className="inline-flex items-center text-xs px-2 py-1 rounded border bg-background hover:bg-muted shrink-0 cursor-pointer"
          >
            <Pencil className="size-3.5 mr-1" /> Edit Techs
          </span>
        )}
      </button>
      {isExpanded && (
        <ExpandedChips clientId={clientId} serviceTypeId={row.service_type_id} totalCount={row.tech_count} />
      )}
    </div>
  );
}

function ExpandedChips({
  clientId, serviceTypeId, totalCount,
}: {
  clientId: number;
  serviceTypeId: number;
  totalCount: number;
}) {
  const key = `/admin/clients/${clientId}/tech-mapping/by-service-type/${serviceTypeId}`;
  const { data, loading, error } = useFetch<Mapping[]>(key);

  // Group chips by city for scannability.
  const byCity = useMemo(() => {
    const m = new Map<string, Mapping[]>();
    for (const r of data ?? []) {
      const k = r.city_name || '— No City —';
      const bucket = m.get(k) ?? [];
      bucket.push(r);
      m.set(k, bucket);
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [data]);

  if (loading && !data) {
    return (
      <div className="border-t px-3 py-2 text-xs text-muted-foreground">
        Loading {totalCount} technician{totalCount === 1 ? '' : 's'}…
      </div>
    );
  }
  if (error) {
    return (
      <div className="border-t px-3 py-2 text-xs text-red-600 flex items-center gap-1">
        <AlertCircle className="size-3.5" /> {error}
      </div>
    );
  }
  if ((data?.length ?? 0) === 0) {
    return (
      <div className="border-t px-3 py-2 text-xs text-muted-foreground italic">
        No technicians assigned.
      </div>
    );
  }
  return (
    <div className="border-t px-3 py-2 space-y-2">
      {byCity.map(([city, rows]) => (
        <div key={city}>
          <div className="text-[11px] font-medium text-muted-foreground mb-1">
            {city} <span className="text-muted-foreground/70">· {rows.length}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {rows.map((m) => (
              <span
                key={m.mapping_id}
                className="text-[11px] bg-sky-50 text-sky-800 border border-sky-200 rounded px-1.5 py-0.5 inline-flex items-center gap-1"
                title={`${m.efr_no ?? ''} · ${m.city_name ?? '—'}`}
              >
                {m.is_technician_verified
                  ? <CheckCircle2 className="size-2.5 text-emerald-600" />
                  : <ShieldQuestion className="size-2.5 text-amber-600" />}
                {m.efr_name ?? `#${m.efr_id}`}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Per-service-type picker (edit existing mapping) ─────────────── */

function TechPickerDialog({
  clientId, serviceTypeId, serviceTypeName, onClose, onSaved,
}: {
  clientId: number;
  serviceTypeId: number;
  serviceTypeName: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Load the current mapping set lazily — uses the same per-service-type
  // endpoint that powers the expand-row. Keeps the dialog open small.
  const currentKey = `/admin/clients/${clientId}/tech-mapping/by-service-type/${serviceTypeId}`;
  const { data: current } = useFetch<Mapping[]>(currentKey);

  const [city, setCity] = useState('');
  const [query, setQuery] = useState('');
  const [includeUnverified, setIncludeUnverified] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed `selected` once the current set arrives. Runs in an effect so
  // we never set state during render.
  useEffect(() => {
    if (!seeded && current) {
      setSelected(new Set(current.map((m) => m.efr_id)));
      setSeeded(true);
    }
  }, [seeded, current]);

  const eligibleKey = useMemo(() => {
    const p = new URLSearchParams();
    p.set('serviceTypeId', String(serviceTypeId));
    if (city.trim()) p.set('cityName', city.trim());
    if (query.trim()) p.set('query', query.trim());
    if (includeUnverified) p.set('includeUnverified', 'true');
    return `/admin/clients/${clientId}/tech-mapping/eligible?${p}`;
  }, [clientId, serviceTypeId, city, query, includeUnverified]);

  const { data: eligible, loading } = useFetch<EligibleTech[]>(eligibleKey);

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !saving });

  function toggle(efrId: number) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(efrId)) next.delete(efrId); else next.add(efrId);
      return next;
    });
  }

  async function onSave() {
    setSaving(true);
    try {
      await api.put<{ assigned: number }>(`/admin/clients/${clientId}/tech-mapping`, {
        serviceTypeId,
        efrIds: Array.from(selected),
      } as never);
      showToast({ variant: 'success', message: 'Tech mapping updated.' });
      onSaved();
      onClose();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Save failed.' });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Technicians — {serviceTypeName ?? `#${serviceTypeId}`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 pt-1">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label className="text-xs">Search By Name/Code</Label>
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. EFR-001 or name" />
            </div>
            <div>
              <Label className="text-xs">City</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Pune" />
            </div>
            <label className="flex items-end gap-1 text-xs pb-1.5">
              <input type="checkbox" checked={includeUnverified} onChange={(e) => setIncludeUnverified(e.target.checked)} />
              Include Unverified
            </label>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {selected.size} selected · {eligible?.length ?? 0} eligible
          </div>
          <div className="border rounded max-h-72 overflow-auto">
            {loading && (eligible?.length ?? 0) === 0 && (
              <div className="p-3 text-xs text-muted-foreground">Loading eligible technicians…</div>
            )}
            {!loading && (eligible?.length ?? 0) === 0 && (
              <div className="p-3 text-xs text-muted-foreground italic">No eligible technicians for these filters.</div>
            )}
            <ul className="divide-y">
              {(eligible ?? []).map((t) => {
                const checked = selected.has(t.efr_id);
                return (
                  <li key={t.efr_id} className={`px-2 py-1.5 flex items-center justify-between gap-2 ${checked ? 'bg-sky-50/50' : ''}`}>
                    <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(t.efr_id)}
                      />
                      <span className="text-sm truncate">{t.efr_name ?? `#${t.efr_id}`}</span>
                      {t.is_technician_verified
                        ? <CheckCircle2 className="size-3 text-emerald-600 shrink-0" />
                        : <ShieldQuestion className="size-3 text-amber-600 shrink-0" />}
                    </label>
                    <span className="text-[11px] text-muted-foreground shrink-0">
                      {t.efr_no ?? ''}{t.city_name ? ` · ${t.city_name}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Add new mapping (pick service_type first, then techs) ───────── */

function AddMappingDialog({
  clientId, availableTypes, onClose, onSaved,
}: {
  clientId: number;
  availableTypes: ServiceType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [serviceTypeId, setServiceTypeId] = useState<number>(0);
  const opts = availableTypes.map((t) => ({ value: t.service_type_id, label: t.service_type_name }));
  const guardedOpenChange = useFormDirtyGuard(onClose);

  // Once a service-type is picked, switch over to the picker UI inline.
  if (serviceTypeId > 0) {
    const stName = availableTypes.find((t) => t.service_type_id === serviceTypeId)?.service_type_name ?? null;
    return (
      <TechPickerDialog
        clientId={clientId}
        serviceTypeId={serviceTypeId}
        serviceTypeName={stName}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  }

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="!max-w-md">
        <DialogHeader>
          <DialogTitle>Add Service-Type Mapping</DialogTitle>
        </DialogHeader>
        <div className="pt-1 space-y-2">
          <Label className="text-xs">Service Type <span className="text-red-600">*</span></Label>
          <SearchSelect
            value={serviceTypeId || ''}
            onChange={(v) => setServiceTypeId(Number(v))}
            options={opts}
            placeholder="Pick a service type…"
            required
          />
          <div className="text-[11px] text-muted-foreground">
            Once selected, the eligible-tech picker opens.
          </div>
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
