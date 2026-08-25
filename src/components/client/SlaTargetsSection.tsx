'use client';

/*
 * Client Profile → SLA & Priorities.
 *
 * The contracted performance targets this client is judged against, read from
 * GET /admin/clients/:clientId/targets — a passthrough of the SAME service
 * (services/client-target.service.js) the client portal's Performance book
 * compares its numbers to. Operator and client therefore read one set of
 * figures; a second copy in the CRM would drift the first time a contract
 * changed.
 *
 * ─── 'source' IS THE MOST IMPORTANT FIELD ON THE SCREEN ─────────────────────
 * A missing easyfix_client_target row is NORMAL — most clients have never had
 * one configured, and the service falls back to platform defaults so the
 * Performance book stays renderable. Rendering those defaults as if they were
 * contracted would turn "what we hold ourselves to" into "what we promised
 * them", which is exactly the sentence nobody wants to discover in a QBR. So
 * the banner states which it is, every time.
 *
 * READ-ONLY. Nothing in the platform writes easyfix_client_target yet, so this
 * section shows and explains rather than offering an edit that has no writer.
 */

import { ShieldCheck, Info } from 'lucide-react';
import { StatusChip } from '@/components/ui/StatusChip';
import { useFetch } from '@/lib/hooks';
import type { ClientTargets } from '@/lib/client-types';
import { SectionShell } from '@/components/client/SectionShell';

const METRICS: Array<{ key: keyof ClientTargets; label: string; unit: string; note: string }> = [
  { key: 'sla_pct',  label: 'SLA Met', unit: '%', note: 'Share of jobs meeting every EasyFix-owned TAT segment.' },
  { key: 'ftfr_pct', label: 'First-Time Fix Rate', unit: '%', note: 'Closed on the first visit, no revisit raised.' },
  { key: 'revisit_pct', label: 'Revisit Rate', unit: '%', note: 'Lower is better.' },
  { key: 'avg_age_days', label: 'Average Age At Close', unit: ' days', note: 'Lower is better.' },
  { key: 'approval_response_hours', label: 'Approval Response', unit: ' hrs', note: 'The CLIENT-owned clock — how fast they approve an estimate.' },
];

export function SlaTargetsSection({ clientId }: { clientId: number }) {
  const { data, loading, error } = useFetch<ClientTargets>(`/admin/clients/${clientId}/targets`);
  const contracted = data?.source === 'contracted';

  return (
    <SectionShell
      title="SLA & Priorities"
      note="The performance targets this client's numbers are judged against."
    >
      {error && <p className="text-sm text-urgent-strong">{error}</p>}
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && (
        <>
          <div
            className={`text-xs rounded px-3 py-2 flex items-start gap-2 border ${
              contracted
                ? 'bg-success-tint text-success-strong border-success'
                : 'bg-warning-tint text-warning-strong border-warning'
            }`}
          >
            {contracted ? <ShieldCheck className="size-4 mt-0.5 shrink-0" /> : <Info className="size-4 mt-0.5 shrink-0" />}
            <span>
              {contracted
                ? 'These are CONTRACTED targets — a row exists for this client in easyfix_client_target.'
                : 'No contracted targets are configured for this client, so the PLATFORM DEFAULTS are shown. They are what EasyFix holds itself to, not a commitment made to this client.'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {METRICS.map((m) => {
              const dir = data.directions?.[m.key as string];
              return (
                <div key={String(m.key)} className="rounded border bg-card px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1 flex-wrap">
                    {m.label}
                    <StatusChip tone="neutral" size="sm">
                      {dir === 'lower' ? 'Lower Is Better' : 'Higher Is Better'}
                    </StatusChip>
                  </div>
                  <div className="text-lg font-semibold tabular-nums mt-0.5">
                    {String(data[m.key])}{m.unit}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{m.note}</p>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-muted-foreground border-t pt-3">
            Targets are configured directly in <span className="font-mono">easyfix_client_target</span>;
            no screen writes them yet. The signed SLA document belongs in the
            Overview document checklist.
          </p>
        </>
      )}
    </SectionShell>
  );
}
