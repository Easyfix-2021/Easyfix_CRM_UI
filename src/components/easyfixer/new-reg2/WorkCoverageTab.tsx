'use client';
/*
 * Work & Coverage tab — deep-skill option mapping + serviceable pincodes.
 *
 * Real data: GET .../option-mappings (grouped Category → Skill → Option →
 * service type) and GET .../serviceable-pincodes. Editing the mapping reuses
 * the shared EasyfixerDeepSkillModal (opened by the parent). Coverage-from-jobs
 * and jobs-by-category have no endpoint, so they render placeholders.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useFetch } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Search } from 'lucide-react';
import { SectionCard, EndpointPending, LockedBody } from './ui';
import type { OptionMapping, PincodeChip } from './types';

export function WorkCoverageTab({
  efrId,
  active,
  canManageSkills,
  onManageSkills,
}: {
  efrId: number;
  active: boolean;
  canManageSkills: boolean;
  onManageSkills: () => void;
}) {
  // Parent remounts this tab (React key) after an unmap, so a plain key
  // re-fetches — no cache-buster query param.
  const { data: mapData, loading: mapLoading } = useFetch<{ items: OptionMapping[] }>(
    `/admin/easyfixers/${efrId}/option-mappings`,
  );
  const { data: pinData, loading: pinLoading } = useFetch<{ items: PincodeChip[] }>(
    `/admin/easyfixers/${efrId}/serviceable-pincodes`,
  );

  const [pinQuery, setPinQuery] = useState('');

  // Group option mappings by category → deep skill → option (with its type).
  const grouped = useMemo(() => {
    const items = mapData?.items ?? [];
    const byCat = new Map<string, { name: string; options: Set<number>; rows: OptionMapping[] }>();
    for (const m of items) {
      const key = String(m.category_id);
      if (!byCat.has(key)) byCat.set(key, { name: m.category_name ?? `Category ${m.category_id}`, options: new Set(), rows: [] });
      const g = byCat.get(key)!;
      g.options.add(m.option_id);
      g.rows.push(m);
    }
    return [...byCat.values()];
  }, [mapData]);

  const pins = pinData?.items ?? [];
  const filteredPins = pins.filter((p) => {
    const q = pinQuery.trim().toLowerCase();
    if (!q) return true;
    return p.pincode.includes(q) || (p.location ?? '').toLowerCase().includes(q) || (p.city_name ?? '').toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="Skill & Service Area Mapping"
        icon={<span>🧭</span>}
        right={canManageSkills ? <Button size="sm" onClick={onManageSkills}>Manage mappings</Button> : undefined}
      >
        {mapLoading && !mapData ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : grouped.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deep-skill options mapped yet.</p>
        ) : (
          <div className="space-y-3">
            {grouped.map((g) => (
              <details key={g.name} className="rounded-lg border">
                <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
                  <span className="font-semibold text-ink-900">{g.name}</span>
                  <span className="text-xs text-muted-foreground">{g.options.size} option{g.options.size === 1 ? '' : 's'} mapped</span>
                </summary>
                <div className="border-t bg-muted/40 px-4 py-3">
                  <ul className="space-y-1.5 text-[13px]">
                    {g.rows.map((r) => (
                      <li key={r.mapping_id} className="flex flex-wrap items-center gap-x-2 text-ink-700">
                        <span className="font-medium text-ink-900">{r.option_name ?? `Option ${r.option_id}`}</span>
                        {r.deep_skill_name && <span className="text-muted-foreground">· {r.deep_skill_name}</span>}
                        {r.service_type_name && <span className="rounded border bg-info-tint px-1.5 py-0.5 text-xs text-info-strong">{r.service_type_name}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Per-category option totals (the &quot;X of Y&quot; denominator) need a category-catalogue count endpoint; only the mapped count is shown today.
        </p>
      </SectionCard>

      <SectionCard title="Serviceable Pincodes" icon={<span>📍</span>} right={<span>{pins.length} selected</span>}>
        <div className="mb-3 flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-ink-300" />
          <input
            value={pinQuery}
            onChange={(e) => setPinQuery(e.target.value)}
            placeholder="Search pincode or area…"
            aria-label="Search serviceable pincodes"
            className="w-full bg-transparent text-sm outline-none"
          />
        </div>
        {pinLoading && !pinData ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : filteredPins.length === 0 ? (
          <p className="text-sm text-muted-foreground">{pins.length === 0 ? 'No serviceable pincodes yet.' : 'No pincodes match your search.'}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {filteredPins.map((p) => (
              <span key={p.pincode_id} className="rounded-md border bg-muted px-2 py-1 font-mono text-xs text-ink-700" title={[p.location, p.city_name, p.state_name].filter(Boolean).join(', ')}>
                {p.pincode}{p.city_name ? ` · ${p.city_name}` : ''}
              </span>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Editing serviceable pincodes runs in the{' '}
          <Link href={`/easyfixers/${efrId}/verification?from=/easyfixers/new-registration-2/${efrId}`} className="text-primary hover:underline">verification workflow</Link>.
        </p>
      </SectionCard>

      <SectionCard title="Coverage — where they have worked" icon={<span>🗺️</span>} right={<span>from job PIN codes</span>}>
        {active
          ? <EndpointPending what="Region/coverage-from-completed-jobs needs GET /admin/easyfixers/:id/coverage (regions + job PIN codes). Not available today." />
          : <LockedBody />}
      </SectionCard>

      <SectionCard title="Jobs completed" icon={<span>🧩</span>} right={<span>by category / vertical</span>}>
        {active
          ? <EndpointPending what="Jobs-by-category / vertical breakdown needs GET /admin/easyfixers/:id/job-category-summary." />
          : <LockedBody />}
      </SectionCard>
    </div>
  );
}
