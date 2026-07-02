'use client';

/*
 * Validate Flows — operator smoke-tests for delivery paths. Reached from the
 * Admin Actions "Validate Flows" card (property-gated: validate.flows.emails).
 *
 * Two tools:
 *   - Verify Scheduled Jobs → link to /settings/scheduled-jobs (only rendered
 *     for operators on that page's own allowlist; the BE 403s otherwise).
 *   - Verify Push Notification → modal that resolves a technician by Easyfixer
 *     Id / device token / email / mobile and fires a TEST FCM push via
 *     POST /admin/validate/push, showing the exact delivery result or reason.
 */

import Link from 'next/link';
import { useState } from 'react';
import { Activity, CalendarClock, BellRing, CheckCircle2, XCircle, ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth-context';
import { useFetchOnce } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

type PushResult = {
  tokenPreview: string;
  tokenLength: number;
  delivered: boolean;
  httpStatus?: number;
  deadToken?: boolean;
  disabled?: boolean;
  reason?: string;
};
type PushData = {
  ok: boolean;
  resolvedVia: string;
  resolvedTech: { efrId: number; name: string; mobile: string; email: string } | null;
  delivery: { total: number; delivered: number; failed: number };
  results: PushResult[];
};

export default function ValidateFlowsPage() {
  const { me } = useMe();
  const featureAccess = useFetchOnce<{ canValidateFlows: boolean }>('/admin/access/features');
  const canValidateFlows = featureAccess.data?.canValidateFlows === true;
  const [pushOpen, setPushOpen] = useState(false);

  if (featureAccess.loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!canValidateFlows) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          You don&apos;t have access to Validate Flows. Ask an admin to add your email to the
          <code className="mx-1">validate.flows.emails</code> allowlist.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Activity className="size-6" /> Validate Flows
        </h1>
        <p className="text-sm text-muted-foreground">
          Operator smoke-tests for delivery paths — verify scheduled jobs and test push
          notifications end to end.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Verify Scheduled Jobs — only linkable for operators on the Scheduled
            Jobs allowlist; otherwise show a disabled explainer card. */}
        {me?.scheduledJobsAccess ? (
          <Link href="/settings/scheduled-jobs">
            <Card className="hover:border-primary hover:shadow-sm transition-colors h-full">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                    <CalendarClock className="h-4 w-4" />
                  </div>
                  <h2 className="font-medium flex-1">Verify Scheduled Jobs</h2>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-xs text-muted-foreground">
                  Open the Scheduled Jobs page to review registered crons and Trigger-Now a test run.
                </p>
              </CardContent>
            </Card>
          </Link>
        ) : (
          <Card className="h-full opacity-60">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-md bg-muted text-muted-foreground grid place-items-center">
                  <CalendarClock className="h-4 w-4" />
                </div>
                <h2 className="font-medium flex-1">Verify Scheduled Jobs</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                You&apos;re not on the Scheduled Jobs allowlist
                (<code>scheduled.jobs.visible.emails</code>). Ask an admin for access.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Verify Push Notification — opens the test-push modal. */}
        <button type="button" onClick={() => setPushOpen(true)} className="w-full text-left">
          <Card className="hover:border-primary hover:shadow-sm transition-colors h-full">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                  <BellRing className="h-4 w-4" />
                </div>
                <h2 className="font-medium flex-1">Verify Push Notification</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Send a test push to a technician — resolve them by Easyfixer Id, device token, or
                email/mobile — and see the exact delivery result or failure reason.
              </p>
            </CardContent>
          </Card>
        </button>
      </div>

      <VerifyPushModal open={pushOpen} onClose={() => setPushOpen(false)} />
    </div>
  );
}

/*
 * VerifyPushModal — collect any one identifier (Easyfixer Id / Device Token /
 * Email or Mobile), POST /admin/validate/push, and render the resolved tech +
 * per-token delivery verdict (or the failure reason) inline.
 */
function VerifyPushModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [efrId, setEfrId] = useState('');
  const [token, setToken] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PushData | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const anyInput = Boolean(efrId.trim() || token.trim() || contact.trim());

  function reset() {
    setEfrId(''); setToken(''); setContact('');
    setResult(null); setResultMsg(null); setError(null); setBusy(false);
  }

  async function submit() {
    setError(null); setResult(null); setResultMsg(null);
    const c = contact.trim();
    const isEmail = c.includes('@');
    const isMobile = /^\d{10}$/.test(c);
    if (c && !isEmail && !isMobile) {
      setError('Email / Mobile must be a valid email or a 10-digit mobile number.');
      return;
    }
    const body: Record<string, unknown> = {};
    if (efrId.trim()) body.efrId = Number(efrId.trim());
    if (token.trim()) body.token = token.trim();
    if (isEmail) body.email = c;
    if (isMobile) body.mobile = c;
    if (Object.keys(body).length === 0) {
      setError('Provide at least one: Easyfixer Id, Device Id / Token, or Email / Mobile.');
      return;
    }
    setBusy(true);
    try {
      const env = await api.post<{ data?: PushData; message?: string } & Partial<PushData>>(
        '/admin/validate/push',
        body,
      );
      const data = (env?.data ?? env) as PushData;
      setResult(data);
      setResultMsg(env?.message ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Push failed');
    } finally {
      setBusy(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(
    () => { onClose(); reset(); },
    { when: () => !busy },
  );

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Verify Push Notification</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 p-4">
          <p className="text-xs text-muted-foreground">
            Fill any one identifier. When more than one is given, priority is Easyfixer Id →
            Email / Mobile → Device Token.
          </p>
          <div className="space-y-1">
            <Label>Easyfixer Id</Label>
            <Input inputMode="numeric" value={efrId} onChange={(e) => setEfrId(e.target.value)} placeholder="e.g. 1736" />
          </div>
          <div className="space-y-1">
            <Label>Device Id / Token</Label>
            <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="FCM registration token" />
          </div>
          <div className="space-y-1">
            <Label>Easyfixer Email / Mobile</Label>
            <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="name@email.com or 9876543210" />
          </div>

          {error && (
            <div className="rounded border bg-rose-50 border-rose-200 p-3 text-sm text-rose-700 flex gap-2">
              <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="break-words">{error}</div>
            </div>
          )}

          {result && (
            <div className={
              'rounded border p-3 text-sm space-y-2 '
              + (result.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200')
            }>
              <div className="flex items-center gap-2 font-medium">
                {result.ok
                  ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                  : <XCircle className="h-4 w-4 text-amber-600 shrink-0" />}
                <span>{resultMsg ?? (result.ok ? 'Delivered' : 'Not delivered')}</span>
              </div>
              {result.resolvedTech && (
                <div className="text-xs">
                  Resolved via <strong>{result.resolvedVia}</strong>: {result.resolvedTech.name}
                  {' · '}efr #{result.resolvedTech.efrId}
                  {result.resolvedTech.mobile ? ` · ${result.resolvedTech.mobile}` : ''}
                  {result.resolvedTech.email ? ` · ${result.resolvedTech.email}` : ''}
                </div>
              )}
              <div className="text-xs">
                Devices: {result.delivery.delivered}/{result.delivery.total} delivered.
              </div>
              <div className="space-y-1">
                {result.results.map((r, i) => (
                  <div key={i} className="text-xs bg-white/70 rounded px-2 py-1 space-y-0.5">
                    <div>
                      <span className={r.delivered ? 'text-emerald-700 font-medium' : 'text-rose-700 font-medium'}>
                        {r.delivered ? '✓ delivered' : '✗ failed'}
                      </span>
                      {' · '}<span className="font-mono">{r.tokenPreview}</span> (len {r.tokenLength})
                      {r.httpStatus ? ` · HTTP ${r.httpStatus}` : ''}
                      {r.deadToken ? ' · DEAD TOKEN' : ''}
                    </div>
                    {r.reason ? <div className="text-rose-600 break-all">{r.reason}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onClose()}>Close</Button>
            <Button onClick={submit} disabled={busy || !anyInput}>
              {busy ? 'Sending…' : 'Send Test Push'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
