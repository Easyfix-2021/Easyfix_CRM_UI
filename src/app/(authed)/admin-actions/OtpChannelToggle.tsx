'use client';

/*
 * OtpChannelToggle — Setting → Admin Actions control for login OTP delivery.
 *
 * Which channel is tried FIRST when someone signs in with a MOBILE NUMBER:
 * WhatsApp (Gallabox template) or SMS (SMSCountry, DLT template). → login.otp.channel.
 *
 * The other channel ALWAYS stays as the fallback — this reorders the two, it
 * never disables one. OTP is the only way into the product, so no setting here
 * may be able to lock users out. Email-identifier logins are untouched (that
 * path is Email → WhatsApp and has no SMS leg to reorder).
 *
 * Persists via POST /admin/otp-channel (property-gated on access.otpchannel.emails;
 * the BE flushes the property cache so it applies immediately, no restart).
 */

import * as React from 'react';
import { MessageCircle, MessageSquare, Layers, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { showToast } from '@/components/ui/toast';

type Channel = 'whatsapp' | 'sms';
type Cfg = { channel?: Channel; dualChannel?: boolean; dualChannelFromProperty?: boolean };

const LABEL: Record<Channel, string> = { whatsapp: 'WhatsApp', sms: 'SMS' };

export function OtpChannelToggle() {
  // Visibility is gated by the parent on canSwitchOtpChannel, and the BE
  // enforces the same allowlist on the route — so this simply renders when
  // mounted, matching CallingModeToggle.
  const [channel, setChannel] = React.useState<Channel | null>(null);
  const [dualChannel, setDualChannel] = React.useState(false);
  const [dualFromProperty, setDualFromProperty] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [savingDual, setSavingDual] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    api.get<Cfg>('/admin/otp-channel')
      .then((c) => {
        if (!alive) return;
        setChannel((c.channel ?? 'whatsapp') as Channel);
        setDualChannel(c.dualChannel === true);
        setDualFromProperty(c.dualChannelFromProperty === true);
      })
      .catch(() => { if (alive) setChannel('whatsapp'); });
    return () => { alive = false; };
  }, []);

  const chooseDual = async (next: boolean) => {
    if (savingDual || next === dualChannel) return;
    setSavingDual(true);
    try {
      const r = await api.post<{ dualChannel: boolean; dualChannelFromProperty: boolean }>(
        '/admin/otp-channel/dual-channel', { dualChannel: next },
      );
      setDualChannel(r.dualChannel === true);
      setDualFromProperty(r.dualChannelFromProperty === true);
      showToast({
        variant: 'success',
        message: r.dualChannel
          ? 'Login OTP will now send WhatsApp and SMS together.'
          : 'Login OTP will now send one channel at a time.',
      });
    } catch (err) {
      showToast({ variant: 'error', message: formatApiError(err, { fallback: 'Could not change dual-channel sending.' }) });
    } finally {
      setSavingDual(false);
    }
  };

  const choose = async (next: Channel) => {
    if (saving || next === channel) return;
    setSaving(true);
    try {
      const r = await api.post<{ channel: Channel }>('/admin/otp-channel', { channel: next });
      // Trust the server's resolved value, not the click — it reports what
      // readers will actually resolve, not what was requested.
      setChannel(r.channel ?? next);
      showToast({ variant: 'success', message: `Login OTP will now try ${LABEL[r.channel ?? next]} first.` });
    } catch (err) {
      showToast({ variant: 'error', message: formatApiError(err, { fallback: 'Could not change the OTP channel.' }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {channel === 'sms'
                ? <MessageSquare className="size-4 text-sky-600" />
                : <MessageCircle className="size-4 text-emerald-600" />}
              Login OTP Channel
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Which channel is tried <strong>first</strong> when someone signs in with a mobile
              number. The other stays as the automatic fallback, so a user is never left without a
              way in. Email sign-ins are unaffected.
            </p>
            {dualChannel && (
              <p className="text-xs text-amber-700 mt-1">
                Send Both Channels is on, so WhatsApp and SMS go out together — this order has no
                effect until that is switched off.
              </p>
            )}
          </div>

          <div className="inline-flex rounded-md border border-slate-300 overflow-hidden shrink-0">
            {(['whatsapp', 'sms'] as const).map((c) => {
              const selected = channel === c;
              const disabled = saving || channel === null;
              return (
                <button
                  key={c}
                  type="button"
                  disabled={disabled}
                  onClick={() => void choose(c)}
                  className={[
                    'px-4 h-9 text-sm font-medium inline-flex items-center gap-1.5 transition-colors',
                    selected ? 'bg-sidebar text-sidebar-foreground' : 'bg-white text-slate-700 hover:bg-slate-50',
                    disabled && !selected ? 'opacity-50 cursor-not-allowed' : '',
                  ].join(' ')}
                >
                  {saving && !selected && <Loader2 className="size-3.5 animate-spin" />}
                  {c === 'sms' ? <MessageSquare className="size-3.5" /> : <MessageCircle className="size-3.5" />}
                  {LABEL[c]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Row 2 — Send Both Channels. The incident lever: see the BE route. */}
        <div className="flex items-center justify-between gap-4 flex-wrap border-t pt-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Layers className={`size-4 ${dualChannel ? 'text-amber-600' : 'text-slate-400'}`} />
              Send Both Channels
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Sends WhatsApp <strong>and</strong> SMS together instead of one after the other. Turn
              this on if users report missing OTPs: WhatsApp is reported as sent the moment it is
              queued, so a template problem can swallow codes without ever failing — and the SMS
              fallback only fires on a reported failure.
            </p>
            {!dualFromProperty && (
              <p className="text-xs text-muted-foreground mt-1">
                Currently following the server&apos;s environment setting. Changing it here takes
                over permanently.
              </p>
            )}
          </div>

          <div className="inline-flex rounded-md border border-slate-300 overflow-hidden shrink-0">
            {([false, true] as const).map((v) => {
              const selected = dualChannel === v;
              const disabled = savingDual || channel === null;
              return (
                <button
                  key={String(v)}
                  type="button"
                  disabled={disabled}
                  onClick={() => void chooseDual(v)}
                  className={[
                    'px-4 h-9 text-sm font-medium inline-flex items-center gap-1.5 transition-colors',
                    selected ? 'bg-sidebar text-sidebar-foreground' : 'bg-white text-slate-700 hover:bg-slate-50',
                    disabled && !selected ? 'opacity-50 cursor-not-allowed' : '',
                  ].join(' ')}
                >
                  {savingDual && !selected && <Loader2 className="size-3.5 animate-spin" />}
                  {v ? 'On' : 'Off'}
                </button>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
