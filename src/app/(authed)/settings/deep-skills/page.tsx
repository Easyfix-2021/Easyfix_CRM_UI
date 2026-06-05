'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Plus, Pencil, Trash2, Wrench, X as XIcon,
  Image as ImageIcon, UploadCloud,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { SearchSelect } from '@/components/ui/search-select';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
// Shared table-footer pager + page-size dropdown. Mirrors the canonical
// usage in settings/manage-users/page.tsx so admin tables stay visually
// uniform across the CRM.
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
// Shared status pill — one shape across the CRM, no per-page colour drift.
import { StatusChip } from '@/components/ui/StatusChip';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { cn } from '@/lib/utils';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

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
  // deepskill_tag_words (2026-06-06): VARCHAR(255) per-skill
  // technician-visit tag(s). Max ~2 short phrases per ops convention.
  deepskill_tag_words: string | null;
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
  const { me } = useMe();
  const confirm = useConfirm();
  // Permission gating — `is{Entity}{Verb}` convention. Needs corresponding
  // menu_action rows seeded + assigned to Admin via Manage Roles.
  const can = actionFlags(me, ['isDeepSkillAddNew', 'isDeepSkillEdit']);

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
   * Page size is now operator-controlled via the shared TablePagination
   * footer (10 / 20 / 50 / All), matching the convention used by
   * manage-users / manage-roles. Default 10 keeps the initial view dense.
   */
  const [page, setPage] = useState(0); // 0-indexed; 0 = first page
  const [pageSize, setPageSize] = useState<TablePageSize>(10);

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

  // Slice the filtered list to the current page window. `pageSizeToLimit`
  // returns the numeric limit, treating the 'all' sentinel as a very
  // large number — we cap at the list length so the slice is a no-op.
  const effectiveLimit = pageSize === 'all'
    ? Math.max(filteredSkills.length, 1)
    : pageSizeToLimit(pageSize);
  const totalPages = Math.max(1, Math.ceil(filteredSkills.length / effectiveLimit));
  const safePage = Math.min(page, totalPages - 1);
  const visibleSkills = useMemo(
    () => filteredSkills.slice(safePage * effectiveLimit, safePage * effectiveLimit + effectiveLimit),
    [filteredSkills, safePage, effectiveLimit]
  );

  function openCreate() {
    // Modal handles its own category/type selection — no longer requires the
    // page-level filter to be set first (legacy behaviour expected this).
    setEditorRecord({
      deepskill_id: 0,
      category_id: categoryId ? Number(categoryId) : 0,
      service_type_id: serviceTypeId ? Number(serviceTypeId) : 0,
      deepskill_name: '', deepskill_description: '', deepskill_image: '',
      deepskill_tag_words: null,
      status: 1, inserted_on: '', category_name: null, service_type_name: null, option_count: 0,
    });
    setEditorOpen(true);
  }
  function openEdit(s: DeepSkill) { setEditorRecord(s); setEditorOpen(true); }

  async function deactivate(s: DeepSkill) {
    const ok = await confirm({
      title: `Deactivate "${s.deepskill_name}"?`,
      description: 'Technicians already mapped to it keep their assignment; new selections won\'t offer it.',
      confirmLabel: 'Deactivate',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.delete(`/admin/deep-skills/${s.deepskill_id}`);
      showToast({ variant: 'success', message: 'Deep Skill Deactivated' });
      loadSkills();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Deactivation failed' });
    }
  }

  return (
    <div className="space-y-3">
      {/* Header — primary CTA sits top-right, opposite the title */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Manage Deep Skills</h1>
        </div>
        {can.isDeepSkillAddNew && (
          <div className="flex items-center gap-2">
            {/*
             * Upload Excel — opens the dedicated bulk-upload page where
             * operators pick an .xlsx, get a dry-run preview of parsed
             * rows + per-row status, then commit. Gated on the same
             * action flag as Add Deep Skill (no separate permission).
             */}
            <Link href="/settings/deep-skills/upload">
              <Button variant="outline" size="sm">
                <UploadCloud className="h-4 w-4 mr-1" /> Upload Excel
              </Button>
            </Link>
            <Button onClick={openCreate} size="sm">
              <Plus className="h-4 w-4 mr-1" /> Add Deep Skill
            </Button>
          </div>
        )}
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
            <div className="md:col-span-3">
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
             * No "Apply filter" / "Reset" buttons — every dropdown + the
             * search input auto-trigger loadSkills() on change (server-driven
             * filters via useEffect) or recompute visibleSkills (client-side
             * search). Clearing a filter is a single dropdown change; the
             * Reset shortcut was removed 2026-06-05 per ops feedback as
             * unnecessary chrome.
             */}
          </div>
        </CardContent>
      </Card>

      {/* Skill list — column order matches the legacy table screenshot.
          Pagination band lives inside the Card so the table + pager share
          one visual frame (matches manage-users / manage-roles). */}
      <Card>
        <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="data-table">
            {/*
              * Column-header widths (2026-06-06): every <th> gets
              * `whitespace-nowrap` so multi-word headers like "Category
              * Name" / "Service Type" / "Deep Skill Name" / "Skill
              * Options" stay on a single line. The parent CardContent
              * wraps the table in `overflow-x-auto`, so if the total
              * column width exceeds the viewport the table picks up a
              * horizontal scrollbar instead of wrapping headers (which
              * was the previous failure mode at narrow widths).
              */}
            <thead>
              <tr>
                <th className="whitespace-nowrap">Id</th>
                <th className="whitespace-nowrap">Category Name</th>
                <th className="whitespace-nowrap">Service Type</th>
                <th className="whitespace-nowrap">Deep Skill Name</th>
                <th className="whitespace-nowrap">Skill Options</th>
                <th className="whitespace-nowrap text-center">Status</th>
                <th className="whitespace-nowrap text-right">Action</th>
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
                      ? <StatusChip tone="emerald">Active</StatusChip>
                      : <StatusChip tone="slate">Inactive</StatusChip>}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {can.isDeepSkillEdit ? (
                      <>
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
                      </>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">view-only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
          {/* Shared pagination footer — Show: [N▾] | « ‹ page / totalPages › » */}
          <div className="px-3 py-2 border-t">
            <TablePagination
              page={safePage}
              pageSize={pageSize}
              total={filteredSkills.length}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </div>
        </CardContent>
      </Card>

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
    deepskill_tag_words: '',
    category_id: '', service_type_id: '',
    status: 1 as 0 | 1,
  });
  // Local options buffer — applied to backend on save (or per-add for edit mode).
  const [options, setOptions] = useState<string[]>([]);
  const [customOpt, setCustomOpt] = useState('');
  const [imageUploading, setImageUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Pending-upload buffer (2026-06-05): in Add mode the skill doesn't
  // exist yet, so we can't upload the image immediately (the BE endpoint
  // needs the deepskill_id to mint the `Skills/Skill_<id>_<seq>` key).
  // Stash the picked File here and POST it after create() resolves.
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !saving });

  useEffect(() => {
    if (!record) {
      setF({ deepskill_name: '', deepskill_description: '', deepskill_image: '', deepskill_tag_words: '', category_id: '', service_type_id: '', status: 1 });
      setOptions([]); setCustomOpt(''); setErr(null);
      setPendingImageFile(null);
      return;
    }
    setF({
      deepskill_name: record.deepskill_name || '',
      deepskill_description: record.deepskill_description || '',
      deepskill_image: record.deepskill_image || '',
      deepskill_tag_words: record.deepskill_tag_words || '',
      category_id: String(record.category_id || ''),
      service_type_id: String(record.service_type_id || ''),
      status: Number(record.status) ? 1 : 0,
    });
    setCustomOpt(''); setErr(null);
    setPendingImageFile(null);
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

  /*
   * Image picker handler (2026-06-05).
   *
   * Routes to the new `POST /admin/deep-skills/:id/image` endpoint
   * which stores the file at `Skills/Skill_<id>_<seq>` in S3 (per the
   * ops-confirmed key convention) and patches `tbl_deepskill.deepskill_image`
   * with the S3 key. Replaces the previous /shared/files indirection
   * which stored under the generic `easyfixer_documents` category.
   *
   * Two paths:
   *   - Edit mode: skill_id is known → upload immediately, reflect new key.
   *   - Add mode: skill_id doesn't exist yet → stash the File in
   *     `pendingImageFile` and let submit() POST it AFTER create()
   *     returns the new id.
   */
  async function handleImage(file: File | null) {
    if (!file) return;
    setErr(null);
    if (!isEdit || !record?.deepskill_id) {
      // Add mode — defer until after the skill is created.
      setPendingImageFile(file);
      // Show the local filename in the picker label as a "ready to upload"
      // hint; the real S3 key replaces it after submit succeeds.
      setF((s) => ({ ...s, deepskill_image: file.name }));
      return;
    }
    setImageUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.post<{ image: string }>(`/admin/deep-skills/${record.deepskill_id}/image`, fd);
      setF((s) => ({ ...s, deepskill_image: res.image }));
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
        deepskill_tag_words: f.deepskill_tag_words || undefined,
        // deepskill_image: only forward when it looks like a canonical
        // S3 key, NOT when it's the local-file placeholder name we
        // stashed during a pending Add-mode upload. Local placeholders
        // get replaced by the real key after the post-create upload
        // step runs below.
        deepskill_image: (f.deepskill_image && f.deepskill_image.startsWith('Skills/'))
          ? f.deepskill_image
          : undefined,
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
      // Deferred image upload (Add-mode tail). The skill row now exists
      // and has an id, so the `Skills/Skill_<id>_<seq>` key can be
      // minted. Best-effort: if the upload fails, the skill itself is
      // already saved — log to the operator via setErr but don't roll
      // back the create.
      if (pendingImageFile) {
        try {
          const fd = new FormData();
          fd.append('file', pendingImageFile);
          await api.post(`/admin/deep-skills/${skillId}/image`, fd);
        } catch (upErr) {
          // Surface a non-fatal warning. The skill saved; image didn't.
          setErr(`Skill saved. Image upload failed: ${upErr instanceof ApiError ? upErr.message : 'unknown error'}`);
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
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-3xl">
        {/*
         * Header (2026-06-05): switched from a custom teal banner +
         * custom X button to the platform-standard `DialogHeader` band.
         * `DialogHeader` itself paints the dark-slate gradient + sky-500
         * accent underline globally (see src/components/ui/dialog.tsx
         * line ~318), and `DialogContent` ships a visible-on-slate close
         * X automatically when `hideClose` is omitted (line ~277).
         * Convention sourced from CLAUDE.md modal-header rule + applied
         * uniformly across the CRM.
         *
         * `pr-10` on the inner cluster gives the title room to clear the
         * top-right X button (`absolute right-3 top-3 h-7 w-7`) so the
         * text never visually collides with the close affordance.
         */}
        <DialogHeader>
          <div className="flex items-center gap-3 pr-10">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white/15 ring-1 ring-white/20">
              <Wrench className="h-4 w-4 text-white" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base leading-tight">Technician Deep Skill</DialogTitle>
              <div className="text-xs text-slate-200/80 mt-0.5">Define specialized skills and expertise</div>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          {/*
           * Top row (2026-06-05). Two dropdowns + (Edit mode only) a
           * right-aligned Active/Inactive Switch. The Status control is
           * intentionally absent in Add mode because every new skill
           * defaults to active (status=1 on the BE) — operators don't
           * need a separate toggle just to confirm a sane default. In
           * Edit mode the Switch is the primary affordance to flip a
           * live skill on/off (replaces the previous Active/Inactive
           * dropdown, which UX-wise reads as a static value rather
           * than a toggleable state).
           */}
          <div className="flex flex-col md:flex-row md:items-end gap-3">
            <div className="flex-1 min-w-0">
              <Label className="text-xs">Service Category</Label>
              <SearchSelect
                value={f.category_id}
                onChange={(v) => setF((s) => ({ ...s, category_id: v, service_type_id: '' }))}
                options={lk.toOpts.serviceCategories.map((o) => ({ value: o.value, label: String(o.label) }))}
                placeholder="Select Service Category"
              />
            </div>
            <div className="flex-1 min-w-0">
              <Label className="text-xs">Service Type</Label>
              <SearchSelect
                value={f.service_type_id}
                onChange={(v) => setF((s) => ({ ...s, service_type_id: v }))}
                options={filteredTypes.map((t) => ({ value: t.service_type_id, label: t.service_type_name }))}
                placeholder="Select Service Type"
                disabled={!f.category_id}
              />
            </div>
            {isEdit && (
              <div className="flex flex-col items-end shrink-0 pb-1">
                <Label className="text-xs">Status</Label>
                <div className="h-9 flex items-center gap-2">
                  <Switch
                    checked={f.status === 1}
                    onCheckedChange={(next) => setF((s) => ({ ...s, status: (next ? 1 : 0) as 0 | 1 }))}
                    ariaLabel="Toggle deep skill active"
                  />
                  <span className={cn(
                    'text-xs font-medium tabular-nums select-none',
                    f.status === 1 ? 'text-emerald-700' : 'text-slate-500',
                  )}>
                    {f.status === 1 ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>
            )}
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

          {/* Tag Words — short reminder(s) shown to the technician
              when they accept the job (e.g. "Carry drain snake &
              plunger" / "Carry DVR login credentials"). Max ~2 tags
              per ops convention; VARCHAR(255) on the BE so the
              textarea is single-line. */}
          <div>
            <Label className="text-xs">Technician Tag Words</Label>
            <Input
              value={f.deepskill_tag_words}
              onChange={(e) => setF((s) => ({ ...s, deepskill_tag_words: e.target.value.slice(0, 255) }))}
              placeholder="What should the technician keep in mind? (max ~2 short tags)"
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

          {/* Footer (2026-06-05): icon-free buttons per ops feedback —
              the X on Cancel and the + on Add/Save were visual noise
              given the words alone already communicate intent. */}
          <div className="flex justify-end gap-2 pt-3 border-t">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Skill')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
