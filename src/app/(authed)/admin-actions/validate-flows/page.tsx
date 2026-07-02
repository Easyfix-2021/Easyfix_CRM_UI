'use client';

/*
 * Validate Flows — operator smoke-tests for delivery paths. Reached from the
 * Admin Actions "Validate Flows" card (property-gated: validate.flows.emails).
 *
 * Two tools:
 *   - Verify Scheduled Jobs → link to /settings/scheduled-jobs (only rendered
 *     for operators on that page's own allowlist; the BE 403s otherwise).
 *   - Verify Notifications → a 3-tab modal (Push / SMS / WhatsApp) that resolves
 *     a technician by Easyfixer Id / device token / email / mobile and fires a
 *     TEST message on that channel via /admin/validate/{push,message}, showing
 *     the exact delivery result or failure reason.
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

type ResolvedTech = { efrId: number; name: string; mobile: string; email: string } | null;
type PushResult = { tokenPreview: string; tokenLength: number; delivered: boolean; httpStatus?: number; deadToken?: boolean; reason?: string };
type PushData = { ok: boolean; resolvedVia: string; resolvedTech: ResolvedTech; delivery: { total: number; delivered: number; failed: number }; results: PushResult[] };
type MessageData = { ok: boolean; channel: 'sms' | 'whatsapp'; resolvedVia: string; resolvedTech: ResolvedTech; to: string; result: { delivered: boolean; httpStatus?: number; reason?: string } };
type AnyData = PushData | MessageData;

type Channel = 'push' | 'sms' | 'whatsapp';
const TABS: { key: Channel; label: string }[] = [
  { key: 'push', label: 'Push' },
  { key: 'sms', label: 'SMS' },
  { key: 'whatsapp', label: 'WhatsApp' },
];

export default function ValidateFlowsPage() {
  const { me } = useMe();
  const featureAccess = useFetchOnce<{ canValidateFlows: boolean }>('/admin/access/features');
  const canValidateFlows = featureAccess.data?.canValidateFlows === true;
  const [open, setOpen] = useState(false);

  if (featureAccess.loading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
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
          Operator smoke-tests for delivery paths — verify scheduled jobs and test push / SMS /
          WhatsApp notifications end to end.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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

        <button type="button" onClick={() => setOpen(true)} className="w-full text-left">
          <Card className="hover:border-primary hover:shadow-sm transition-colors h-full">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                  <BellRing className="h-4 w-4" />
                </div>
                <h2 className="font-medium flex-1">Verify Notifications</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Send a test Push, SMS, or WhatsApp to a technician — resolve them by Easyfixer Id,
                device token, or email/mobile — and see the exact delivery result or failure reason.
              </p>
            </CardContent>
          </Card>
        </button>
      </div>

      <VerifyDeliveryModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function VerifyDeliveryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Channel>('push');
  // Shared identifiers.
  const [efrId, setEfrId] = useState('');
  const [contact, setContact] = useState('');
  // Channel-specific.
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [variablesCsv, setVariablesCsv] = useState('');

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AnyData | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const templates = useFetchOnce<{ event: string; templateName: string; recipient: string }[]>(
    '/admin/notifications/whatsapp-templates',
  );

  const anyId = Boolean(efrId.trim() || contact.trim());
  const canSubmit = tab === 'push' ? (anyId || Boolean(token.trim())) : anyId;

  function switchTab(t: Channel) {
    setTab(t);
    setResult(null); setResultMsg(null); setError(null);
  }
  function reset() {
    setEfrId(''); setContact(''); setToken(''); setMessage('');
    setTemplateName(''); setRecipientName(''); setVariablesCsv('');
    setResult(null); setResultMsg(null); setError(null); setBusy(false);
  }

  // Build the shared identifier body; returns null + sets error on a bad contact.
  function identifierBody(): Record<string, unknown> | null {
    const c = contact.trim();
    const isEmail = c.includes('@');
    const isMobile = /^\d{10}$/.test(c);
    if (c && !isEmail && !isMobile) {
      setError('Email / Mobile must be a valid email or a 10-digit mobile number.');
      return null;
    }
    const body: Record<string, unknown> = {};
    if (efrId.trim()) body.efrId = Number(efrId.trim());
    if (isEmail) body.email = c;
    if (isMobile) body.mobile = c;
    return body;
  }

  async function submit() {
    setError(null); setResult(null); setResultMsg(null);
    const id = identifierBody();
    if (id === null) return;

    let path: string;
    let body: Record<string, unknown>;
    if (tab === 'push') {
      body = { ...id };
      if (token.trim()) body.token = token.trim();
      if (Object.keys(body).length === 0) {
        setError('Provide at least one: Easyfixer Id, Device Id / Token, or Email / Mobile.');
        return;
      }
      path = '/admin/validate/push';
    } else {
      if (Object.keys(id).length === 0) {
        setError('Provide at least one: Easyfixer Id or Email / Mobile.');
        return;
      }
      body = { channel: tab, ...id };
      if (tab === 'sms') {
        if (message.trim()) body.message = message.trim();
      } else {
        if (!templateName.trim()) { setError('Pick a WhatsApp template.'); return; }
        body.templateName = templateName.trim();
        if (recipientName.trim()) body.recipientName = recipientName.trim();
        const parts = variablesCsv.split(',').map((s) => s.trim());
        const vars: Record<string, string> = {};
        parts.forEach((v, i) => { if (v) vars[String(i + 1)] = v; });
        if (Object.keys(vars).length) body.variables = vars;
      }
      path = '/admin/validate/message';
    }

    setBusy(true);
    try {
      const env = await api.post<{ data?: AnyData; message?: string } & Partial<AnyData>>(path, body);
      setResult((env?.data ?? env) as AnyData);
      setResultMsg(env?.message ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Send failed');
    } finally {
      setBusy(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(() => { onClose(); reset(); }, { when: () => !busy });
  const sendLabel = busy ? 'Sending…' : tab === 'push' ? 'Send Test Push' : tab === 'sms' ? 'Send Test SMS' : 'Send Test WhatsApp';

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Verify Notification Delivery</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 p-4">
          {/* Channel tabs */}
          <div className="inline-flex rounded-md border p-0.5 bg-muted/40">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => switchTab(t.key)}
                className={
                  'px-3 py-1 text-sm rounded '
                  + (tab === t.key ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground')
                }
              >
                {t.label}
              </button>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            Fill any one identifier{tab === 'push' ? ' (or a raw device token)' : ''}. When more than
            one is given, priority is Easyfixer Id → Email / Mobile{tab === 'push' ? ' → Device Token' : ''}.
          </p>

          {/* Shared identifiers */}
          <div className="space-y-1">
            <Label>Easyfixer Id</Label>
            <Input inputMode="numeric" value={efrId} onChange={(e) => setEfrId(e.target.value)} placeholder="e.g. 1736" />
          </div>
          <div className="space-y-1">
            <Label>Easyfixer Email / Mobile</Label>
            <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="name@email.com or 9876543210" />
          </div>

          {/* Channel-specific */}
          {tab === 'push' && (
            <div className="space-y-1">
              <Label>Device Id / Token</Label>
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="FCM registration token" />
            </div>
          )}
          {tab === 'sms' && (
            <div className="space-y-1">
              <Label>Message</Label>
              <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional — defaults to a test message" />
            </div>
          )}
          {tab === 'whatsapp' && (
            <>
              <div className="space-y-1">
                <Label>Template *</Label>
                <select
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  className="w-full h-9 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">— Select a template —</option>
                  {(templates.data ?? []).map((t) => (
                    <option key={t.templateName} value={t.templateName}>
                      {t.templateName} ({t.event})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label>Recipient Name</Label>
                <Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder="Optional" />
              </div>
              <div className="space-y-1">
                <Label>Variables</Label>
                <Input value={variablesCsv} onChange={(e) => setVariablesCsv(e.target.value)} placeholder="Comma-separated → {{1}},{{2}}… e.g. Harshit, 498079" />
              </div>
            </>
          )}

          {error && (
            <div className="rounded border bg-rose-50 border-rose-200 p-3 text-sm text-rose-700 flex gap-2">
              <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="break-words">{error}</div>
            </div>
          )}

          {result && <ResultView data={result} message={resultMsg} />}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onClose()}>Close</Button>
            <Button onClick={submit} disabled={busy || !canSubmit}>{sendLabel}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultView({ data, message }: { data: AnyData; message: string | null }) {
  const isPush = 'results' in data;
  return (
    <div className={
      'rounded border p-3 text-sm space-y-2 '
      + (data.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200')
    }>
      <div className="flex items-center gap-2 font-medium">
        {data.ok
          ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
          : <XCircle className="h-4 w-4 text-amber-600 shrink-0" />}
        <span>{message ?? (data.ok ? 'Delivered' : 'Not delivered')}</span>
      </div>
      {data.resolvedTech && (
        <div className="text-xs">
          Resolved via <strong>{data.resolvedVia}</strong>: {data.resolvedTech.name}
          {' · '}efr #{data.resolvedTech.efrId}
          {data.resolvedTech.mobile ? ` · ${data.resolvedTech.mobile}` : ''}
          {data.resolvedTech.email ? ` · ${data.resolvedTech.email}` : ''}
        </div>
      )}
      {isPush ? (
        <>
          <div className="text-xs">
            Devices: {(data as PushData).delivery.delivered}/{(data as PushData).delivery.total} delivered.
          </div>
          <div className="space-y-1">
            {(data as PushData).results.map((r, i) => (
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
        </>
      ) : (
        <div className="text-xs bg-white/70 rounded px-2 py-1 space-y-0.5">
          <div>
            <span className={(data as MessageData).result.delivered ? 'text-emerald-700 font-medium' : 'text-rose-700 font-medium'}>
              {(data as MessageData).result.delivered ? '✓ sent' : '✗ failed'}
            </span>
            {' · to '}<span className="font-mono">{(data as MessageData).to}</span>
            {(data as MessageData).result.httpStatus ? ` · HTTP ${(data as MessageData).result.httpStatus}` : ''}
          </div>
          {(data as MessageData).result.reason
            ? <div className="text-rose-600 break-all">{(data as MessageData).result.reason}</div>
            : null}
        </div>
      )}
    </div>
  );
}
