'use client';

/*
 * CallingModeToggle — Setting → Admin Actions control to switch click-to-call
 * between Mobile (phone bridge — your phone rings first, then the customer) and
 * Web (talk from this browser via Plivo WebRTC). Persists the easyfix_properties
 * key voice.call.mode via POST /admin/calls/mode (Admin-only; the BE flushes the
 * cache so it takes effect immediately). Web mode is Plivo-only.
 */

import * as React from 'react';
import { Globe, Smartphone, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { showToast } from '@/components/ui/toast';
import { useMe } from '@/lib/auth-context';

type Cfg = { callMode?: 'web' | 'mobile'; enabledProviders?: string[] };

export function CallingModeToggle() {
  const { me } = useMe();
  const isAdmin = Number(me?.role?.role_id) === 2; // role_id 2 = Admin

  const [mode, setMode] = React.useState<'web' | 'mobile' | null>(null);
  const [plivoOn, setPlivoOn] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    api.get<Cfg>('/admin/calls/config')
      .then((c) => { if (alive) { setMode(c.callMode ?? 'mobile'); setPlivoOn(Boolean(c.enabledProviders?.includes('plivo'))); } })
      .catch(() => { if (alive) setMode('mobile'); });
    return () => { alive = false; };
  }, [isAdmin]);

  if (!isAdmin) return null;

  const choose = async (next: 'web' | 'mobile') => {
    if (saving || next === mode) return;
    setSaving(true);
    try {
      const r = await api.post<{ callMode: 'web' | 'mobile' }>('/admin/calls/mode', { mode: next });
      setMode(r.callMode);
      showToast({ variant: 'success', message: `Calling mode set to ${r.callMode === 'web' ? 'Web Call' : 'Mobile Call'}.` });
    } catch (err) {
      showToast({ variant: 'error', message: formatApiError(err, { fallback: 'Could not change calling mode.' }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {mode === 'web'
                ? <Globe className="size-4 text-sky-600" />
                : <Smartphone className="size-4 text-emerald-600" />}
              Click-to-Call Mode
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              <strong>Mobile</strong>: your phone rings first, then the customer (bridge).{' '}
              <strong>Web</strong>: talk from this browser (WebRTC) — Plivo only.
            </p>
            {!plivoOn && (
              <p className="text-xs text-amber-700 mt-1">Enable Plivo before switching to Web Call.</p>
            )}
          </div>

          <div className="inline-flex rounded-md border border-slate-300 overflow-hidden shrink-0">
            {(['mobile', 'web'] as const).map((m) => {
              const selected = mode === m;
              const disabled = saving || mode === null || (m === 'web' && !plivoOn);
              return (
                <button
                  key={m}
                  type="button"
                  disabled={disabled}
                  onClick={() => choose(m)}
                  className={[
                    'px-4 h-9 text-sm font-medium inline-flex items-center gap-1.5 transition-colors',
                    selected ? 'bg-sidebar text-sidebar-foreground' : 'bg-white text-slate-700 hover:bg-slate-50',
                    disabled && !selected ? 'opacity-50 cursor-not-allowed' : '',
                  ].join(' ')}
                >
                  {saving && !selected && <Loader2 className="size-3.5 animate-spin" />}
                  {m === 'web' ? <Globe className="size-3.5" /> : <Smartphone className="size-3.5" />}
                  {m === 'web' ? 'Web Call' : 'Mobile Call'}
                </button>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
