'use client';
/*
 * DeepSkillOptionMappingEditor — pick the service categories, deep skills and
 * options a technician is mapped to, and save them.
 *
 * Lifted verbatim (2026-09-29) out of the verification page, which had been its
 * only home, so New Registration 2's "Work & Coverage" tab can offer the SAME
 * editor rather than a read-only list beside a different modal. Both callers
 * render this one component; behaviour below is unchanged.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCircle2, ChevronDown, ChevronUp, Loader2, Search, Wrench, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, useDebouncedValue } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { showToast } from '@/components/ui/toast';
import { SkillImageLightbox } from '@/components/easyfixer/SkillImageLightbox';

/*
 * Tiny bridge wrapper (2026-06-11) that memoises the `value` object and the
 * `onClose` callback before passing them to <SkillImageLightbox>. Without
 * this, the inline `onClose={() => setLightboxUrl(null)}` is a fresh
 * function every render, which forces the lightbox child to reconcile
 * even when no state changed. Defining as a real component (not inline
 * useMemo) keeps the host component's hook order untouched.
 */
function MemoizedSkillImageLightboxBridge({
  lightboxUrl,
  setLightboxUrl,
}: {
  lightboxUrl: { url: string; name: string } | null;
  setLightboxUrl: React.Dispatch<React.SetStateAction<{ url: string; name: string } | null>>;
}) {
  const value = useMemo(
    () => (lightboxUrl ? { url: lightboxUrl.url, name: lightboxUrl.name } : null),
    [lightboxUrl],
  );
  const onClose = useCallback(() => setLightboxUrl(null), [setLightboxUrl]);
  return <SkillImageLightbox value={value} onClose={onClose} />;
}

/* ───────── Deep Skill Option Mapping ───────── */
/*
 * 4-level tree picker (Service Category → Service Type → Deep Skill →
 * Options) for tbl_efr_deepskill_mapping. The mapping table stores ONE
 * row per (easyfixer × option) — see the docblock in
 * services/easyfixer-verification.service.js for the column-name
 * inversion this FE deliberately abstracts away (we work in semantic
 * names only).
 *
 * Loading model:
 *   - On mount: fetch current mappings + ALL service categories.
 *   - On expanding a category: lazy-load that category's service types.
 *   - On expanding a service type: lazy-load that type's deep skills.
 *   - On expanding a deep skill: lazy-load its options.
 *
 * Lazy-loading keeps the initial paint cheap (3 categories x N types x
 * M skills x K options would balloon fast). Children are cached
 * in-state once fetched so collapse/expand toggles never re-fetch.
 *
 * The "currently mapped" indicator is computed from `original` — the
 * set captured on first fetch. The Save button is disabled until
 * `selected` diverges from `original`.
 *
 * RENDER (2026-07 Figma redesign): the tree is presented as a single-page
 * CATEGORY ACCORDION that mirrors the public profile-update SkillsMappingPicker
 * — expanding a category reveals an app-like LEFT service-type rail + RIGHT
 * grid of deep-skill cards, and tapping a card opens an options bottom sheet.
 * The DATA FLOW is unchanged: every level is still lazy-loaded via the same
 * /admin lookups, cached per-key in-state; only the fetch TRIGGERS were
 * re-shaped to the accordion → rail → cards → sheet interactions.
 */

/* ───────── Deep-skill picker theme + icons (Figma redesign) ─────────
 * Standalone red/blue palette copied from the public profile-update flow so
 * the CRM picker matches the Figma mockup 1:1. Category / service-type ICONS
 * ship as static assets in public/deep-skill-icons/{categories,service-types}/
 * named by the slug of the category / service-type name; until an asset lands,
 * DsIconTile falls back to a coloured first-letter tile. Deep-skill THUMBNAILS
 * keep coming from the DB (deep_skill_image_url). */
const DS_RED = 'hsl(var(--urgent))';
const DS_RED_TINT = 'hsl(var(--urgent-tint))';
const DS_BLUE = 'hsl(var(--info))';
const DS_BLUE_TINT = 'hsl(var(--info-tint))';
const DS_GREEN = 'hsl(var(--success))';
const DS_GREEN_TINT = 'hsl(var(--success-tint))';

function dsSlug(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function DsIconTile({
  name, kind, size = 44, className = '',
}: { name: string; kind: 'categories' | 'service-types'; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const slug = dsSlug(name);
  const letter = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
  if (failed || !slug) {
    return (
      <div
        style={{ width: size, height: size, backgroundColor: DS_RED_TINT, color: DS_RED }}
        className={`flex items-center justify-center rounded-lg font-semibold shrink-0 ${className}`}
        aria-hidden
      >
        {letter}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/deep-skill-icons/${kind}/${slug}.png`}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={`rounded-lg object-contain shrink-0 ${className}`}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}

type OptionMapping = {
  category_id: number; category_name: string | null;
  service_type_id: number; service_type_name: string | null;
  deep_skill_id: number; deep_skill_name: string | null;
  deep_skill_image_url: string | null;
  option_id: number; option_name: string | null;
};

type ServiceCategoryLU = { service_catg_id: number; service_catg_name: string };
type ServiceTypeLU     = { service_type_id: number; service_type_name: string; service_catg_id: number };
type DeepSkillLU       = { deepskill_id: number; deepskill_name: string; category_id: number; service_type_id: number; deep_skill_image_url: string | null; option_count?: number };
type DeepSkillOptionLU = { id: number; skill_option: string; status: number };
type DeepSkillDetail   = { deepskill_id: number; deepskill_name: string; options: DeepSkillOptionLU[] };

function mapKey(catg: number, type: number, skill: number, option: number) {
  return `${catg}|${type}|${skill}|${option}`;
}

export function DeepSkillOptionMappingEditor({
  efrId,
  onReload,
  readOnly = false,
}: {
  efrId: number;
  onReload?: () => Promise<void>;
  /*
   * Show the same categories / deep skills / option tiles, but do not offer to
   * change them. The Onboarding review uses this so a reviewer reads the
   * mapping in the format it is edited in, with one editor of record over in
   * Work & Coverage — rather than a second, plainer rendering that can drift.
   * Browsing still works: only the option toggle and Save are withheld.
   */
  readOnly?: boolean;
}) {
  const [categories, setCategories] = useState<ServiceCategoryLU[]>([]);
  const [mappings, setMappings] = useState<OptionMapping[]>([]);
  const [original, setOriginal] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Accordion / rail / sheet UI state (Figma redesign):
  //   - expandedCatg    : exactly one category card is open at a time.
  //   - activeTypeByCatg: which service-type rail item is active per category
  //     (so re-expanding a category restores the last-viewed rail item).
  //   - sheetSkillId    : which deep-skill's options bottom sheet is open.
  const [expandedCatg, setExpandedCatg] = useState<number | null>(null);
  const [activeTypeByCatg, setActiveTypeByCatg] = useState<Record<number, number>>({});
  const [sheetSkillId, setSheetSkillId] = useState<number | null>(null);
  // Lazy-loaded children — keyed by parent id (cached so re-expanding /
  // re-selecting a rail item never re-fetches).
  const [typesByCatg, setTypesByCatg] = useState<Record<number, ServiceTypeLU[]>>({});
  const [skillsByType, setSkillsByType] = useState<Record<number, DeepSkillLU[]>>({});
  const [optionsBySkill, setOptionsBySkill] = useState<Record<number, DeepSkillOptionLU[]>>({});
  // Click-to-enlarge lightbox for the deep-skill thumbnails.
  const [lightboxUrl, setLightboxUrl] = useState<{ url: string; name: string } | null>(null);

  // Initial fetch — current mappings + the full categories list.
  // Two-request Promise.all + transform-into-Set state pattern doesn't
  // map cleanly to `useFetch` (single URL → single payload); the
  // cancelled-flag + module-level dedupe via api here is the correct
  // shape. Targeted disable, not a global carve-out.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [mapResp, catResp] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax
          api.get<{ items: OptionMapping[] }>(`/admin/easyfixers/${efrId}/option-mappings`),
          // eslint-disable-next-line no-restricted-syntax
          api.get<ServiceCategoryLU[]>(`/shared/lookup/service-categories`),
        ]);
        if (cancelled) return;
        const items = mapResp?.items ?? [];
        const set = new Set(items.map((m) => mapKey(m.category_id, m.service_type_id, m.deep_skill_id, m.option_id)));
        setMappings(items);
        setOriginal(new Set(set));
        setSelected(new Set(set));
        setCategories(Array.isArray(catResp) ? catResp : []);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Failed to load option mappings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [efrId]);

  // ── Lazy-fetch primitives (cache-guarded; identical endpoints to before,
  //    only the invocation triggers were re-shaped for the accordion) ──

  // Fetch a category's service-types (rail). display=2 ⇒ only Tx-app /
  // deep-skill service types (BE also filters active-only by default), so
  // CRM-only types like "Amazon" (display=0) never appear in the tree.
  const ensureTypes = useCallback(async (catgId: number): Promise<ServiceTypeLU[]> => {
    if (typesByCatg[catgId]) return typesByCatg[catgId];
    try {
      const types = await api.get<ServiceTypeLU[]>(`/shared/lookup/service-types?categoryId=${catgId}&display=2`);
      const arr = Array.isArray(types) ? types : [];
      setTypesByCatg((s) => ({ ...s, [catgId]: arr }));
      return arr;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load service types');
      return [];
    }
  }, [typesByCatg]);

  // Fetch a (category, service-type)'s deep-skill cards.
  const ensureSkills = useCallback(async (catgId: number, typeId: number): Promise<void> => {
    if (skillsByType[typeId]) return;
    try {
      const skills = await api.get<DeepSkillLU[]>(`/admin/deep-skills?categoryId=${catgId}&serviceTypeId=${typeId}`);
      setSkillsByType((s) => ({ ...s, [typeId]: Array.isArray(skills) ? skills : [] }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load deep skills');
    }
  }, [skillsByType]);

  // Fetch a deep-skill's options (status===1 only) for the bottom sheet.
  const ensureOptions = useCallback(async (skillId: number): Promise<void> => {
    if (optionsBySkill[skillId]) return;
    try {
      const detail = await api.get<DeepSkillDetail>(`/admin/deep-skills/${skillId}`);
      const opts = (detail?.options || []).filter((o) => Number(o.status) === 1);
      setOptionsBySkill((s) => ({ ...s, [skillId]: opts }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load skill options');
    }
  }, [optionsBySkill]);

  // Accordion toggle: expanding a category collapses any other, closes the
  // sheet, then loads its rail (service-types) and the deep-skills for the
  // active/first rail item.
  const expandCategory = useCallback(async (catgId: number) => {
    setSheetSkillId(null);
    if (expandedCatg === catgId) { setExpandedCatg(null); return; }
    setExpandedCatg(catgId);
    const types = await ensureTypes(catgId);
    if (types.length === 0) return;
    const activeId = activeTypeByCatg[catgId] ?? types[0].service_type_id;
    if (activeTypeByCatg[catgId] == null) {
      setActiveTypeByCatg((s) => ({ ...s, [catgId]: activeId }));
    }
    await ensureSkills(catgId, activeId);
  }, [expandedCatg, activeTypeByCatg, ensureTypes, ensureSkills]);

  // Rail item click: make it the active type for its category and load its
  // deep-skills.
  const selectType = useCallback(async (catgId: number, typeId: number) => {
    setSheetSkillId(null);
    setActiveTypeByCatg((s) => ({ ...s, [catgId]: typeId }));
    await ensureSkills(catgId, typeId);
  }, [ensureSkills]);

  // Card click: open its options bottom sheet and ensure its options loaded.
  const openSheet = useCallback(async (skillId: number) => {
    setSheetSkillId(skillId);
    await ensureOptions(skillId);
  }, [ensureOptions]);

  function toggleOption(catgId: number, typeId: number, skillId: number, optionId: number) {
    if (readOnly) return;
    const key = mapKey(catgId, typeId, skillId, optionId);
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelected(next);
  }

  const dirty = useMemo(() => {
    if (selected.size !== original.size) return true;
    for (const k of selected) if (!original.has(k)) return true;
    return false;
  }, [selected, original]);

  /*
   * Selected-count badges at EVERY level (2026-06-11). The `selected`
   * Set keys are `${catgId}|${typeId}|${skillId}|${optionId}`. We
   * derive three Maps in a single O(n) pass:
   *   - countByCategory          : key = catgId
   *   - countByType              : key = "catgId|typeId"
   *   - countBySkill             : key = "catgId|typeId|skillId"
   * Surfaced as small emerald pills next to each header so operators
   * see option counts cascade up the hierarchy without expanding every
   * branch. Recomputed on every selected change; Set size is tiny
   * (≤ ~150 in practice) so the cost is negligible.
   */
  const { countByCategory, countByType, countBySkill } = useMemo(() => {
    const byCatg = new Map<number, number>();
    const byType = new Map<string, number>();
    const bySkill = new Map<string, number>();
    for (const k of selected) {
      const [c, t, s] = k.split('|');
      const catgId = Number(c);
      byCatg.set(catgId, (byCatg.get(catgId) || 0) + 1);
      byType.set(`${c}|${t}`, (byType.get(`${c}|${t}`) || 0) + 1);
      bySkill.set(`${c}|${t}|${s}`, (bySkill.get(`${c}|${t}|${s}`) || 0) + 1);
    }
    return { countByCategory: byCatg, countByType: byType, countBySkill: bySkill };
  }, [selected]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const items = Array.from(selected).map((k) => {
        const [c, t, s, o] = k.split('|').map(Number);
        return { category_id: c, service_type_id: t, deep_skill_id: s, option_id: o };
      });
      await api.put(`/admin/easyfixers/${efrId}/option-mappings`, { items });
      // Refetch + re-anchor original to the new server state.
      const mapResp = await api.get<{ items: OptionMapping[] }>(`/admin/easyfixers/${efrId}/option-mappings`);
      const fresh = mapResp?.items ?? [];
      const set = new Set(fresh.map((m) => mapKey(m.category_id, m.service_type_id, m.deep_skill_id, m.option_id)));
      setMappings(fresh);
      setOriginal(new Set(set));
      setSelected(new Set(set));
      // Refresh parent payload so the Additional Details progress bar
      // reflects the new deep-skill count.
      if (onReload) await onReload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save option mappings');
    } finally {
      setSaving(false);
    }
  }

  // ── Derived render helpers for the open accordion card ──
  // The active rail service-type for the currently-expanded category (falls
  // back to the first loaded type), and the deep-skill whose options sheet is
  // open. `sheetCtx` carries the (catg, type) needed to build option keys.
  const expandedTypes = expandedCatg != null ? (typesByCatg[expandedCatg] ?? null) : null;
  const activeTypeId = expandedCatg != null
    ? (activeTypeByCatg[expandedCatg] ?? expandedTypes?.[0]?.service_type_id ?? null)
    : null;
  const activeType = expandedTypes?.find((t) => t.service_type_id === activeTypeId) ?? null;
  const activeSkills = activeTypeId != null ? (skillsByType[activeTypeId] ?? null) : null;
  const sheetCtx = useMemo(() => {
    if (sheetSkillId == null || expandedCatg == null || activeTypeId == null) return null;
    const skill = (activeSkills ?? []).find((s) => s.deepskill_id === sheetSkillId);
    if (!skill) return null;
    return { catgId: expandedCatg, typeId: activeTypeId, skill };
  }, [sheetSkillId, expandedCatg, activeTypeId, activeSkills]);

  return (
    <div className="border-t pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-ink-700">Deep Skill Option Mapping</h4>
        <span className="text-xs text-ink-500">
          {selected.size} Option{selected.size === 1 ? '' : 's'} Selected
        </span>
      </div>

      {loading ? (
        <div className="text-xs text-ink-500">Loading…</div>
      ) : error ? (
        <div className="text-xs text-urgent">{error}</div>
      ) : categories.length === 0 ? (
        <div className="text-xs text-ink-500">No Service Categories Available.</div>
      ) : (
        <>
          {mappings.length === 0 && selected.size === 0 && (
            <div className="rounded border border-dashed border-ink-100 bg-ink-50 p-3 text-xs text-ink-500">
              No Options Mapped Yet. Tap A Service Category To Begin.
            </div>
          )}

          {/* ── Category accordion (single page): tapping a category expands it
              in place to reveal its service-type rail + deep-skill cards, and
              collapses the others. ── */}
          <div className="space-y-2">
            {categories.map((c) => {
              const count = countByCategory.get(c.service_catg_id) || 0;
              const expanded = expandedCatg === c.service_catg_id;
              return (
                <div key={c.service_catg_id} className="rounded-xl border border-ink-100 bg-card overflow-hidden">
                  <button
                    type="button"
                    onClick={() => expandCategory(c.service_catg_id)}
                    className="w-full flex items-center gap-3 px-3 py-3 text-left"
                  >
                    <DsIconTile name={c.service_catg_name} kind="categories" size={36} />
                    <span className="flex-1 min-w-0">
                      <span className="block font-semibold text-ink-900 truncate">{c.service_catg_name}</span>
                      <span className="block text-xs text-ink-500">{count} Skill{count === 1 ? '' : 's'} Added</span>
                    </span>
                    {count > 0 && <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: DS_GREEN }} />}
                    {expanded
                      ? <ChevronUp className="h-5 w-5 text-ink-500 shrink-0" />
                      : <ChevronDown className="h-5 w-5 text-ink-500 shrink-0" />}
                  </button>

                  {expanded && (
                    <div className="border-t border-ink-100 flex max-h-[70vh]">
                      {/* left service-type rail */}
                      <div className="w-[84px] shrink-0 overflow-y-auto border-r border-ink-100 bg-card">
                        {expandedTypes == null ? (
                          <div className="px-1.5 py-3 text-center text-xs text-ink-500">Loading…</div>
                        ) : expandedTypes.length === 0 ? (
                          <div className="px-1.5 py-3 text-center text-xs text-ink-500">No Service Types.</div>
                        ) : expandedTypes.map((t) => {
                          const isActive = activeTypeId === t.service_type_id;
                          const cnt = countByType.get(`${c.service_catg_id}|${t.service_type_id}`) || 0;
                          return (
                            <button
                              key={t.service_type_id}
                              type="button"
                              onClick={() => selectType(c.service_catg_id, t.service_type_id)}
                              className="w-full flex flex-col items-center gap-1 px-1.5 py-3 text-center border-b border-ink-100"
                              style={isActive ? { backgroundColor: DS_BLUE_TINT, borderLeft: `3px solid ${DS_BLUE}` } : undefined}
                            >
                              <span className="relative">
                                <DsIconTile name={t.service_type_name} kind="service-types" size={34} />
                                {cnt > 0 && (
                                  <span
                                    style={{ backgroundColor: DS_BLUE }}
                                    className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full text-xs font-semibold text-white flex items-center justify-center"
                                  >
                                    {cnt}
                                  </span>
                                )}
                              </span>
                              <span
                                className="text-xs leading-tight"
                                style={isActive ? { color: DS_BLUE, fontWeight: 600 } : { color: 'hsl(var(--ink-700))' }}
                              >
                                {t.service_type_name}
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      {/* right skill card grid — small images, 2 columns */}
                      <div className="flex-1 min-w-0 overflow-y-auto p-3 bg-ink-50">
                        <div className="text-sm font-semibold text-ink-900 mb-2">{activeType?.service_type_name}</div>
                        {activeSkills == null ? (
                          <div className="text-sm text-ink-500">Loading…</div>
                        ) : activeSkills.length === 0 ? (
                          <div className="text-sm text-ink-500">No Deep Skills.</div>
                        ) : (
                          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                            {activeSkills.map((s) => {
                              const sel = countBySkill.get(`${c.service_catg_id}|${activeTypeId}|${s.deepskill_id}`) || 0;
                              const optCount = optionsBySkill[s.deepskill_id]?.length ?? s.option_count;
                              return (
                                <div key={s.deepskill_id} className="rounded-xl border border-ink-100 bg-card p-2 flex flex-col">
                                  <button
                                    type="button"
                                    onClick={() => { if (s.deep_skill_image_url) setLightboxUrl({ url: s.deep_skill_image_url, name: s.deepskill_name }); }}
                                    className="relative block w-full aspect-square rounded-lg overflow-hidden bg-ink-100 cursor-zoom-in"
                                    title="Click To Enlarge"
                                  >
                                    {s.deep_skill_image_url ? (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img src={s.deep_skill_image_url} alt={s.deepskill_name} className="w-full h-full object-cover" loading="lazy" />
                                    ) : (
                                      <span className="flex items-center justify-center w-full h-full text-ink-300"><Wrench className="h-7 w-7" /></span>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => openSheet(s.deepskill_id)}
                                    className="mt-2 w-full rounded-lg py-1.5 text-xs font-semibold border"
                                    style={sel > 0
                                      ? { backgroundColor: DS_BLUE, borderColor: DS_BLUE, color: 'hsl(var(--card))' }
                                      : { backgroundColor: 'hsl(var(--card))', borderColor: DS_BLUE, color: DS_BLUE }}
                                  >
                                    {sel > 0 ? `${sel} Selected` : 'ADD'}
                                    {optCount != null && (
                                      <span className="block text-xs font-normal opacity-80">
                                        {optCount} Option{optCount === 1 ? '' : 's'}
                                      </span>
                                    )}
                                  </button>
                                  <span className="mt-1.5 text-xs font-medium text-ink-700 text-center line-clamp-2">{s.deepskill_name}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            {!readOnly && (
              <Button disabled={saving || !dirty} onClick={save} className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white">
                {saving ? 'Saving…' : 'Save Option Mappings'}
              </Button>
            )}
          </div>

          {/* ── Options bottom sheet ── */}
          {sheetCtx && (
            <div className="fixed inset-0 z-[60] flex flex-col justify-end">
              <button
                type="button"
                aria-label="Close"
                className="absolute inset-0 bg-black/40"
                onClick={() => setSheetSkillId(null)}
              />
              <div className="relative rounded-t-2xl bg-card max-h-[75vh] flex flex-col">
                <div className="flex items-center justify-between px-4 py-3 border-b border-ink-100">
                  <span className="font-semibold text-ink-900">{sheetCtx.skill.deepskill_name}</span>
                  <button
                    type="button"
                    onClick={() => setSheetSkillId(null)}
                    className="rounded-full p-1 bg-ink-100 text-ink-500"
                    aria-label="Close"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="overflow-y-auto divide-y divide-ink-100">
                  {optionsBySkill[sheetCtx.skill.deepskill_id] == null ? (
                    <div className="px-4 py-4 text-sm text-ink-500">Loading…</div>
                  ) : optionsBySkill[sheetCtx.skill.deepskill_id].length === 0 ? (
                    <div className="px-4 py-4 text-sm text-ink-500">No Options.</div>
                  ) : optionsBySkill[sheetCtx.skill.deepskill_id].map((o) => {
                    const key = mapKey(sheetCtx.catgId, sheetCtx.typeId, sheetCtx.skill.deepskill_id, o.id);
                    const isSel = selected.has(key);
                    const isOriginal = original.has(key);
                    return (
                      <div key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
                        <span className={`text-sm ${isSel ? 'text-ink-500' : 'text-ink-900'}`}>
                          {o.skill_option}
                          {isOriginal && <span className="ml-1.5 text-xs font-medium" style={{ color: DS_GREEN }}>• Saved</span>}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleOption(sheetCtx.catgId, sheetCtx.typeId, sheetCtx.skill.deepskill_id, o.id)}
                          className="inline-flex items-center gap-1 rounded-lg px-4 py-1.5 text-xs font-semibold shrink-0"
                          style={isSel ? { backgroundColor: DS_GREEN_TINT, color: DS_GREEN } : { backgroundColor: DS_BLUE, color: 'hsl(var(--card))' }}
                        >
                          {isSel ? <><Check className="h-3.5 w-3.5" strokeWidth={3} /> Added</> : 'Add'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <MemoizedSkillImageLightboxBridge lightboxUrl={lightboxUrl} setLightboxUrl={setLightboxUrl} />
    </div>
  );
}
