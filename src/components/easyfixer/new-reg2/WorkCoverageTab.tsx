'use client';
/*
 * Work & Coverage tab — deep-skill option mapping + serviceable pincodes.
 *
 * Real data: GET .../option-mappings (grouped Category → Skill → Option →
 * service type) and GET .../serviceable-pincodes. Editing the mapping reuses
 * the shared EasyfixerDeepSkillModal (opened by the parent); editing the
 * pincodes reuses ServiceablePincodesEditor, the same component the
 * verification workflow renders. Coverage-from-jobs and jobs-by-category have
 * no endpoint, so they render placeholders.
 *
 * `focusPincodes` is a counter the Onboarding tab bumps when a reviewer clicks
 * a coverage row there: the parent switches to this tab and we scroll the
 * pincode editor into view and ring it, so the click lands somewhere visible
 * instead of at the top of a long page.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { ServiceablePincodesEditor } from '@/components/easyfixer/ServiceablePincodesEditor';
import { SectionCard, EndpointPending, LockedBody } from './ui';
import type { OptionMapping, PincodeChip } from './types';

export function WorkCoverageTab({
  efrId,
  active,
  canManageSkills,
  onManageSkills,
  canEditPincodes = false,
  focusPincodes = 0,
}: {
  efrId: number;
  active: boolean;
  canManageSkills: boolean;
  onManageSkills: () => void;
  canEditPincodes?: boolean;
  focusPincodes?: number;
}) {
  // Parent remounts this tab (React key) after an unmap, so a plain key
  // re-fetches — no cache-buster query param.
  const { data: mapData, loading: mapLoading } = useFetch<{ items: OptionMapping[] }>(
    `/admin/easyfixers/${efrId}/option-mappings`,
  );
  const { data: pinData, refetch: refetchPins } = useFetch<{ items: PincodeChip[] }>(
    `/admin/easyfixers/${efrId}/serviceable-pincodes`,
  );

  const pinRef = useRef<HTMLDivElement>(null);
  const [ringing, setRinging] = useState(false);

  // Arriving from the Onboarding tab's coverage table: scroll here and flash a
  // ring. Skips the initial render (focusPincodes starts at 0).
  useEffect(() => {
    if (!focusPincodes) return;
    pinRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setRinging(true);
    const t = setTimeout(() => setRinging(false), 2000);
    return () => clearTimeout(t);
  }, [focusPincodes]);

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

      <div ref={pinRef} className={ringing ? 'rounded-xl ring-2 ring-primary ring-offset-2 transition-shadow' : 'transition-shadow'}>
        <SectionCard title="Serviceable Pincodes" icon={<span>📍</span>} right={<span>{pins.length} selected</span>}>
          {canEditPincodes ? (
            <ServiceablePincodesEditor efrId={efrId} onReload={async () => { refetchPins(); }} />
          ) : (
            <>
              {pins.length === 0 ? (
                <p className="text-sm text-muted-foreground">No serviceable pincodes yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {pins.map((p) => (
                    <span key={p.pincode_id} className="rounded-md border bg-muted px-2 py-1 font-mono text-xs text-ink-700" title={[p.location, p.city_name, p.state_name].filter(Boolean).join(', ')}>
                      {p.pincode}{p.city_name ? ` · ${p.city_name}` : ''}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-3 text-xs text-muted-foreground">You do not have permission to change serviceable pincodes.</p>
            </>
          )}
        </SectionCard>
      </div>

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
