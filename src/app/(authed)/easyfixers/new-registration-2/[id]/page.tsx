'use client';

/*
 * New Registration 2 — tabbed Easyfixer PROFILE (feature/new-registration-2).
 *
 * Composes the existing easyfixer dialog components + real admin endpoints
 * into a List → Profile experience. Primary data source is the rich
 * GET /admin/easyfixers/:id/verification payload; the list row + aggregates
 * back the Overview money tiles; the lifecycle snapshot backs the header chip
 * and Status tab. Tab bodies live under components/easyfixer/new-reg2/*.
 *
 * Additive only — the legacy roster, modal and verification page are untouched.
 */

import { useCallback, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useFetch, usePostFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { BackLink } from '@/components/ui/back-link';
import { Button } from '@/components/ui/button';
import { CallableMobile } from '@/components/calls/CallButton';
import { EasyfixerLifecycleChip } from '@/components/easyfixer/EasyfixerLifecycleChip';
import { EasyfixerStatusDialog } from '@/components/easyfixer/EasyfixerStatusDialog';
import { EasyfixerBankDialog } from '@/components/easyfixer/EasyfixerBankDialog';
import { EasyfixerMobileDialog } from '@/components/easyfixer/EasyfixerMobileDialog';
import { EasyfixerDeepSkillModal } from '@/components/easyfixer/EasyfixerDeepSkillModal';
import { EasyfixerTransactionsModal } from '@/components/easyfixer/EasyfixerTransactionsModal';
import { EasyfixerClientMappingModal } from '@/components/easyfixer/EasyfixerClientMappingModal';
import {
  normalizeLifecycleSnapshot,
  type EasyfixerLifecycleSnapshot,
  type EasyfixerLifecycleStatus,
} from '@/lib/easyfixer-lifecycle';
import { cn, formatEasyfixerName } from '@/lib/utils';
import { maskMobile } from '@/lib/format';
import { StrengthRing } from '@/components/easyfixer/new-reg2/ui';
import { OverviewTab } from '@/components/easyfixer/new-reg2/OverviewTab';
import { StatusHistoryTab } from '@/components/easyfixer/new-reg2/StatusHistoryTab';
import { OnboardingTab } from '@/components/easyfixer/new-reg2/OnboardingTab';
import { ProfileDocumentsTab } from '@/components/easyfixer/new-reg2/ProfileDocumentsTab';
import { WorkCoverageTab } from '@/components/easyfixer/new-reg2/WorkCoverageTab';
import { BankTab } from '@/components/easyfixer/new-reg2/BankTab';
import { TransactionsTab } from '@/components/easyfixer/new-reg2/TransactionsTab';
import { ActivityTab } from '@/components/easyfixer/new-reg2/ActivityTab';
import { TeamTab } from '@/components/easyfixer/new-reg2/TeamTab';
import type { VerificationPayload, ProfileListRow, AggregateRow } from '@/components/easyfixer/new-reg2/types';

type TabKey = 'overview' | 'status' | 'onboarding' | 'profile' | 'work' | 'bank' | 'transactions' | 'activity' | 'team';

export default function NewRegistration2ProfilePage() {
  const params = useParams<{ id: string }>();
  const efrId = Number(params.id);
  const validId = Number.isInteger(efrId) && efrId > 0;
  const { me } = useMe();
  const can = actionFlags(me, ['isEdit', 'isEasyfixerMobileUpdate', 'isEasyfixerBankUpdate', 'isEasyfixerTempInactive']);

  // ─── Data ─────────────────────────────────────────────────────────
  const { data: v, loading: vLoading, error: vError, refetch: refetchV } =
    useFetch<VerificationPayload>(validId ? `/admin/easyfixers/${efrId}/verification` : null, { enabled: validId });

  const { data: rowResp, refetch: refetchRow } =
    useFetch<{ items: ProfileListRow[]; total: number }>(validId ? `/admin/easyfixers?easyfixerId=${efrId}&status=0&limit=1` : null, { enabled: validId });
  const row = rowResp?.items?.[0] ?? null;

  // Aggregates (earnings / jobs / rating) — a POST load, so via usePostFetch
  // (module-level dedupe + Strict-Mode-safe, unlike a raw api.post in useEffect).
  const aggBody = useMemo(() => ({ efrIds: [efrId] }), [efrId]);
  const { data: aggResp } = usePostFetch<{ items: AggregateRow[] }>(
    validId ? '/admin/easyfixers/aggregates' : null, aggBody, { enabled: validId },
  );
  const agg = aggResp?.items?.[0] ?? null;

  // Lifecycle snapshot — header chip + Status tab. refetchSnap() after a change.
  const { data: snapRaw, refetch: refetchSnap } =
    useFetch<unknown>(validId ? `/admin/easyfixers/${efrId}/lifecycle-status` : null, { enabled: validId });
  const snapshot = useMemo<EasyfixerLifecycleSnapshot | null>(() => normalizeLifecycleSnapshot(snapRaw), [snapRaw]);

  // Bump to force a remount (→ fresh fetch) of the history / mappings tab bodies
  // after a mutation, without appending cache-buster query params the BE Joi
  // validators might reject.
  const [historyBump, setHistoryBump] = useState(0);
  const [mappingsBump, setMappingsBump] = useState(0);

  const reloadAll = useCallback(async () => {
    refetchV();
    refetchRow();
    refetchSnap();
  }, [refetchV, refetchRow, refetchSnap]);

  // ─── Dialog state (parent-owned so onSaved can refetch) ────────────
  const [statusOpen, setStatusOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [deepSkillOpen, setDeepSkillOpen] = useState(false);
  const [txOpen, setTxOpen] = useState(false);
  const [clientMapOpen, setClientMapOpen] = useState(false);

  const [tab, setTab] = useState<TabKey>('overview');

  const displayName = useMemo(
    () => formatEasyfixerName(v?.header.full_name ?? row?.efr_name ?? '') || `EF ${efrId}`,
    [v, row, efrId],
  );
  const active = v?.activation.is_activated ?? (row?.efr_status_label === 'Active' || row?.efr_status_label === 'Idle');
  const bankVerified = v?.registrationVerification.banking.verification_status === 1;
  const strength = row?.efr_profile_perc ?? v?.registrationVerification.overall_progress ?? 0;
  const leadsTeam = row?.ef_account === 'Master';

  const TABS: Array<[TabKey, string]> = [
    ['overview', 'Overview'],
    ['status', 'Status & History'],
    ['onboarding', 'Onboarding'],
    ['profile', 'Profile & Documents'],
    ['work', 'Work & Coverage'],
    ['bank', 'Bank'],
    ['transactions', 'Transactions'],
    ['activity', 'Activity'],
    ...(leadsTeam ? [['team', 'Team'] as [TabKey, string]] : []),
  ];

  if (!validId) {
    return (
      <div className="p-6">
        <BackLink href="/easyfixers/new-registration-2" label="All Easyfixers" />
        <div className="mt-4 text-sm text-urgent">Invalid easyfixer id.</div>
      </div>
    );
  }

  if (vLoading && !v) {
    return (
      <div className="p-6">
        <BackLink href="/easyfixers/new-registration-2" label="All Easyfixers" />
        <div className="mt-4 text-sm text-muted-foreground">Loading profile…</div>
      </div>
    );
  }

  if (vError || !v) {
    return (
      <div className="p-6">
        <BackLink href="/easyfixers/new-registration-2" label="All Easyfixers" />
        <div className="mt-4 text-sm text-urgent">{vError || 'Profile not found.'}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <BackLink href="/easyfixers/new-registration-2" label="All Easyfixers" />

      {/* Header card */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-4 p-5">
          <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl bg-brand-50 text-2xl font-semibold text-brand-700">
            {v.activation.sidebar.profile_img
              ? <img src={`/easydoc/easyfixer_documents/${v.activation.sidebar.profile_img}`} alt="" className="h-full w-full object-cover" />
              : displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-[220px] flex-1">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-bold text-ink-900">
              {displayName}
              {typeof (agg?.job_count ?? row?.job_count) === 'number' && (agg?.job_count ?? row?.job_count ?? 0) < 5 && (
                <span className="rounded-full bg-info-tint px-2 py-0.5 text-[11px] font-semibold text-info-strong">Fresher</span>
              )}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
              <span className="font-mono text-ink-700">EF {efrId}</span>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                {maskMobile(row?.efr_no ?? v.header.mobile ?? '')}
                <CallableMobile efrId={efrId} mobile={v.header.mobile} iconOnly className="text-primary" />
              </span>
              <span>·</span>
              <span>{[row?.city_name, row?.state_name].filter(Boolean).join(', ') || v.header.city_name || '—'}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <EasyfixerLifecycleChip value={row?.lifecycle_status} fallbackLabel={row?.efr_status_label} />
              {row?.efr_service_category && <span className="rounded-full border bg-muted px-2.5 py-0.5 text-xs text-ink-700">{row.efr_service_category}</span>}
            </div>
          </div>
          <StrengthRing pct={strength} />
          <div className="flex flex-col gap-2">
            {can.isEdit && <Button size="sm" onClick={() => setStatusOpen(true)}>Change status</Button>}
            <Button size="sm" variant="outline" onClick={() => setClientMapOpen(true)}>Client mapping</Button>
          </div>
        </div>
      </div>

      {/* Bank-not-verified banner */}
      {!bankVerified && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-urgent-tint p-4">
          <div className="flex-1 text-sm text-ink-900">
            <strong className="block font-semibold">⚠ Bank account not verified by Finance</strong>
            Payouts are on hold until finance verifies the account details &amp; documents.
          </div>
          <Button size="sm" onClick={() => setTab('bank')}>Review bank details</Button>
        </div>
      )}

      {/* Tab nav */}
      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              '-mb-px border-b-2 px-3.5 py-2.5 text-[13px] font-semibold transition-colors',
              tab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
            {key === 'bank' && !bankVerified && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-destructive align-middle" />}
          </button>
        ))}
      </div>

      {/* Tab bodies */}
      <div>
        {tab === 'overview' && <OverviewTab active={!!active} row={row} agg={agg} v={v} />}
        {tab === 'status' && (
          <StatusHistoryTab
            key={`status-${historyBump}`}
            efrId={efrId}
            snapshot={snapshot}
            row={row}
            canChange={!!can.isEdit}
            onChangeStatus={() => setStatusOpen(true)}
          />
        )}
        {tab === 'onboarding' && <OnboardingTab efrId={efrId} v={v} onReload={reloadAll} />}
        {tab === 'profile' && (
          <ProfileDocumentsTab
            v={v}
            row={row}
            canUpdateMobile={!!can.isEasyfixerMobileUpdate}
            onUpdateMobile={() => setMobileOpen(true)}
          />
        )}
        {tab === 'work' && (
          <WorkCoverageTab
            key={`work-${mappingsBump}`}
            efrId={efrId}
            active={!!active}
            canManageSkills={!!can.isEdit}
            onManageSkills={() => setDeepSkillOpen(true)}
          />
        )}
        {tab === 'bank' && (
          <BankTab efrId={efrId} v={v} canEditBank={!!can.isEasyfixerBankUpdate} onEditBank={() => setBankOpen(true)} onReload={reloadAll} />
        )}
        {tab === 'transactions' && <TransactionsTab efrId={efrId} onOpenFullTable={() => setTxOpen(true)} />}
        {tab === 'activity' && <ActivityTab efrId={efrId} v={v} active={!!active} onReload={reloadAll} />}
        {tab === 'team' && <TeamTab />}
      </div>

      {/* Dialogs */}
      <EasyfixerStatusDialog
        open={statusOpen}
        easyfixerId={statusOpen ? efrId : null}
        easyfixerName={displayName}
        canChange={!!can.isEdit}
        canSchedule={!!can.isEasyfixerTempInactive}
        onClose={() => setStatusOpen(false)}
        onChanged={() => { setHistoryBump((n) => n + 1); void reloadAll(); }}
      />
      <EasyfixerBankDialog
        open={bankOpen}
        easyfixer={bankOpen ? { efr_id: efrId, efr_name: displayName } : null}
        onClose={() => setBankOpen(false)}
        onUpdated={() => { void reloadAll(); }}
      />
      <EasyfixerMobileDialog
        open={mobileOpen}
        easyfixer={mobileOpen ? { efr_id: efrId, efr_name: displayName, efr_no: row?.efr_no ?? v.header.mobile ?? null } : null}
        onClose={() => setMobileOpen(false)}
        onUpdated={() => { void reloadAll(); }}
      />
      <EasyfixerDeepSkillModal
        open={deepSkillOpen}
        onClose={() => setDeepSkillOpen(false)}
        easyfixerId={deepSkillOpen ? efrId : null}
        easyfixerName={displayName}
        onUnmapped={() => { setMappingsBump((n) => n + 1); }}
      />
      <EasyfixerTransactionsModal
        open={txOpen}
        onClose={() => setTxOpen(false)}
        easyfixerId={txOpen ? efrId : null}
        easyfixerName={displayName}
        easyfixerMobile={row?.efr_no ?? v.header.mobile ?? null}
      />
      <EasyfixerClientMappingModal
        open={clientMapOpen}
        onClose={() => setClientMapOpen(false)}
        easyfixerId={clientMapOpen ? efrId : null}
        easyfixerName={displayName}
      />
    </div>
  );
}
