'use client';

/*
 * CallingModeToggle — Setting → Admin Actions control for click-to-call.
 *
 *  • Mode: Mobile (phone bridge — your phone rings first, then the customer) vs
 *    Web (talk from this browser via Plivo WebRTC). → voice.call.mode.
 *  • Default Provider:
 *      - Web mode  → Plivo only (shown read-only; web is Plivo-exclusive).
 *      - Mobile mode → Plivo / Kaleyra / No Default. → voice.default.provider
 *        ('No Default' stores blank, so the per-call provider radio decides when
 *        more than one provider is enabled).
 *
 * Persists via POST /admin/calls/mode + /admin/calls/default-provider (Admin-only;
 * BE flushes the property cache so changes take effect without a restart). After
 * a change it evicts the shared /admin/calls/config cache so CallButton picks it
 * up on its next mount.
 */

import * as React from 'react';
import { Globe, Smartphone, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { showToast } from '@/components/ui/toast';
import { invalidateFetch } from '@/lib/hooks';

type Provider = '' | 'plivo' | 'kaleyra';
type Cfg = { callMode?: 'web' | 'mobile'; enabledProviders?: string[]; defaultProviderRaw?: Provider };

const PROVIDER_CHOICES: { value: Provider; label: string }[] = [
  { value: 'plivo', label: 'Plivo' },
  { value: 'kaleyra', label: 'Kaleyra' },
  { value: '', label: 'No Default' },
];

export function CallingModeToggle() {
  // Visibility is gated by the parent (admin-actions page) on the
  // canSwitchCallMode property flag, and the BE enforces the same
  // easyfix_properties allowlist on /admin/calls/mode + /default-provider — so
  // this component simply renders whenever it is mounted.
  const [mode, setMode] = React.useState<'web' | 'mobile' | null>(null);
  const [plivoOn, setPlivoOn] = React.useState(false);
  const [defaultProvider, setDefaultProvider] = React.useState<Provider>('');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    api.get<Cfg>('/admin/calls/config')
      .then((c) => {
        if (!alive) return;
        setMode(c.callMode ?? 'mobile');
        setPlivoOn(Boolean(c.enabledProviders?.includes('plivo')));
        setDefaultProvider((c.defaultProviderRaw ?? '') as Provider);
      })
      .catch(() => { if (alive) setMode('mobile'); });
    return () => { alive = false; };
  }, []);

  const chooseMode = async (next: 'web' | 'mobile') => {
    if (saving || next === mode) return;
    setSaving(true);
    try {
      const r = await api.post<{ callMode: 'web' | 'mobile' }>('/admin/calls/mode', { mode: next });
      setMode(r.callMode);
      invalidateFetch((k) => k.startsWith('/admin/calls/config'));
      showToast({ variant: 'success', message: `Calling mode set to ${r.callMode === 'web' ? 'Web Call' : 'Mobile Call'}.` });
    } catch (err) {
      showToast({ variant: 'error', message: formatApiError(err, { fallback: 'Could not change calling mode.' }) });
    } finally {
      setSaving(false);
    }
  };

  const chooseProvider = async (next: Provider) => {
    if (saving || next === defaultProvider) return;
    setSaving(true);
    try {
      const r = await api.post<{ defaultProviderRaw: Provider }>('/admin/calls/default-provider', { provider: next });
      setDefaultProvider((r.defaultProviderRaw ?? '') as Provider);
      invalidateFetch((k) => k.startsWith('/admin/calls/config'));
      showToast({ variant: 'success', message: `Default provider set to ${next === '' ? 'No Default' : next === 'plivo' ? 'Plivo' : 'Kaleyra'}.` });
    } catch (err) {
      showToast({ variant: 'error', message: formatApiError(err, { fallback: 'Could not change default provider.' }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        {/* Row 1 — Mode (Mobile / Web) */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {mode === 'web'
                ? <Globe className="size-4 text-info" />
                : <Smartphone className="size-4 text-success" />}
              Click-to-Call Mode
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              <strong>Mobile</strong>: your phone rings first, then the customer (bridge).{' '}
              <strong>Web</strong>: talk from this browser (WebRTC) — Plivo only.
            </p>
            {!plivoOn && (
              <p className="text-xs text-warning-strong mt-1">Enable Plivo before switching to Web Call.</p>
            )}
          </div>

          <div className="inline-flex rounded-md border border-ink-300 overflow-hidden shrink-0">
            {(['mobile', 'web'] as const).map((m) => {
              const selected = mode === m;
              const disabled = saving || mode === null || (m === 'web' && !plivoOn);
              return (
                <button
                  key={m}
                  type="button"
                  disabled={disabled}
                  onClick={() => chooseMode(m)}
                  className={[
                    'px-4 h-9 text-sm font-medium inline-flex items-center gap-1.5 transition-colors',
                    selected ? 'bg-sidebar text-sidebar-foreground' : 'bg-card text-ink-700 hover:bg-ink-50',
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

        {/* Row 2 — Default Provider (mode-dependent) */}
        {mode && (
          <div className="flex items-center justify-between gap-4 flex-wrap border-t pt-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Default Provider</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {mode === 'web'
                  ? 'Web calls always use Plivo (browser WebRTC) — not switchable.'
                  : 'Provider used when the operator doesn’t pick one. “No Default” lets them choose per call (when more than one is enabled).'}
              </p>
            </div>

            {mode === 'web' ? (
              <span className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-sidebar text-sidebar-foreground text-sm font-medium shrink-0">
                <Globe className="size-3.5" /> Plivo
              </span>
            ) : (
              <div className="inline-flex rounded-md border border-ink-300 overflow-hidden shrink-0">
                {PROVIDER_CHOICES.map((p) => {
                  const selected = defaultProvider === p.value;
                  const disabled = saving || (p.value === 'plivo' && !plivoOn);
                  return (
                    <button
                      key={p.value || 'none'}
                      type="button"
                      disabled={disabled}
                      onClick={() => chooseProvider(p.value)}
                      className={[
                        'px-4 h-9 text-sm font-medium inline-flex items-center gap-1.5 transition-colors',
                        selected ? 'bg-sidebar text-sidebar-foreground' : 'bg-card text-ink-700 hover:bg-ink-50',
                        disabled && !selected ? 'opacity-50 cursor-not-allowed' : '',
                      ].join(' ')}
                    >
                      {saving && !selected && <Loader2 className="size-3.5 animate-spin" />}
                      {p.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
