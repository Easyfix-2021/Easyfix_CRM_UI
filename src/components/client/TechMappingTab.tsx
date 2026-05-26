'use client';

/*
 * Technician Mapping tab — assign technicians to (client × service_type).
 *
 * Backed by:
 *   GET /admin/clients/:clientId/tech-mapping            (current set)
 *   GET /admin/clients/:clientId/tech-mapping/eligible   (picker)
 *   PUT /admin/clients/:clientId/tech-mapping            (replace-set per service_type)
 *
 * Perf design:
 *   - Single GET to list current set; grouped client-side by service_type
 *     in a useMemo (no extra query for grouping).
 *   - Eligibility picker is on-demand: only fetches when the user opens
 *     the edit dialog (not on tab mount).
 *   - PUT replaces the whole tech set for ONE service_type — small,
 *     atomic, scopes cache invalidation tightly.
 *   - useFetchOnce on /service-types for the "Add new mapping" picker.
 *
 * UX design:
 *   - Group by service_type → card per group. Compact, scannable.
 *   - Each group's "Edit Techs" opens a dialog scoped to that group.
 *   - "Add Service-Type Mapping" button opens a separate dialog that
 *     picks the service_type first, then loads eligibility, then techs.
 *   - Eligibility picker shows verification badges so the operator
 *     sees who they're choosing at a glance.
 */

import { useMemo, useState } from 'react';
import { Plus, Pencil, AlertCircle, Users, CheckCircle2, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SearchSelect } from '@/components/ui/search-select';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, invalidateFetch } from '@/lib/hooks';

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
  const listKey = `/admin/clients/${clientId}/tech-mapping`;
  const { data, loading, error, refetch } = useFetch<Mapping[]>(listKey);
  const { data: types } = useFetchOnce<ServiceType[]>(`/shared/lookup/service-types`);

  // Group client-side by service_type — no extra fetch.
  const grouped = useMemo(() => {
    const byType = new Map<number, { service_type_id: number; service_type_name: string | null; rows: Mapping[] }>();
    for (const m of data ?? []) {
      const key = m.service_type_id;
      const bucket = byType.get(key) ?? {
        service_type_id: key,
        service_type_name: m.service_type_name,
        rows: [],
      };
      bucket.rows.push(m);
      byType.set(key, bucket);
    }
    // Stable sort by service_type_name.
    return Array.from(byType.values()).sort((a, b) =>
      (a.service_type_name ?? '').localeCompare(b.service_type_name ?? ''),
    );
  }, [data]);

  const [editingTypeId, setEditingTypeId] = useState<number | null>(null);
  const [addingNew, setAddingNew] = useState(false);

  const editingGroup = editingTypeId ? grouped.find((g) => g.service_type_id === editingTypeId) : null;

  // Service-types not yet mapped — used as options for "Add new" picker.
  const usedTypeIds = useMemo(() => new Set(grouped.map((g) => g.service_type_id)), [grouped]);
  const availableTypes = useMemo(
    () => (types ?? []).filter((t) => !usedTypeIds.has(t.service_type_id)),
    [types, usedTypeIds],
  );

  return (
    <div className="pt-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Users className="size-3.5" />
          {loading ? 'Loading…' : `${grouped.length} service-type${grouped.length === 1 ? '' : 's'} mapped`}
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setAddingNew(true)} disabled={!types || availableTypes.length === 0}>
            <Plus className="size-3.5 mr-1" /> Add Mapping
          </Button>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}

      {loading && grouped.length === 0 && (
        <div className="space-y-1">
          {[0, 1].map((i) => <div key={i} className="rounded border bg-card animate-pulse h-20" />)}
        </div>
      )}

      {!loading && grouped.length === 0 && (
        <div className="text-sm text-muted-foreground italic">
          No technicians mapped. {canEdit ? 'Click "Add Mapping" to assign technicians per service type.' : ''}
        </div>
      )}

      <div className="space-y-2">
        {grouped.map((g) => (
          <div key={g.service_type_id} className="rounded border bg-card p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="font-medium">
                {g.service_type_name ?? `Service Type #${g.service_type_id}`}
                <span className="text-muted-foreground text-xs ml-2">· {g.rows.length} tech{g.rows.length === 1 ? '' : 's'}</span>
              </div>
              {canEdit && (
                <Button size="sm" variant="secondary" onClick={() => setEditingTypeId(g.service_type_id)}>
                  <Pencil className="size-3.5 mr-1" /> Edit Techs
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {g.rows.map((m) => (
                <span
                  key={m.mapping_id}
                  className="text-[11px] bg-sky-50 text-sky-800 border border-sky-200 rounded px-1.5 py-0.5 inline-flex items-center gap-1"
                  title={`${m.efr_no ?? ''} · ${m.city_name ?? '—'}`}
                >
                  {m.is_technician_verified
                    ? <CheckCircle2 className="size-2.5 text-emerald-600" />
                    : <ShieldQuestion className="size-2.5 text-amber-600" />}
                  {m.efr_name ?? `#${m.efr_id}`}
                  {m.city_name && <span className="text-muted-foreground/70">· {m.city_name}</span>}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {editingGroup && (
        <TechPickerDialog
          clientId={clientId}
          serviceTypeId={editingGroup.service_type_id}
          serviceTypeName={editingGroup.service_type_name}
          currentEfrIds={editingGroup.rows.map((r) => r.efr_id)}
          onClose={() => setEditingTypeId(null)}
          onSaved={() => {
            invalidateFetch((k) => k === listKey);
            refetch();
          }}
        />
      )}

      {addingNew && (
        <AddMappingDialog
          clientId={clientId}
          availableTypes={availableTypes}
          onClose={() => setAddingNew(false)}
          onSaved={() => {
            invalidateFetch((k) => k === listKey);
            refetch();
          }}
        />
      )}
    </div>
  );
}

/* ─── Per-service-type picker (edit existing mapping) ─────────────── */

function TechPickerDialog({
  clientId, serviceTypeId, serviceTypeName, currentEfrIds, onClose, onSaved,
}: {
  clientId: number;
  serviceTypeId: number;
  serviceTypeName: string | null;
  currentEfrIds: number[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [city, setCity] = useState('');
  const [query, setQuery] = useState('');
  const [includeUnverified, setIncludeUnverified] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(currentEfrIds));
  const [saving, setSaving] = useState(false);

  // Eligibility request only fires when the dialog mounts (and on
  // filter changes). useFetch's key change triggers a refetch — but
  // we debounce the city/query at the call site via 250ms timeout.
  const eligibleKey = useMemo(() => {
    const p = new URLSearchParams();
    p.set('serviceTypeId', String(serviceTypeId));
    if (city.trim()) p.set('cityName', city.trim());
    if (query.trim()) p.set('query', query.trim());
    if (includeUnverified) p.set('includeUnverified', 'true');
    return `/admin/clients/${clientId}/tech-mapping/eligible?${p}`;
  }, [clientId, serviceTypeId, city, query, includeUnverified]);

  const { data: eligible, loading } = useFetch<EligibleTech[]>(eligibleKey);

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
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Technicians — {serviceTypeName ?? `#${serviceTypeId}`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 pt-1">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label className="text-xs">Search by name/code</Label>
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. EFR-001 or name" />
            </div>
            <div>
              <Label className="text-xs">City</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Pune" />
            </div>
            <label className="flex items-end gap-1 text-xs pb-1.5">
              <input type="checkbox" checked={includeUnverified} onChange={(e) => setIncludeUnverified(e.target.checked)} />
              Include unverified
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

  // Once a service-type is picked, switch over to the picker UI inline.
  if (serviceTypeId > 0) {
    const stName = availableTypes.find((t) => t.service_type_id === serviceTypeId)?.service_type_name ?? null;
    return (
      <TechPickerDialog
        clientId={clientId}
        serviceTypeId={serviceTypeId}
        serviceTypeName={stName}
        currentEfrIds={[]}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
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
