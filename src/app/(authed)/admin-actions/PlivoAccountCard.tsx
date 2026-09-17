'use client';

/*
 * PlivoAccountCard — Setting → Admin Actions: the Plivo balance with this
 * month's spend beside it, calls and transcriptions as separate figures.
 *
 * GET /admin/calls/plivo-account (property-gated on access.callmode.emails, the
 * same allowlist as CallingModeToggle, so the parent mounts it on
 * canSwitchCallMode). Plivo has no usage-summary API, so the BE sums the call
 * and transcription lists in the background — minutes after a restart.
 *
 * A figure reads "Actual Cost" only when the BE says it is complete and fresh;
 * otherwise "Estimate Cost" with an (i) listing the BE's reasons (count still
 * running, last update failed). The card polls fast until both counts are
 * done. Amounts are USD (Plivo's billing currency); the month is IST.
 */

import * as React from 'react';
import { Wallet, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/tooltip';
import { useFetch } from '@/lib/hooks';

type Kind = { usd: number; count: number; ready: boolean; estimate: boolean; estimateReasons: string[] };
type PlivoAccount = {
  balance: { known: false } | { known: true; cashCredits: number; autoRecharge: boolean; lowThreshold: number };
  spend: {
    month: string;
    currency: 'USD';
    calls: Kind;
    transcriptions: Kind;
    asOf: string | null;
    refreshing: boolean;
    error: string | null;
  };
};

const usd = (n: number) => `$${n.toFixed(2)}`;

function monthLabel(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) {
  return (
    <div className="rounded-md border border-ink-300 px-3 py-2 min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone ?? ''}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  );
}

function Cost({ kind }: { kind: Kind }) {
  if (!kind.estimate) {
    return <><span className="text-xs font-normal text-muted-foreground">Actual Cost: </span>{usd(kind.usd)}</>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-xs font-normal text-warning-strong">Estimate Cost: </span>
      {usd(kind.usd)}
      <InfoTooltip label="Why Estimate" align="end" panelClassName="w-72">
        <div className="space-y-1 text-xs font-normal">
          <p className="font-semibold">Why This Is An Estimate</p>
          {kind.estimateReasons.map((r) => <p key={r}>{r}</p>)}
        </div>
      </InfoTooltip>
    </span>
  );
}

export function PlivoAccountCard() {
  const [counting, setCounting] = React.useState(true);
  const { data, loading, error } = useFetch<PlivoAccount>('/admin/calls/plivo-account', {
    refetchInterval: counting ? 5000 : 60_000,
  });
  const spend = data?.spend;
  const pending = !spend || spend.refreshing || !spend.calls.ready || !spend.transcriptions.ready;
  React.useEffect(() => { if (data) setCounting(pending); }, [data, pending]);

  const balance = data?.balance;
  const low = balance?.known === true && !balance.autoRecharge && balance.cashCredits <= balance.lowThreshold;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Wallet className="size-4 text-info" /> Plivo Account
            {spend && <span className="font-normal text-muted-foreground">· {monthLabel(spend.month)}</span>}
          </div>
          {spend?.refreshing && (
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" /> Updating
            </span>
          )}
        </div>

        {loading && !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error && !data ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : data && spend ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Stat
                label="Balance"
                value={balance?.known ? usd(balance.cashCredits) : 'Unavailable'}
                sub={balance?.known ? (balance.autoRecharge ? 'Auto-Recharge On' : low ? 'Low — Recharge Soon' : undefined) : undefined}
                tone={low ? 'text-destructive' : undefined}
              />
              <Stat
                label="Calls This Month"
                value={<Cost kind={spend.calls} />}
                sub={`${spend.calls.count.toLocaleString('en-IN')} call legs`}
              />
              <Stat
                label="Transcription This Month"
                value={<Cost kind={spend.transcriptions} />}
                sub={`${spend.transcriptions.count.toLocaleString('en-IN')} transcripts`}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              USD, summed from Plivo&apos;s call and transcription records; excludes number rental, recording storage and taxes
              {spend.asOf && ` · as of ${new Date(spend.asOf).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST`}
              {' · updates every 10 min'}
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
