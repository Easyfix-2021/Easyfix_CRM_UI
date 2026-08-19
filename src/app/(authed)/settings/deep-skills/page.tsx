'use client';

import { useEffect, useMemo, useState } from 'react';

/*
 * Mapped-easyfixer count cache (2026-06-08, 30s TTL). Mirrors the
 * aggregateCache pattern on the Manage Easyfixers list page. Counts
 * only meaningfully change when an operator edits a tech's option
 * mappings — rare enough that 30s of staleness is acceptable, and
 * the cache evaporates on any page refresh anyway.
 *
 * Module-scope so the cache survives modal open/close cycles. Keyed
 * by deepskill_id (the row's PK). Visible-page IDs are split into
 * cached + missing on every loadSkills() call; only the missing
 * IDs are POSTed to the side endpoint.
 */
const MAPPED_COUNT_CACHE_TTL_MS = 30_000;
const mappedCountCache = new Map<number, { count: number; at: number }>();

function readMappedCountsFromCache(ids: number[]): {
  cached: Array<{ deepskill_id: number; count: number }>;
  missing: number[];
} {
  const now = Date.now();
  const cached: Array<{ deepskill_id: number; count: number }> = [];
  const missing: number[] = [];
  for (const id of ids) {
    const hit = mappedCountCache.get(id);
    if (hit && now - hit.at < MAPPED_COUNT_CACHE_TTL_MS) {
      cached.push({ deepskill_id: id, count: hit.count });
    } else {
      missing.push(id);
    }
  }
  return { cached, missing };
}

function writeMappedCountsToCache(rows: Array<{ deepskill_id: number; count: number }>): void {
  const at = Date.now();
  for (const r of rows) {
    mappedCountCache.set(r.deepskill_id, { count: r.count, at });
  }
}
import Link from 'next/link';
import {
  Plus, Pencil, XCircle, Wrench, X as XIcon,
  Image as ImageIcon, UploadCloud, Users, RefreshCw, Sparkles,
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
import { IconButton } from '@/components/ui/icon-button';
// Shared animated info strip — used for the "image will be auto-generated"
// notice in the deep-skill editor footer. Same component the Profile Update
// form uses for inline progress hints.
import { AnimatedLoadingBar } from '@/components/ui/animated-loading-bar';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { cn } from '@/lib/utils';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
// Shared 3-click sort cycle (asc → desc → none) + clickable header.
// Same primitives Manage Clients / Manage Users drive their tables with.
import { cycleSort, SortHeader, type SortDir } from '@/lib/use-sort';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { DeepSkillMappedEasyfixersModal } from '@/components/deep-skill/DeepSkillMappedEasyfixersModal';
import { DownloadButton } from '@/components/ui/download-button';
import { downloadXlsx } from '@/lib/download-xlsx';

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
  // Active option labels joined by '||' (e.g. "Installation||Repair"),
  // or null when the skill has no active options. Additive list-endpoint
  // field (2026-06-12) that replaces the old per-row detail fetch in
  // SkillOptionsCell — no more N+1 on page size 'All'.
  option_labels: string | null;
  // Image auto-generation status (2026-06-12). Surfaced from the list
  // endpoint so the row can render a "Generating…" / "Image Failed"
  // chip + Retry button without an extra round-trip. null = no auto-gen
  // ever attempted (manual upload OR complete + cleared).
  image_gen_status?: 'pending' | 'failed' | null;
  image_gen_attempted_at?: string | null;
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

  // Download (2026-06-10) — emerald CTA in the header, mirrors the
  // shared DownloadButton pattern used by jobs/reports pages. Always
  // exports the full catalogue; FE filters don't narrow the download.
  const [downloading, setDownloading] = useState(false);
  async function handleDownload() {
    setDownloading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await downloadXlsx({
        url: '/admin/deep-skills/download',
        filename: `deep-skills-${today}.xlsx`,
      });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed' });
    } finally { setDownloading(false); }
  }

  // Mapped Easyfixers modal — read-only listing of every easyfixer
  // mapped to ANY option under the chosen deep skill. Open via the
  // Users icon in the Action cell of each row.
  const [mappedFor, setMappedFor] = useState<{ id: number; name: string } | null>(null);

  /*
   * Mapped-easyfixer counts (2026-06-08). Powers the new aggregate
   * column. Map<deepskill_id, count>. Populated lazily as pages of
   * the list become visible; backed by the module-level 30s cache
   * so re-visiting an already-seen page hits synchronously.
   */
  const [mappedCounts, setMappedCounts] = useState<Map<number, number>>(new Map());

  // Service types narrowed to the chosen category so the picker stays focused.
  // Only display === 2 types are deep-skill types; non-deep-skill types must never appear here.
  // Compare via Number() on BOTH the display flag and the category id so a
  // string-typed value from the lookup/SearchSelect (e.g. "2" / "21") still
  // matches — a `===` against a string silently returns nothing.
  const filteredServiceTypes = useMemo(() => {
    if (!categoryId) return lk.serviceTypes.filter((t) => Number(t.display) === 2);
    return lk.serviceTypes.filter((t) => Number(t.service_catg_id) === Number(categoryId) && Number(t.display) === 2);
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
    } catch (e) {
      setSkills([]);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed to Load Deep Skills' });
    } finally { setLoading(false); }
  }
  useEffect(() => { loadSkills(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [categoryId, serviceTypeId, statusFilter]);

  /*
   * Image-gen polling (2026-06-12). When any row in the list is in the
   * 'pending' state (BE is still calling DALL-E in the background), poll
   * loadSkills() every 10s until none remain. Lightweight refetch —
   * already cached on the BE side and only kicks in transiently. The
   * effect tears down its interval the moment the row's status flips
   * to null (success) or 'failed', and on unmount.
   *
   * Implementation note: we drive off `skills` (the raw fetched list)
   * rather than `filteredSkills` so a user-set status/search filter
   * can't accidentally hide a 'pending' row and stop the poll prematurely.
   */
  useEffect(() => {
    const hasPending = (skills ?? []).some((r) => r.image_gen_status === 'pending');
    if (!hasPending) return;
    const id = setInterval(() => { loadSkills(); }, 10_000);
    return () => clearInterval(id);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [skills]);

  /*
   * Manual retry for a failed image generation. POSTs to the regenerate
   * endpoint; on success we refetch so the row flips back to 'pending'
   * (the polling effect above then takes over). 409 = already in flight,
   * silently noop. Other errors toast through.
   */
  async function retryImageGen(skillId: number) {
    try {
      await api.post(`/admin/deep-skills/${skillId}/regenerate-image`, {});
      showToast({ variant: 'success', message: 'Image Generation Restarted' });
      loadSkills();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // 409 = already in flight. Surface as a success-tone confirmation
        // ("nothing to do, it's running") rather than an error tone —
        // the toast component only supports success/error/loading.
        showToast({ variant: 'success', message: 'Already Generating' });
        loadSkills();
        return;
      }
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Retry failed' });
    }
  }

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

  /*
   * Client-side column sort (2026-06-15). 3-click cycle (asc → desc →
   * none) over the already-loaded list, via the shared `cycleSort`
   * helper + `<SortHeader>` — same primitives Manage Clients uses.
   * `useSort<T>` (the keyof-T hook) doesn't fit here because two
   * columns sort on DERIVED values rather than raw row fields:
   *   - 'options'  → active-option count parsed from `option_labels`
   *   - 'mapped'   → the per-row count held in the external
   *                  `mappedCounts` Map, not on the row object
   * so we own the comparator and map each SortKey to its sort value.
   * Sorting runs BEFORE pagination so it orders the whole filtered
   * set, not just the visible page.
   */
  type SortKey = 'deepskill_id' | 'category_name' | 'service_type_name'
    | 'deepskill_name' | 'options' | 'mapped' | 'status';
  const [sortBy, setSortBy] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  function onSortToggle(col: SortKey) {
    const next = cycleSort<SortKey>(col, { sortBy, sortDir });
    setSortBy(next.sortBy);
    setSortDir(next.sortDir);
  }

  // Resolve a row to its comparable value for the active sort column.
  // Numeric columns return numbers (sorted numerically); text columns
  // return strings (locale-compared, numeric-aware). 'mapped' reads the
  // external counts Map — an undefined count (still loading) sorts last
  // in asc by treating it as -1 so loaded rows surface first.
  function sortValue(s: DeepSkill, key: SortKey): number | string {
    switch (key) {
      case 'deepskill_id': return s.deepskill_id;
      case 'options':      return s.option_labels ? s.option_labels.split('||').length : 0;
      case 'mapped':       return mappedCounts.get(s.deepskill_id) ?? -1;
      case 'status':       return Number(s.status);
      case 'category_name':     return s.category_name ?? '';
      case 'service_type_name': return s.service_type_name ?? '';
      case 'deepskill_name':    return s.deepskill_name ?? '';
    }
  }

  const sortedSkills = useMemo(() => {
    if (!sortBy) return filteredSkills;
    const arr = filteredSkills.slice();
    arr.sort((a, b) => {
      const av = sortValue(a, sortBy);
      const bv = sortValue(b, sortBy);
      const cmp = (typeof av === 'number' && typeof bv === 'number')
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
    // mappedCounts is intentionally a dep: re-sort once 'mapped' counts arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSkills, sortBy, sortDir, mappedCounts]);

  // Reset to first page only when the filter set changes — otherwise we'd
  // land on a now-empty page (e.g. you're on page 4 of 5, type a search
  // that narrows to 12 rows). Refetches of the same filter set (10s
  // image-gen poll, post-save/deactivate refresh) must NOT reset the page;
  // the safePage clamp below handles any shrink in row count.
  useEffect(() => { setPage(0); }, [search, statusFilter, categoryId, serviceTypeId]);

  // Slice the filtered list to the current page window. `pageSizeToLimit`
  // returns the numeric limit, treating the 'all' sentinel as a very
  // large number — we cap at the list length so the slice is a no-op.
  const effectiveLimit = pageSize === 'all'
    ? Math.max(filteredSkills.length, 1)
    : pageSizeToLimit(pageSize);
  const totalPages = Math.max(1, Math.ceil(filteredSkills.length / effectiveLimit));
  const safePage = Math.min(page, totalPages - 1);
  // Slice the SORTED list (sortedSkills === filteredSkills when no column
  // is active, so unsorted behaviour is unchanged). Counts/limits stay
  // driven off filteredSkills.length — identical length, no extra recompute.
  const visibleSkills = useMemo(
    () => sortedSkills.slice(safePage * effectiveLimit, safePage * effectiveLimit + effectiveLimit),
    [sortedSkills, safePage, effectiveLimit]
  );

  /*
   * Mapped-easyfixer counts fetch (2026-06-08). Triggered whenever
   * the visible page changes (pagination, filter narrowing, page-size
   * change). Splits the visible IDs into cached + missing via the
   * module-level 30s cache; for cached IDs, the count is merged into
   * local state synchronously, and only the missing IDs are POSTed.
   * Failure leaves the missing entries blank — the cell renders "—"
   * rather than throwing.
   */
  useEffect(() => {
    if (visibleSkills.length === 0) return;
    const ids = visibleSkills.map((s) => s.deepskill_id);
    const { cached, missing } = readMappedCountsFromCache(ids);

    // Apply cached counts synchronously — no flicker for re-visits.
    if (cached.length > 0) {
      setMappedCounts((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const c of cached) {
          if (next.get(c.deepskill_id) !== c.count) { next.set(c.deepskill_id, c.count); changed = true; }
        }
        // Bail when nothing changed — else this re-sorts sortedSkills (which
        // deps on mappedCounts) → new visibleSkills → re-runs this effect →
        // infinite loop (React error #185). Returning `prev` stops the cycle.
        return changed ? next : prev;
      });
    }
    if (missing.length === 0) return;

    let cancelled = false;
    // POST with a dynamic
    // `missing[]` body derived from a module-level cache. `useFetch` is
    // GET-only and keys on URL strings; this is a batched POST that
    // intentionally omits already-cached IDs from the request body —
    // a pattern that doesn't match the hook's single-key dedup model.
    // eslint-disable-next-line no-restricted-syntax
    void api.post<{ items: Array<{ deepskill_id: number; count: number }> }>(
      '/admin/deep-skills/mapped-easyfixer-counts',
      { deepSkillIds: missing },
    ).then((resp) => {
      if (cancelled) return;
      // The endpoint returns ONE row per skill that has at least one
      // mapping — skills with zero mappings are absent. Default the
      // missing IDs to 0 before merging the response so the cell
      // shows "0" instead of staying as a "…" placeholder.
      const zeroed = missing.map((id) => ({ deepskill_id: id, count: 0 }));
      const merged = [...zeroed, ...resp.items]; // resp.items wins via Map.set
      writeMappedCountsToCache(merged);
      setMappedCounts((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const r of merged) {
          if (next.get(r.deepskill_id) !== r.count) { next.set(r.deepskill_id, r.count); changed = true; }
        }
        return changed ? next : prev;
      });
    }).catch(() => { /* leave missing entries undefined */ });

    return () => { cancelled = true; };
  }, [visibleSkills]);

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
      option_labels: null,
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
        <div className="flex items-center gap-2">
          {/*
           * Download Deep Skills (2026-06-10) — full-catalogue XLSX
           * with category/type/options/image filename/status/created.
           * Visible to anyone who can see the page (no separate
           * action flag — read-only export).
           */}
          <DownloadButton
            onClick={handleDownload}
            downloading={downloading}
            label="Download Deep Skills"
            loadingLabel="Preparing…"
            title="Download all deep skills as an Excel file"
            className="h-9 px-3 text-sm"
          />
          {can.isDeepSkillAddNew && (
            <>
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
            </>
          )}
        </div>
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
              {/*
                * Sortable headers (2026-06-15). Each <SortHeader> drives the
                * shared 3-click cycle (asc → desc → none) via `onSortToggle`.
                * `align` applies the `!text-{left|right|center}` specificity
                * override required to beat `.data-table th/td` (per
                * feedback_data_table_alignment) — numeric/status columns are
                * right/center aligned to match their <td>s below. Action is a
                * plain <th> (nothing to sort by).
                */}
              <tr>
                <SortHeader col="deepskill_id" align="left" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Id</SortHeader>
                <SortHeader col="category_name" align="left" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Category Name</SortHeader>
                <SortHeader col="service_type_name" align="left" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Service Type</SortHeader>
                <SortHeader col="deepskill_name" align="left" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Deep Skill Name</SortHeader>
                {/* Sorts by active-option count (parsed from option_labels). */}
                <SortHeader col="options" align="left" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Skill Options</SortHeader>
                {/*
                  * Mapped Easyfixers count column (2026-06-08). Aggregate
                  * of distinct techs mapped to ANY option under this
                  * skill, via tbl_efr_deepskill_mapping. Populated by a
                  * side-endpoint POST keyed on the visible page's IDs;
                  * counts cached client-side for 30s. Clicking the count
                  * opens the same modal as the Users icon in Action.
                  * Sorting reads the same client-side counts Map; rows
                  * whose count hasn't loaded yet sort last in ascending.
                  */}
                <SortHeader col="mapped" align="right" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Mapped</SortHeader>
                <SortHeader col="status" align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Status</SortHeader>
                <th className="whitespace-nowrap text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {/* Keep existing rows visible during refetch — see manage-users for the rationale. */}
              {loading && visibleSkills.length === 0 && (
                <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">Loading…</td></tr>
              )}
              {!loading && visibleSkills.length === 0 && (
                <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">No deep skills match the filters</td></tr>
              )}
              {visibleSkills.map((s) => (
                <tr key={s.deepskill_id}>
                  <td className="text-xs text-muted-foreground">{s.deepskill_id}</td>
                  <td>{s.category_name ?? '—'}</td>
                  <td>{s.service_type_name ?? '—'}</td>
                  <td className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {s.deepskill_image && <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                      {s.deepskill_name}
                      {/*
                        * Image auto-gen status (2026-06-12).
                        *   - 'pending' → sky chip "Generating…"; the
                        *     page-level polling effect refetches every
                        *     10s until none remain, at which point this
                        *     chip naturally disappears.
                        *   - 'failed'  → rose chip + small icon button
                        *     calling POST /:id/regenerate-image. 409
                        *     (already in progress) is treated as a noop.
                        *   - null/undefined → render nothing (manual
                        *     upload or already complete).
                        */}
                      {s.image_gen_status === 'pending' && (
                        <StatusChip tone="sky" size="sm">Generating…</StatusChip>
                      )}
                      {s.image_gen_status === 'failed' && (
                        <>
                          <StatusChip tone="rose" size="sm">Image Failed</StatusChip>
                          <button
                            type="button"
                            onClick={() => retryImageGen(s.deepskill_id)}
                            className="text-muted-foreground hover:text-primary inline-flex items-center gap-1 text-xs"
                            title="Retry Image Generation"
                          >
                            <RefreshCw className="h-3 w-3" />
                            Retry
                          </button>
                        </>
                      )}
                    </span>
                  </td>
                  <td>
                    <SkillOptionsCell labels={s.option_labels ? s.option_labels.split('||') : []} />
                  </td>
                  <td className="text-right tabular-nums">
                    {/*
                      * Mapped count cell. Three states:
                      *  - undefined → still loading (fetch in flight or
                      *    cache miss without response yet) → render
                      *    a muted "…" placeholder so the cell doesn't
                      *    silently render "0" before the count lands
                      *  - 0          → render "0" (no techs mapped yet)
                      *  - >0         → render the count as a clickable
                      *    link that opens the same modal as the Users
                      *    icon in Action — saves the operator a click
                      */}
                    {(() => {
                      const c = mappedCounts.get(s.deepskill_id);
                      if (c === undefined) return <span className="text-muted-foreground">…</span>;
                      if (c === 0) return <span className="text-muted-foreground">0</span>;
                      return (
                        <button
                          type="button"
                          onClick={() => setMappedFor({ id: s.deepskill_id, name: s.deepskill_name })}
                          className="text-primary hover:underline font-medium"
                          title="View Mapped Easyfixers"
                        >
                          {c.toLocaleString('en-IN')}
                        </button>
                      );
                    })()}
                  </td>
                  <td className="text-center">
                    {Number(s.status)
                      ? <StatusChip tone="emerald">Active</StatusChip>
                      : <StatusChip tone="slate">Inactive</StatusChip>}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-0.5">
                      {/* View Mapped Easyfixers — read-only affordance, always
                          visible (no edit-permission gate). */}
                      <IconButton
                        icon={Users}
                        label="View Mapped Easyfixers"
                        intent="default"
                        onClick={() => setMappedFor({ id: s.deepskill_id, name: s.deepskill_name })}
                      />
                      {can.isDeepSkillEdit ? (
                        <>
                          <IconButton
                            icon={Pencil}
                            label="Edit Deep Skill"
                            intent="primary"
                            onClick={() => openEdit(s)}
                          />
                          {Number(s.status) ? (
                            <IconButton
                              icon={XCircle}
                              label="Deactivate"
                              intent="danger"
                              onClick={() => deactivate(s)}
                            />
                          ) : null}
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">view-only</span>
                      )}
                    </div>
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

      {/* Mapped Easyfixers — read-only modal opened from each row's
          Users icon. Mounts at page root so it overlays everything
          including the editor (defensive — they don't open together
          in practice). */}
      <DeepSkillMappedEasyfixersModal
        open={mappedFor != null}
        onClose={() => setMappedFor(null)}
        deepSkillId={mappedFor?.id ?? null}
        deepSkillName={mappedFor?.name ?? null}
      />
    </div>
  );
}

// ─── Skill options cell ─────────────────────────────────────────────
// Pure presentational — active option labels now arrive inline on the list
// row (`option_labels`, '||'-joined), so no per-row detail fetch is needed.
function SkillOptionsCell({ labels }: { labels: string[] }) {
  if (labels.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-0.5 text-sm leading-tight">
      {labels.map((o) => <span key={o}>{o}</span>)}
    </div>
  );
}

// ─── Editor modal (Add / Edit) ──────────────────────────────────────
/*
 * Single modal handles both create and edit. Image upload is inline (drag-drop
 * via the standard file input), Description is a textarea, Skill Options are
 * chip-style with the 3 legacy presets always visible + free-text custom add.
 *
 * Options: the create flow sends them inline in the POST payload (BE inserts
 * skill + options in one transaction); the edit flow reconciles them against
 * the `/options` endpoints on save.
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
  // AI image generation (2026-06-12). Blocks ~5-15s while DALL-E runs on
  // the BE; both add + edit modes are supported (see handleGenerate).
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Pending-upload buffer (2026-06-05): in Add mode the skill doesn't
  // exist yet, so we can't upload the image immediately (the BE endpoint
  // needs the deepskill_id to mint the `Skills/Skill_<id>_<seq>` key).
  // Stash the picked File here and POST it after create() resolves.
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);
  /*
   * Preview URL (2026-06-10). Two sources:
   *   - Edit mode w/ existing image → /image-url endpoint returns
   *     a short-TTL presigned S3 URL; rendered straight in <img>.
   *   - Add mode w/ a picked file → local FileReader object URL so
   *     operators see what they chose before the post-create upload.
   * `useEffect` revokes the object URL on cleanup when sourced
   * locally; presigned URLs need no cleanup (they're plain strings).
   */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /*
   * Lightbox (2026-06-10). The 80×80 preview tile is click-to-zoom —
   * tapping it opens a separate Dialog that renders the image at viewport
   * size so operators can verify orientation / content without leaving
   * the editor. `zoomedImage` holds the URL of whatever is currently being
   * shown enlarged (presigned S3 URL in Edit mode, blob: object URL in
   * Add mode); null means the lightbox is closed.
   */
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !saving });
  // Lightbox is read-only — no form state to guard, so isDirty:false
  // keeps the close path frictionless (Esc / overlay click / X close
  // immediately without a discard prompt).
  const guardedLightboxClose = useFormDirtyGuard(() => setZoomedImage(null), { isDirty: false });

  useEffect(() => {
    if (!record) {
      setF({ deepskill_name: '', deepskill_description: '', deepskill_image: '', deepskill_tag_words: '', category_id: '', service_type_id: '', status: 1 });
      setOptions([]); setCustomOpt(''); setErr(null);
      setPendingImageFile(null);
      setPreviewUrl(null);
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
    setPreviewUrl(null);
    // For edit, fetch current options so the chip list reflects DB truth.
    if (record.deepskill_id) {
      // Record-driven detail
      // hydrate inside the modal-open + record-changed effect; the response
      // is filtered/projected before going into local state (same transform
      // shape as the SkillOptionsCell sibling).
      // eslint-disable-next-line no-restricted-syntax
      api.get<DeepSkillDetail>(`/admin/deep-skills/${record.deepskill_id}`)
        .then((d) => setOptions(d.options.filter((o) => Number(o.status)).map((o) => o.skill_option)))
        .catch(() => setOptions([]));
      // 2026-06-10: load the existing image as a presigned-URL preview.
      // The BE endpoint mints a short-TTL S3 URL; we just drop it on an
      // <img src=…> without any auth header — same pattern as Notice
      // Board reads. If the column is empty or S3 isn't enabled, the
      // response `url` field is null and the preview row stays hidden.
      if (record.deepskill_image) {
        // Conditional
        // sub-fetch (only when image column is non-empty) chained off the
        // outer record-change effect. Best-effort: failure silently leaves
        // preview unset. useFetch's enabled flag would require lifting
        // the inner condition into a separate hook call site.
        // eslint-disable-next-line no-restricted-syntax
        api.get<{ image: string; url: string | null }>(
          `/admin/deep-skills/${record.deepskill_id}/image-url`,
        ).then((r) => { if (r.url) setPreviewUrl(r.url); })
          .catch(() => { /* preview is best-effort */ });
      }
    } else {
      setOptions([]);
    }
  }, [record, open]);

  // Revoke local object URLs when they're replaced or the modal closes.
  // Presigned S3 URLs are plain strings — `blob:` is the marker for an
  // object URL that needs explicit cleanup.
  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const filteredTypes = useMemo(() => {
    if (!f.category_id) return lk.serviceTypes.filter((t) => Number(t.display) === 2);
    return lk.serviceTypes.filter((t) => Number(t.service_catg_id) === Number(f.category_id) && Number(t.display) === 2);
  }, [lk.serviceTypes, f.category_id]);

  /*
   * Category options for the modal. The /shared/lookup/service-categories
   * endpoint returns only ACTIVE categories (service_catg_status = 1), but
   * a deep skill can reference a category that was later deactivated —
   * and the sibling service-types lookup does NOT filter on the parent
   * category's status, so the skill's Service Type still resolves while
   * its Category would silently fall back to the placeholder in edit mode.
   * Fix: always inject the saved {category_id, category_name} when it's
   * absent from the active list, so edit mode renders the real selection.
   * (`category_name` rides along on the list row + getById detail.)
   */
  const categoryOptions = useMemo(() => {
    const opts = lk.toOpts.serviceCategories.map((o) => ({ value: o.value, label: String(o.label) }));
    if (f.category_id && !opts.some((o) => String(o.value) === String(f.category_id))) {
      opts.unshift({ value: f.category_id, label: record?.category_name || `Category #${f.category_id}` });
    }
    return opts;
  }, [lk.toOpts.serviceCategories, f.category_id, record?.category_name]);

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
    // Local FileReader-style object URL gives the operator immediate
    // visual feedback — no waiting for the round-trip in Edit mode and
    // it's the only preview available in Add mode (where the upload
    // doesn't happen until after the create round-trip).
    const localUrl = URL.createObjectURL(file);
    setPreviewUrl((prev) => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
      return localUrl;
    });

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
      // 2026-06-10: canonical multipart endpoint. Returns the new S3
      // key plus a fresh presigned URL we can swap into the preview.
      const res = await api.post<{ image: string; url: string | null }>(
        `/admin/deep-skills/${record.deepskill_id}/upload-image`, fd);
      setF((s) => ({ ...s, deepskill_image: res.image }));
      if (res.url) {
        setPreviewUrl((prev) => {
          if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
          return res.url;
        });
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Upload failed');
    } finally { setImageUploading(false); }
  }

  /*
   * Remove the current image (2026-06-10). Two paths:
   *  - Edit mode + saved key → DELETE /image endpoint clears the DB
   *    column AND the S3 object in one call.
   *  - Add mode OR pending local file → just drop the local preview
   *    + clear `pendingImageFile`; nothing was persisted yet.
   */
  async function removeImage() {
    setErr(null);
    if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPendingImageFile(null);
    setF((s) => ({ ...s, deepskill_image: '' }));
    if (isEdit && record?.deepskill_id && record.deepskill_image) {
      try {
        await api.delete(`/admin/deep-skills/${record.deepskill_id}/image`);
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : 'Failed to clear image');
      }
    }
  }

  /*
   * AI-generate a skill thumbnail (2026-06-12). Synchronous BE call that
   * blocks ~5-15s while DALL-E renders. Two paths:
   *   - Edit mode (skill_id > 0): POST /:id/generate-image — the BE
   *     replaces the skill's image immediately and returns the new key
   *     + a fresh presigned preview URL.
   *   - Add mode (no id): POST /generate-image — the BE renders to a
   *     staging key (`Skills/staging/…`) WITHOUT persisting a row and
   *     returns the staging key + preview URL. submit()'s `Skills/`
   *     filter forwards the staging key on create.
   * On success we drop the URL on the existing preview tile and stash the
   * key in `f.deepskill_image`; a generated image supersedes any staged
   * local file, so `pendingImageFile` is cleared. The auto-gen info banner
   * (gated on empty image + no pending file) auto-hides once the key is set.
   */
  async function handleGenerate() {
    // Name is required to build the prompt — the button is disabled while
    // it's blank, so this is just defensive.
    if (!f.deepskill_name.trim()) return;
    // A meaningful thumbnail needs ≥1 skill option (a name-only prompt is
    // weak and DALL-E may reject it). Surface a clear, instant message on
    // click — for BOTH add and edit modes — instead of letting the BE
    // round-trip return the generic "Image generation failed" toast.
    if (options.length === 0) {
      showToast({ variant: 'error', message: 'Please Add At Least One Skill Option Before Generating An Image.' });
      return;
    }
    setGenerating(true); setErr(null);
    try {
      const body = { deepskill_name: f.deepskill_name.trim(), options };
      const res = isEdit && record?.deepskill_id
        ? await api.post<{ image: string; url: string }>(
            `/admin/deep-skills/${record.deepskill_id}/generate-image`, body)
        : await api.post<{ image: string; url: string }>(
            '/admin/deep-skills/generate-image', body);
      // A generated image replaces any staged local file.
      if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
      setPendingImageFile(null);
      setPreviewUrl(res.url);
      setF((s) => ({ ...s, deepskill_image: res.image }));
      showToast({ variant: 'success', message: 'Image Generated' });
    } catch (e) {
      // Leave existing image/preview untouched on failure.
      showToast({
        variant: 'error',
        message: e instanceof ApiError ? e.message : 'Image generation failed — please retry',
      });
    } finally { setGenerating(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.category_id || !f.service_type_id || !f.deepskill_name.trim()) {
      setErr('Service Category, Service Type, and Deep Skill Name are required');
      return;
    }
    // Add mode mirrors the BE create contract (options required). Edit mode
    // must NOT get this guard — the reconcile flow legitimately allows
    // deactivating all options.
    if (!isEdit && options.length === 0) {
      setErr('At least one Skill Option is required');
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
        // Options ride along in the create payload so the BE inserts the
        // skill + options in one transaction — no orphaned half-created
        // skill if an option write fails mid-way.
        const created = await api.post<{ deepskill_id: number }>('/admin/deep-skills', {
          ...payload,
          options: options.map((o) => ({ skill_option: o })),
        });
        skillId = created.deepskill_id;
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
          // 2026-06-10: routed to the canonical /upload-image endpoint
          // which both stores the file in S3 AND persists the key to
          // `tbl_deep_skill.deepskill_image` (previous endpoint
          // wrote to a misnamed `tbl_deepskill` table and silently
          // failed — user-reported as "image not storing in DB").
          await api.post(`/admin/deep-skills/${skillId}/upload-image`, fd);
        } catch (upErr) {
          // Surface a non-fatal warning. The skill saved; image didn't.
          setErr(`Skill saved. Image upload failed: ${upErr instanceof ApiError ? upErr.message : 'unknown error'}`);
        }
      }
      // Options refresh comes for free: onSaved() calls loadSkills(), which
      // refetches the list (now carrying option_labels per row).
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setSaving(false); }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      {/*
       * Scrollability (2026-06-10). `max-h-[90vh]` + `overflow-hidden`
       * + `flex flex-col` caps the modal at viewport height and lets
       * the inner body scroll independently. Sticky DialogHeader sits
       * at the top, the form fields scroll inside a `flex-1 min-h-0
       * overflow-y-auto` region, and the footer (Cancel / Save) is
       * pinned at the bottom — operators with images + multiple chips
       * + a long description no longer lose access to Save/Cancel
       * when the form overflows the viewport.
       */}
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
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
              <div className="text-xs text-ink-100/80 mt-0.5">Define specialized skills and expertise</div>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col flex-1 min-h-0">
        <div className="overflow-y-auto -mx-6 px-6 flex-1 min-h-0 space-y-4 py-1">
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
                options={categoryOptions}
                placeholder="Select Service Category"
              />
            </div>
            <div className="flex-1 min-w-0">
              <Label className="text-xs">Service Type</Label>
              <SearchSelect
                value={f.service_type_id}
                onChange={(v) => setF((s) => ({ ...s, service_type_id: v }))}
                options={filteredTypes.map((t) => ({ value: t.service_type_id, label: t.service_type_name }))}
                placeholder={f.category_id ? 'Select Service Type' : 'Select a category first'}
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
                    f.status === 1 ? 'text-success-strong' : 'text-ink-500',
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
              {/* Upload + AI Generate sit side-by-side — operators can
                  pick a file OR have DALL-E render a thumbnail from the
                  skill name + options before saving. */}
              <div className="flex items-stretch gap-2">
                {/* Click-to-upload box matches legacy "Upload Image" affordance */}
                <label className="flex flex-1 min-w-0 items-center justify-center gap-2 h-9 rounded-md border border-dashed border-input bg-background px-3 text-sm cursor-pointer hover:bg-muted/40 transition-colors">
                  <UploadCloud className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground truncate">
                    {imageUploading ? 'Uploading…' : (f.deepskill_image || 'Upload Image')}
                  </span>
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
                    onChange={(e) => handleImage(e.target.files?.[0] ?? null)} />
                </label>
                {/* AI Generate — disabled until a Skill Name exists (needed
                    to build the prompt) or while another image op runs.
                    Label flips to "Regenerate" once an image is present. */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={handleGenerate}
                  disabled={!f.deepskill_name.trim() || generating || imageUploading}
                  title={!f.deepskill_name.trim() ? 'Enter A Skill Name First' : undefined}
                >
                  <Sparkles className="h-4 w-4 mr-1" />
                  {generating
                    ? 'Generating…'
                    : ((f.deepskill_image || pendingImageFile || previewUrl) ? 'Regenerate' : 'Generate')}
                </Button>
              </div>
              {/* AI generation progress — emerald to distinguish from the
                  sky auto-gen-after-save info banner below. */}
              <AnimatedLoadingBar visible={generating} message="Generating Image…" tone="emerald" />
              {/*
               * Preview tile (2026-06-10). 80×80 thumbnail of the
               * currently-picked or saved image. Two source paths:
               *   - Edit mode w/ existing key → presigned S3 URL via
               *     GET /image-url (signed URL is a plain string, no
               *     auth header on the <img>).
               *   - Add mode or replacement w/ pending file → local
               *     object URL from FileReader-style URL.createObjectURL.
               * The X overlay clears local + DB state; in Edit mode it
               * also DELETEs the underlying S3 object.
               */}
              {previewUrl && (
                <div className="mt-2 relative inline-block">
                  {/*
                   * Click-to-zoom (2026-06-10). The 80×80 tile becomes a
                   * <button> with `cursor-zoom-in` so operators can verify
                   * details without leaving the editor. Opens a separate
                   * Dialog at the page level (see below) with the image
                   * rendered at viewport size. Esc / overlay-click closes.
                   */}
                  <button
                    type="button"
                    onClick={() => setZoomedImage(previewUrl)}
                    title="Click To Enlarge"
                    className="block cursor-zoom-in"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={previewUrl}
                      alt="Skill image preview"
                      className="w-20 h-20 object-cover rounded border border-input"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={removeImage}
                    title="Remove Image"
                    className="absolute -top-1 -right-1 inline-flex items-center justify-center h-5 w-5 rounded-full bg-urgent hover:bg-urgent-strong text-white shadow"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </div>
              )}
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
            <div className="flex items-center gap-1.5 text-sm font-medium mb-2 text-success-strong">
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
                        ? 'bg-success-tint border-success text-success-strong'
                        : 'bg-background hover:border-success/30'
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
                  <span key={opt} className="inline-flex items-center gap-1 rounded bg-success-tint border border-success/30 text-success-strong px-2 py-0.5 text-xs">
                    {opt}
                    <button type="button" onClick={() => removeOption(opt)} className="hover:bg-success-tint rounded">
                      <XIcon className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {err && <div className="text-sm text-destructive">{err}</div>}
        </div>

          {/*
           * Auto-gen info notice (2026-06-12). Shows above the footer
           * when the operator hasn't picked any image — both the saved
           * key (`f.deepskill_image`) AND the pending local file
           * (`pendingImageFile`) are empty. The BE auto-generates the
           * image from skill name + options after save; this notice
           * sets that expectation so the operator isn't surprised by a
           * pending/generating chip on the list row a moment later.
           *
           * Title Case per `feedback_easyfix_label_casing.md`.
           */}
          {!f.deepskill_image && !pendingImageFile && (
            <AnimatedLoadingBar
              visible
              tone="sky"
              message="Skill Image Will Be Auto-Generated From Skill Name + Options After Save."
            />
          )}

          {/* Footer (2026-06-05): icon-free buttons per ops feedback —
              the X on Cancel and the + on Add/Save were visual noise
              given the words alone already communicate intent.
              Pinned via `shrink-0` so it stays visible when the body
              above scrolls. */}
          <div className="flex justify-end gap-2 pt-3 mt-3 border-t shrink-0">
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

      {/*
       * Lightbox (2026-06-10). Separate Dialog rendered as a sibling
       * of the editor so it overlays everything (including the editor).
       * The image is the URL we're already using in the preview tile —
       * presigned S3 URL (edit) or local object URL (add) — no extra
       * fetch needed. `max-w-3xl p-0` lets the image fill the dialog
       * without internal padding; `w-full h-auto` scales it to the
       * dialog width preserving aspect ratio.
       */}
      {/*
        * Lightbox (2026-06-10 fix v2). Previous version had no visible
        * close affordance + the image could fill the entire viewport
        * when zoomedImage was a high-res photo, blocking the Esc/click-
        * outside hint. Now:
        *   - max-w-2xl + max-h-[85vh] keeps the dialog modal-sized,
        *     not full-screen
        *   - Explicit X close button at top-right (sticky-positioned
        *     above the image so it's always visible regardless of
        *     image dimensions)
        *   - Image gets max-h-[80vh] + object-contain so portrait /
        *     landscape ratios both fit inside the dialog without
        *     overflow
        *   - mx-auto centres the image when it's narrower than the
        *     dialog (logos, square thumbnails)
        */}
      <Dialog open={zoomedImage != null} onOpenChange={guardedLightboxClose}>
        {/* Nothing here can overflow: the only child is an <img> capped at
            max-h-[80vh] object-contain inside this 85vh panel, so there is no
            content to scroll to and no footer to hide. overflow-hidden is the
            right call — it keeps the image's corners clipped to the panel. */}
        {/* eslint-disable-next-line local/no-unscrollable-dialog-content */}
        <DialogContent className="max-w-2xl max-h-[85vh] p-0 overflow-hidden">
          <DialogTitle className="sr-only">Skill Image Preview</DialogTitle>
          <button
            type="button"
            onClick={() => setZoomedImage(null)}
            className="absolute top-2 right-2 z-10 rounded-full bg-white/90 hover:bg-white text-ink-700 hover:text-ink-900 shadow-md p-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            title="Close preview"
            aria-label="Close preview"
          >
            <XIcon className="h-4 w-4" />
          </button>
          {zoomedImage && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={zoomedImage}
              alt="Skill image enlarged"
              className="w-auto h-auto max-w-full max-h-[80vh] object-contain mx-auto block"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
