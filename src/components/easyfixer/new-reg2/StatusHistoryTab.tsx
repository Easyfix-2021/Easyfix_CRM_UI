'use client';
/*
 * Status & History tab — the primary answer to "where do I change status".
 *
 * Current lifecycle status + job-eligibility bit + status_version from the
 * lifecycle snapshot; a Change-status control that offers ONLY the allowed
 * transitions (from the snapshot) and opens the shared EasyfixerStatusDialog;
 * and the append-only lifecycle timeline from GET .../lifecycle-history.
 */
import { useFetch } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { LifecycleTransitionGuideDialog } from '@/components/easyfixer/LifecycleTransitionGuideDialog';
import {
  lifecycleLabel,
  lifecycleTargets,
  normalizeLifecycleHistory,
  type EasyfixerLifecycleSnapshot,
  type EasyfixerLifecycleStatus,
} from '@/lib/easyfixer-lifecycle';
import { formatDate } from '@/lib/utils';
import { SectionCard, Timeline } from './ui';
import type { ProfileListRow } from './types';

const DESTRUCTIVE: EasyfixerLifecycleStatus[] = ['INACTIVE', 'BLACKLISTED', 'APPLICATION_REJECTED', 'VERIFICATION_REJECTED', 'ASSESSMENT_FAILED', 'SUSPENDED'];

export function StatusHistoryTab({
  efrId,
  snapshot,
  row,
  canChange,
  onChangeStatus,
}: {
  efrId: number;
  snapshot: EasyfixerLifecycleSnapshot | null;
  row: ProfileListRow | null;
  canChange: boolean;
  onChangeStatus: (target?: EasyfixerLifecycleStatus) => void;
}) {
  // The parent remounts this tab (via a React key) after a status change, so a
  // plain key is enough to re-fetch the append-only log — no cache-buster param
  // (which the BE Joi validator could reject).
  const { data, loading } = useFetch<unknown>(
    `/admin/easyfixers/${efrId}/lifecycle-history?limit=50&offset=0`,
  );
  const history = normalizeLifecycleHistory(data, 50);

  const current = snapshot?.status ?? null;
  const targets = snapshot ? lifecycleTargets(snapshot) : [];
  const jobEligible = snapshot?.jobsAllowed;
  const paused = current === 'PAUSED';

  return (
    <div className="space-y-4">
      <SectionCard title="Lifecycle status" icon={<span>🔵</span>} right={current ? <LifecycleTransitionGuideDialog currentStatus={current} availableTransitions={targets} /> : undefined}>
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Lifecycle status</div>
            <div className={`font-bold text-2xl ${paused ? 'text-destructive' : 'text-success'}`}>
              {current ? lifecycleLabel(current) : '—'}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-1 text-xs">
              Job-eligible:
              <b className={jobEligible ? 'text-success' : 'text-destructive'}>{jobEligible == null ? '—' : jobEligible ? 'Yes' : 'No'}</b>
            </span>
            <span className="rounded-full border bg-muted px-2.5 py-1 text-xs">efr_status bit: {row?.efr_status ?? '—'}</span>
            <span className="rounded-full border bg-muted px-2.5 py-1 text-xs">status_version: {snapshot?.version ?? '—'}</span>
            {row?.is_technician_verified ? <span className="rounded-full border bg-success-tint px-2.5 py-1 text-xs text-success-strong">Verified ✓</span> : null}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Change status" icon={<span>🔀</span>} right={<span>only transitions your role allows</span>}>
        {!canChange ? (
          <p className="text-sm text-muted-foreground">You do not have permission to change this technician&apos;s status.</p>
        ) : targets.length ? (
          <>
            <div className="flex flex-wrap gap-2">
              {targets.map((t) => (
                <Button
                  key={t}
                  variant={DESTRUCTIVE.includes(t) ? 'destructive' : 'outline'}
                  size="sm"
                  onClick={() => onChangeStatus(t)}
                >
                  {current ? `${lifecycleLabel(current)} → ${lifecycleLabel(t)}` : lifecycleLabel(t)}
                </Button>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Each change asks for a <b>reason code + note</b>, is stamped with your user id &amp; time, and writes one row to the lifecycle log. Auto-rules (grade, escalations, dormancy) are applied by the evaluation cron.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No manual transitions are available from <b>{current ? lifecycleLabel(current) : 'this status'}</b> — the system drives the next move.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Lifecycle history" icon={<span>🗂️</span>} right={<span>append-only · from day one</span>}>
        {loading && !history.items.length ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <Timeline
            items={history.items.map((h) => {
              const to = h.toStatus;
              const danger = to === 'PAUSED' || DESTRUCTIVE.includes(to);
              const success = to === 'ACTIVE';
              return {
                key: h.id,
                tone: danger ? 'danger' : success ? 'success' : 'default',
                title: (
                  <span>
                    {h.fromStatus ? `${lifecycleLabel(h.fromStatus)} → ` : ''}
                    <b>{lifecycleLabel(to)}</b>
                    {h.reasonCode ? <span className="ml-1.5 rounded border bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">{h.reasonCode}</span> : null}
                  </span>
                ),
                meta: (
                  <>
                    {h.reason || '—'}
                    <br />
                    {h.actorName || 'System'} · {h.source || '—'} · {formatDate(h.createdAt)}{h.version != null ? ` · v${h.version}` : ''}
                  </>
                ),
              };
            })}
          />
        )}
      </SectionCard>
    </div>
  );
}
