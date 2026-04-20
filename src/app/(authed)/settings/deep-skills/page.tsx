'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Plus, Pencil, Trash2, RotateCcw, Wrench, X as XIcon,
  Image as ImageIcon, ChevronLeft, ChevronRight, UploadCloud,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { SearchSelect } from '@/components/ui/search-select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { cn } from '@/lib/utils';

/*
 * Manage Deep Skills — Service Category → Service Type → Deep Skill → Options.
 *
 * Layout matches the legacy `qa.easyfix.in/easyfix/deepSkillTable` screen:
 *   - Filter row (category, type, search, status, apply/reset buttons)
 *   - Table of all skills (id, category, type, name, options, edit/status)
 *   - Add-New / Edit modal: dropdowns + name + image upload + description
 *     + chip-style Skill Options (Installation / Repair / Product Servicing
 *     presets + free-text custom).
 *
 * Backend (unchanged):
 *   GET    /api/admin/deep-skills?categoryId=&serviceTypeId=&includeInactive=
 *   POST   /api/admin/deep-skills
 *   PATCH  /api/admin/deep-skills/:id
 *   DELETE /api/admin/deep-skills/:id                      (soft delete)
 *   POST   /api/admin/deep-skills/:id/options
 *   PATCH  /api/admin/deep-skills/:id/options/:optionId
 *   DELETE /api/admin/deep-skills/:id/options/:optionId
 */

type DeepSkill = {
  deepskill_id: number;
  category_id: number;
  service_type_id: number;
  deepskill_name: string;
  deepskill_description: string | null;
  deepskill_image: string | null;
  status: boolean | number;
  inserted_on: string;
  category_name: string | null;
  service_type_name: string | null;
  option_count: number;
};

type Option = { id: number; skill_option: string; status: boolean | number };
type DeepSkillDetail = DeepSkill & { options: Option[] };

const PRESET_OPTIONS = ['Installation', 'Repair', 'Product Servicing'] as const;

export default function DeepSkillsSettingsPage() {
  const lk = useLookup();

  // ─── Filter state ─────────────────────────────────────────────────
  const [categoryId, setCategoryId] = useState<string>('');
  const [serviceTypeId, setServiceTypeId] = useState<string>('');
  const [search, setSearch] = useState('');
  // 'active' | 'inactive' | 'all' — matches the legacy "Active / Inactive / All" dropdown.
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active');

  const [skills, setSkills] = useState<DeepSkill[] | null>(null);
  const [loading, setLoading] = useState(false);

  /*
   * Pagination — client-side because the dataset is small (~370 rows in
   * production) and we already do client-side text search across all rows.
   * Page size matches the jobs list (PAGE_SIZE = 25) for visual consistency
   * across admin tables.
   */
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(0); // 0-indexed; 0 = first page

  // Editor modal
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorRecord, setEditorRecord] = useState<DeepSkill | null>(null);

  // Service types narrowed to the chosen category so the picker stays focused.
  const filteredServiceTypes = useMemo(() => {
    if (!categoryId) return lk.serviceTypes;
    return lk.serviceTypes.filter((t) => t.service_catg_id === Number(categoryId));
  }, [lk.serviceTypes, categoryId]);

  // Clear service-type when category changes so it can't dangle invalidly.
  useEffect(() => { setServiceTypeId(''); }, [categoryId]);

  async function loadSkills() {
    setLoading(true);
    try {
      const rows = await api.get<DeepSkill[]>('/admin/deep-skills', {
        categoryId: categoryId ? Number(categoryId) : undefined,
        serviceTypeId: serviceTypeId ? Number(serviceTypeId) : undefined,
        includeInactive: statusFilter === 'active' ? undefined : 'true',
      });
      setSkills(rows);
    } catch {
      setSkills([]);
    } finally { setLoading(false); }
  }
  useEffect(() => { loadSkills(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [categoryId, serviceTypeId, statusFilter]);

  // Client-side text search — covers name, category, service type.
  const filteredSkills = useMemo(() => {
    let rows = skills ?? [];
    if (statusFilter === 'inactive') rows = rows.filter((s) => !Number(s.status));
    if (statusFilter === 'active')   rows = rows.filter((s) => Number(s.status));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((s) =>
        s.deepskill_name.toLowerCase().includes(q) ||
        (s.category_name ?? '').toLowerCase().includes(q) ||
        (s.service_type_name ?? '').toLowerCase().includes(q)
      );
    }
    return rows;
  }, [skills, search, statusFilter]);

  // Reset to first page whenever the filter set or fetched data changes —
  // otherwise we'd land on a now-empty page (e.g. you're on page 4 of 5,
  // type a search that narrows to 12 rows; without reset the table looks
  // empty even though there's data to show).
  useEffect(() => { setPage(0); }, [search, statusFilter, categoryId, serviceTypeId, skills]);

  // Slice the filtered list to the current page window.
  const totalPages = Math.max(1, Math.ceil(filteredSkills.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const visibleSkills = useMemo(
    () => filteredSkills.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [filteredSkills, safePage, PAGE_SIZE]
  );

  function resetFilters() {
    setCategoryId(''); setServiceTypeId(''); setSearch(''); setStatusFilter('active');
  }

  function openCreate() {
    // Modal handles its own category/type selection — no longer requires the
    // page-level filter to be set first (legacy behaviour expected this).
    setEditorRecord({
      deepskill_id: 0,
      category_id: categoryId ? Number(categoryId) : 0,
      service_type_id: serviceTypeId ? Number(serviceTypeId) : 0,
      deepskill_name: '', deepskill_description: '', deepskill_image: '',
      status: 1, inserted_on: '', category_name: null, service_type_name: null, option_count: 0,
    });
    setEditorOpen(true);
  }
  function openEdit(s: DeepSkill) { setEditorRecord(s); setEditorOpen(true); }

  async function deactivate(s: DeepSkill) {
    if (!confirm(`Deactivate "${s.deepskill_name}"? Technicians already mapped to it keep their assignment; new selections won't offer it.`)) return;
    try {
      await api.delete(`/admin/deep-skills/${s.deepskill_id}`);
      loadSkills();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Deactivation failed');
    }
  }

  return (
    <div className="space-y-3">
      {/* Header — legacy "Add New" sits top-right, opposite the title */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Manage Deep Skills</h1>
          <p className="text-sm text-muted-foreground">
            Service Category → Service Type → Deep Skill → Options. Used for technician skill mapping.
          </p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="h-4 w-4 mr-1" /> Add New
        </Button>
      </div>

      {/* Filter strip — mirrors legacy layout */}
      <Card>
        <CardContent className="p-3">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
            <div className="md:col-span-3">
              <Label className="text-xs">Service Category</Label>
              <SearchSelect
                value={categoryId}
                onChange={(v) => setCategoryId(v)}
                options={lk.toOpts.serviceCategories.map((o) => ({ value: o.value, label: String(o.label) }))}
                placeholder="Select Service Category"
              />
            </div>
            <div className="md:col-span-3">
              <Label className="text-xs">Service Type</Label>
              <SearchSelect
                value={serviceTypeId}
                onChange={(v) => setServiceTypeId(v)}
                options={filteredServiceTypes.map((t) => ({ value: t.service_type_id, label: t.service_type_name }))}
                placeholder={categoryId ? 'Select Service Type' : 'Any'}
              />
            </div>
            <div className="md:col-span-3">
              <Label className="text-xs">Search</Label>
              <Input placeholder="Name, category, type…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs">Status</Label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="all">All</option>
              </select>
            </div>
            {/*
              * No "Apply filter" button — every dropdown + the search input auto-
              * trigger loadSkills() on change (server-driven filters via useEffect)
              * or recompute visibleSkills (client-side search). Reset stays because
              * clearing 4 fields one-by-one is annoying.
              */}
            <div className="md:col-span-1 flex justify-end">
              <Button size="sm" variant="outline" onClick={resetFilters} title="Reset filters">
                <RotateCcw className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Skill list — column order matches the legacy table screenshot */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Id</th>
                <th>Category Name</th>
                <th>Service Type</th>
                <th>Deep Skill Name</th>
                <th>Skill Options</th>
                <th className="text-center">Status</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">Loading…</td></tr>
              )}
              {!loading && visibleSkills.length === 0 && (
                <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">No deep skills match the filters</td></tr>
              )}
              {!loading && visibleSkills.map((s) => (
                <tr key={s.deepskill_id}>
                  <td className="text-xs text-muted-foreground">{s.deepskill_id}</td>
                  <td>{s.category_name ?? '—'}</td>
                  <td>{s.service_type_name ?? '—'}</td>
                  <td className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {s.deepskill_image && <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                      {s.deepskill_name}
                    </span>
                  </td>
                  <td>
                    <SkillOptionsCell skillId={s.deepskill_id} fallbackCount={s.option_count} />
                  </td>
                  <td className="text-center">
                    {Number(s.status)
                      ? <span className="inline-flex rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-medium">Active</span>
                      : <span className="inline-flex rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 text-xs font-medium">Inactive</span>}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button onClick={() => openEdit(s)}
                      className="text-primary hover:underline inline-flex items-center gap-1 text-xs mr-3"
                      title="Edit deep skill">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {Number(s.status) ? (
                      <button onClick={() => deactivate(s)}
                        className="text-destructive hover:underline inline-flex items-center gap-1 text-xs"
                        title="Deactivate">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Pager — same shape as the jobs list pager (Showing X–Y of Z + Prev/Next) */}
      {filteredSkills.length > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            Showing {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filteredSkills.length)} of {filteredSkills.length.toLocaleString()}
          </span>
          <Button variant="outline" size="sm" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            <ChevronLeft className="h-4 w-4" /> Prev
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            Page {safePage + 1} / {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      <DeepSkillEditor
        open={editorOpen}
        record={editorRecord}
        onClose={() => { setEditorOpen(false); setEditorRecord(null); }}
        onSaved={() => { setEditorOpen(false); setEditorRecord(null); loadSkills(); }}
      />
    </div>
  );
}

// ─── Skill options cell (lazy-loads on first render to keep list query light)
/*
 * The list endpoint only returns `option_count` (a cheap COUNT join). To show
 * the actual option labels in the table — like the legacy CRM does — we lazy-
 * load each row's detail on first paint. Cached per-skill so re-rendering the
 * table doesn't re-fetch.
 */
const optionsCache = new Map<number, string[]>();

function SkillOptionsCell({ skillId, fallbackCount }: { skillId: number; fallbackCount: number }) {
  const [opts, setOpts] = useState<string[] | null>(optionsCache.get(skillId) ?? null);
  useEffect(() => {
    let cancelled = false;
    if (optionsCache.has(skillId)) { setOpts(optionsCache.get(skillId)!); return; }
    api.get<DeepSkillDetail>(`/admin/deep-skills/${skillId}`).then((d) => {
      const labels = d.options.filter((o) => Number(o.status)).map((o) => o.skill_option);
      optionsCache.set(skillId, labels);
      if (!cancelled) setOpts(labels);
    }).catch(() => { if (!cancelled) setOpts([]); });
    return () => { cancelled = true; };
  }, [skillId]);

  if (opts === null) {
    return <span className="text-xs text-muted-foreground">{fallbackCount} option{fallbackCount === 1 ? '' : 's'}…</span>;
  }
  if (opts.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-0.5 text-sm leading-tight">
      {opts.map((o) => <span key={o}>{o}</span>)}
    </div>
  );
}

// ─── Editor modal (Add / Edit) ──────────────────────────────────────
/*
 * Single modal handles both create and edit. Image upload is inline (drag-drop
 * via the standard file input), Description is a textarea, Skill Options are
 * chip-style with the 3 legacy presets always visible + free-text custom add.
 *
 * Options are persisted to `/options` endpoints — for the create flow we
 * defer those calls until AFTER the deep skill itself is created (we need
 * the new ID). Edit flow saves them inline on add/remove.
 */
function DeepSkillEditor({
  open, record, onClose, onSaved,
}: {
  open: boolean; record: DeepSkill | null;
  onClose: () => void; onSaved: () => void;
}) {
  const lk = useLookup();
  const isEdit = !!(record && record.deepskill_id);

  const [f, setF] = useState({
    deepskill_name: '', deepskill_description: '', deepskill_image: '',
    category_id: '', service_type_id: '',
    status: 1 as 0 | 1,
  });
  // Local options buffer — applied to backend on save (or per-add for edit mode).
  const [options, setOptions] = useState<string[]>([]);
  const [customOpt, setCustomOpt] = useState('');
  const [imageUploading, setImageUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!record) {
      setF({ deepskill_name: '', deepskill_description: '', deepskill_image: '', category_id: '', service_type_id: '', status: 1 });
      setOptions([]); setCustomOpt(''); setErr(null);
      return;
    }
    setF({
      deepskill_name: record.deepskill_name || '',
      deepskill_description: record.deepskill_description || '',
      deepskill_image: record.deepskill_image || '',
      category_id: String(record.category_id || ''),
      service_type_id: String(record.service_type_id || ''),
      status: Number(record.status) ? 1 : 0,
    });
    setCustomOpt(''); setErr(null);
    // For edit, fetch current options so the chip list reflects DB truth.
    if (record.deepskill_id) {
      api.get<DeepSkillDetail>(`/admin/deep-skills/${record.deepskill_id}`)
        .then((d) => setOptions(d.options.filter((o) => Number(o.status)).map((o) => o.skill_option)))
        .catch(() => setOptions([]));
    } else {
      setOptions([]);
    }
  }, [record, open]);

  const filteredTypes = useMemo(() => {
    if (!f.category_id) return lk.serviceTypes;
    return lk.serviceTypes.filter((t) => t.service_catg_id === Number(f.category_id));
  }, [lk.serviceTypes, f.category_id]);

  function toggleOption(opt: string) {
    setOptions((prev) => prev.includes(opt) ? prev.filter((o) => o !== opt) : [...prev, opt]);
  }
  function addCustom() {
    const v = customOpt.trim();
    if (!v || options.includes(v)) { setCustomOpt(''); return; }
    setOptions((prev) => [...prev, v]);
    setCustomOpt('');
  }
  function removeOption(opt: string) {
    setOptions((prev) => prev.filter((o) => o !== opt));
  }

  async function handleImage(file: File | null) {
    if (!file) return;
    setImageUploading(true); setErr(null);
    try {
      // Same upload contract used elsewhere (UPLOAD_EASYFIXER_DOCS path).
      const fd = new FormData();
      fd.append('file', file);
      fd.append('category', 'easyfixer_documents');
      const res = await api.post<{ filename: string }>('/shared/files', fd);
      setF((s) => ({ ...s, deepskill_image: res.filename }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Upload failed');
    } finally { setImageUploading(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.category_id || !f.service_type_id || !f.deepskill_name.trim()) {
      setErr('Service Category, Service Type, and Deep Skill Name are required');
      return;
    }
    setSaving(true); setErr(null);
    try {
      const payload = {
        category_id: Number(f.category_id),
        service_type_id: Number(f.service_type_id),
        deepskill_name: f.deepskill_name.trim(),
        deepskill_description: f.deepskill_description || undefined,
        deepskill_image: f.deepskill_image || undefined,
        status: f.status,
      };
      let skillId: number;
      if (isEdit && record) {
        await api.patch(`/admin/deep-skills/${record.deepskill_id}`, payload);
        skillId = record.deepskill_id;
        // Reconcile options: fetch current, diff against draft, add new ones,
        // deactivate removed ones. Keeps the contract idempotent.
        const detail = await api.get<DeepSkillDetail>(`/admin/deep-skills/${skillId}`);
        const existingByName = new Map(detail.options.map((o) => [o.skill_option, o]));
        for (const newOpt of options) {
          const existing = existingByName.get(newOpt);
          if (!existing) {
            await api.post(`/admin/deep-skills/${skillId}/options`, { skill_option: newOpt });
          } else if (!Number(existing.status)) {
            await api.patch(`/admin/deep-skills/${skillId}/options/${existing.id}`, { status: 1 });
          }
        }
        for (const ex of detail.options) {
          if (Number(ex.status) && !options.includes(ex.skill_option)) {
            await api.patch(`/admin/deep-skills/${skillId}/options/${ex.id}`, { status: 0 });
          }
        }
      } else {
        const created = await api.post<{ deepskill_id: number }>('/admin/deep-skills', payload);
        skillId = created.deepskill_id;
        for (const opt of options) {
          await api.post(`/admin/deep-skills/${skillId}/options`, { skill_option: opt });
        }
      }
      // Bust the row's options cache so the table reflects the new options.
      optionsCache.delete(skillId);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent hideClose className="max-w-3xl">
        <DialogHeader>
          {/* Custom hero header — matches the legacy CRM teal banner */}
          <div className="-mx-6 -mt-6 mb-2 px-6 py-4 bg-gradient-to-r from-teal-500 to-teal-600 text-white rounded-t-lg flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-md bg-white/15 grid place-items-center">
                <Wrench className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-white text-lg leading-tight">Technician Deep Skill</DialogTitle>
                <div className="text-xs text-white/80 mt-0.5">Define specialized skills and expertise</div>
              </div>
            </div>
            <button type="button" onClick={onClose} className="rounded p-1 hover:bg-white/15">
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          {/* Top row — three dropdowns side-by-side, matches legacy */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Service Category</Label>
              <SearchSelect
                value={f.category_id}
                onChange={(v) => setF((s) => ({ ...s, category_id: v, service_type_id: '' }))}
                options={lk.toOpts.serviceCategories.map((o) => ({ value: o.value, label: String(o.label) }))}
                placeholder="Select Service Category"
              />
            </div>
            <div>
              <Label className="text-xs">Service Type</Label>
              <SearchSelect
                value={f.service_type_id}
                onChange={(v) => setF((s) => ({ ...s, service_type_id: v }))}
                options={filteredTypes.map((t) => ({ value: t.service_type_id, label: t.service_type_name }))}
                placeholder="Select Service Type"
                disabled={!f.category_id}
              />
            </div>
            <div>
              <Label className="text-xs">Status</Label>
              <select
                value={f.status}
                onChange={(e) => setF((s) => ({ ...s, status: Number(e.target.value) as 0 | 1 }))}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value={1}>Active</option>
                <option value={0}>Inactive</option>
              </select>
            </div>
          </div>

          {/* Name + image upload row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Deep Skill Service Name</Label>
              <Input
                value={f.deepskill_name}
                onChange={(e) => setF((s) => ({ ...s, deepskill_name: e.target.value }))}
                placeholder="Enter skill name…"
              />
            </div>
            <div>
              <Label className="text-xs">Skill Image</Label>
              {/* Click-to-upload box matches legacy "Upload Image" affordance */}
              <label className="flex items-center justify-center gap-2 h-9 rounded-md border border-dashed border-input bg-background px-3 text-sm cursor-pointer hover:bg-muted/40 transition-colors">
                <UploadCloud className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">
                  {imageUploading ? 'Uploading…' : (f.deepskill_image || 'Upload Image')}
                </span>
                <input type="file" accept="image/*" className="hidden"
                  onChange={(e) => handleImage(e.target.files?.[0] ?? null)} />
              </label>
            </div>
          </div>

          {/* Description */}
          <div>
            <Label className="text-xs">Deep Skill Description</Label>
            <textarea
              value={f.deepskill_description}
              onChange={(e) => setF((s) => ({ ...s, deepskill_description: e.target.value }))}
              placeholder="Describe the skill…"
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          {/* Skill Options — chip presets + custom add */}
          <div>
            <div className="flex items-center gap-1.5 text-sm font-medium mb-2 text-teal-700">
              <span>★</span> Skill Options
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              {PRESET_OPTIONS.map((opt) => {
                const active = options.includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => toggleOption(opt)}
                    className={cn(
                      'px-3 py-1.5 rounded-md border text-sm transition-colors',
                      active
                        ? 'bg-teal-50 border-teal-400 text-teal-800'
                        : 'bg-background hover:border-teal-300'
                    )}
                  >
                    {opt}
                  </button>
                );
              })}
              <div className="flex items-center gap-1">
                <Input
                  value={customOpt}
                  onChange={(e) => setCustomOpt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
                  placeholder="Add custom…"
                  className="w-44 h-9"
                />
                <Button type="button" size="sm" variant="outline" onClick={addCustom} disabled={!customOpt.trim()}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {/* Selected non-preset chips show below with × to remove */}
            {options.filter((o) => !PRESET_OPTIONS.includes(o as typeof PRESET_OPTIONS[number])).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {options.filter((o) => !PRESET_OPTIONS.includes(o as typeof PRESET_OPTIONS[number])).map((opt) => (
                  <span key={opt} className="inline-flex items-center gap-1 rounded bg-teal-50 border border-teal-300 text-teal-800 px-2 py-0.5 text-xs">
                    {opt}
                    <button type="button" onClick={() => removeOption(opt)} className="hover:bg-teal-100 rounded">
                      <XIcon className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {err && <div className="text-sm text-destructive">{err}</div>}

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-3 border-t">
            <Button type="button" variant="outline" onClick={onClose}>
              <XIcon className="h-4 w-4 mr-1" /> Cancel
            </Button>
            <Button type="submit" disabled={saving} className="bg-teal-600 hover:bg-teal-700">
              <Plus className="h-4 w-4 mr-1" /> {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Skill')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
