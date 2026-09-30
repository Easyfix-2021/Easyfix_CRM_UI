'use client';
/*
 * Overview tab — money/tenure tiles + profile-strength breakdown.
 *
 * Real data: earnings/jobs/rating from the aggregates POST, balance +
 * registration date from the list row, PIN count + section progress from the
 * verification payload. Recent category performance reuses the QuickSight
 * Technician Performance drill-down (fetched only when opened). Lifetime
 * jobs-by-category / vertical and TQI have no endpoint, so they render an
 * explicit "endpoint pending" placeholder rather than mock data.
 */
import { useState } from 'react';
import { formatDate, formatEasyfixerName } from '@/lib/utils';
import { parseIstDateTime } from '@/lib/format';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { TechnicianCategoryModal } from '@/app/(authed)/quicksight/technician-performance/TechnicianCategoryModal';
import { SectionCard, Tile, MeterRow, LockedBody, inr } from './ui';
import { JobsCompletedCard } from './JobsCompletedCard';
import type { VerificationPayload, ProfileListRow, AggregateRow } from './types';

const QUICKSIGHT_KEYS = ['ef-QuickSight', 'isQuickSightTechnicianPerformanceView'] as const;

function tenureFrom(iso: string | null | undefined): string {
  if (!iso) return '—';
  const start = parseIstDateTime(iso);
  if (Number.isNaN(start.getTime())) return '—';
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  if (months < 0) months = 0;
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0 && m === 0) return 'This month';
  return [y > 0 ? `${y} yr` : '', m > 0 ? `${m} mo` : ''].filter(Boolean).join(' ');
}

export function OverviewTab({
  active,
  row,
  agg,
  v,
}: {
  active: boolean;
  row: ProfileListRow | null;
  agg: AggregateRow | null;
  v: VerificationPayload | null;
}) {
  const { me } = useMe();
  const qsFlags = actionFlags(me, QUICKSIGHT_KEYS);
  const canViewCategories = QUICKSIGHT_KEYS.every((k) => qsFlags[k]);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const efrId = v?.header.efr_id ?? row?.efr_id ?? null;

  const pinCount = v?.additional.serviceable_pincodes_count
    ?? (row?.serviceable_pincodes_csv ? row.serviceable_pincodes_csv.split(',').filter(Boolean).length : 0);
  const earnings = agg?.total_earnings ?? row?.total_earnings ?? 0;
  const jobs = agg?.job_count ?? row?.job_count ?? 0;

  /*
   * The breakdown reads from the SAME completion rule as the ring and the
   * Accept gate. It used to list the legacy per-section percentages
   * (efr_professional_details_perc and friends) — columns the new technician
   * app never writes, so every bar sat at 0 beside a strength of 100%.
   */
  const missing = new Set(v?.completion.missing ?? []);
  const strengthRows: Array<[string, number]> = v
    ? ([
        ['Skills', 'Skills'],
        ['Aadhaar', 'Aadhaar'],
        ['Profile picture', 'Profile picture'],
        ['Date of birth', 'Date of birth'],
        ['Personal details', 'Personal details'],
        ['Serviceable pincodes', 'Serviceable pincodes'],
      ] as Array<[string, string]>).map(([label, key]) => [label, missing.has(key) ? 0 : 100])
    : [];

  return (
    <div className="space-y-4">
      {active ? (
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
          <Tile label="Total earnings" value={inr(earnings)} sub={row?.insert_date ? `since ${formatDate(row.insert_date)}` : undefined} />
          <Tile label="Current balance" value={inr(row?.current_balance)} sub="payable now" />
          <Tile label="Jobs completed" value={jobs.toLocaleString('en-IN')} sub="lifetime" />
          <Tile label="PIN codes covered" value={String(pinCount)} sub="serviceable" />
          <Tile small label="Registered on" value={row?.insert_date ? formatDate(row.insert_date) : '—'} />
          <Tile small label="Activated on" value={row?.profile_activation_date_time ? formatDate(row.profile_activation_date_time) : '—'} />
          <Tile small label="Tenure" value={tenureFrom(row?.insert_date)} sub="in system" />
          <Tile small label="Avg rating" value={agg?.avg_rating != null ? `${Number(agg.avg_rating).toFixed(1)}★` : (row?.avg_rating != null ? `${Number(row.avg_rating).toFixed(1)}★` : '—')} />
        </div>
      ) : (
        <div className="rounded-xl border border-gold/40 bg-gold-tint p-4 text-sm text-ink-900">
          <strong className="block font-semibold">Not activated yet</strong>
          Earnings, balance, jobs and coverage appear once this Easyfixer is activated. See the <b>Onboarding</b> tab to review &amp; activate.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {active && efrId != null ? (
          <div className="space-y-3">
            <JobsCompletedCard efrId={efrId} />
            {canViewCategories && (
              <Button size="sm" variant="outline" onClick={() => setCategoriesOpen(true)}>
                Category performance (last 3 months)
              </Button>
            )}
          </div>
        ) : (
          <SectionCard title="Jobs completed" icon={<span>🧩</span>}>
            <LockedBody />
          </SectionCard>
        )}
        <SectionCard title="Profile strength" icon={<span>📊</span>} right={<span>{v?.completion.percent ?? row?.computed_profile_perc ?? 0}% complete</span>}>
          {strengthRows.length
            ? strengthRows.map(([label, pct]) => <MeterRow key={label} label={label} pct={pct} />)
            : <p className="text-sm text-muted-foreground">No breakdown available.</p>}
        </SectionCard>
      </div>

      {canViewCategories && efrId != null && (
        <TechnicianCategoryModal
          txId={efrId}
          txName={formatEasyfixerName(v?.header.full_name ?? row?.efr_name ?? '')}
          flag="monthly"
          open={categoriesOpen}
          onOpenChange={setCategoriesOpen}
        />
      )}
    </div>
  );
}
