'use client';

/*
 * Public "shared job" page — /public/shared-job/[token].
 *
 * A technician shares this link from the app; whoever opens it (any web or
 * mobile browser) sees a NON-CONFIDENTIAL slice of the job and can:
 *   - Navigate: deep-link to Google Maps turn-by-turn directions.
 *   - Call Customer: masked Plivo bridge — the visitor enters their OWN number,
 *     the server bridges them to the customer (customer number never shown).
 *
 * Read-only sibling of the job-completion page; reuses the extracted public
 * building blocks (publicFetch, InfoCard, OverlayShell, FullPageMessage,
 * CallLegsPreview). Deliberately avoids @/lib/api (no auth on this surface).
 */

import * as React from 'react';
import { useParams } from 'next/navigation';
import Image from 'next/image';
import { Wrench, MapPin, CalendarClock, Phone, FileText, Navigation, CheckCircle2 } from 'lucide-react';

import { publicFetch } from '@/lib/public-fetch';
import { InfoCard } from '@/components/public/InfoCard';
import { OverlayShell } from '@/components/public/OverlayShell';
import { FullPageMessage } from '@/components/public/FullPageMessage';
import { CallLegsPreview } from '@/components/ui/CallLegsPreview';
import { Button } from '@/components/ui/button';
import type { ShareJobResponse } from '@/lib/shared-job-types';

type PageState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: ShareJobResponse }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

// Google Maps turn-by-turn DIRECTIONS deep-link (opens the Maps app on mobile,
// web on desktop). GPS ("lat,lng") preferred; URL-encoded address fallback.
function buildDirectionsUrl(gps: string | null, address: string | null): string | null {
  const g = (gps || '').trim();
  if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(g)) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(g)}`;
  }
  if (address && address.trim()) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address.trim())}`;
  }
  return null;
}

export default function SharedJobPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token || '';

  const [state, setState] = React.useState<PageState>({ kind: 'loading' });

  // Call dialog state.
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [callStep, setCallStep] = React.useState<'number' | 'confirm'>('number');
  const [callerMobile, setCallerMobile] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  type PreviewState = null | 'loading' | { from: string | null; to: string | null; suppressed: boolean };
  const [preview, setPreview] = React.useState<PreviewState>(null);

  // Lightweight ephemeral toast (no toast lib on the public surface).
  const [toast, setToast] = React.useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = React.useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    setToast({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  React.useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  React.useEffect(() => {
    if (!token) { setState({ kind: 'invalid' }); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await publicFetch<ShareJobResponse>(`/public/shared-job/${encodeURIComponent(token)}`);
        if (!cancelled) setState({ kind: 'ready', data });
      } catch (err) {
        if (cancelled) return;
        const e = err as { status?: number; message?: string };
        if (e.status === 401) setState({ kind: 'invalid' });
        else if (e.status === 410) setState({ kind: 'expired' });
        else if (e.status === 404) setState({ kind: 'invalid' });
        else setState({ kind: 'error', message: e.message || 'Could not load these job details.' });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (state.kind === 'loading') {
    return <FullPageMessage title="Loading…" message="Fetching the job details." />;
  }
  if (state.kind === 'invalid') {
    return <FullPageMessage title="Link Not Valid" message="This job link is invalid. Ask the technician to share it again." />;
  }
  if (state.kind === 'expired') {
    return <FullPageMessage title="Link No Longer Active" message="This job link has expired or the job is already complete." />;
  }
  if (state.kind === 'error') {
    return <FullPageMessage title="Something Went Wrong" message={state.message} retry />;
  }

  const data = state.data;
  const clientName = data.client_name || 'EasyFix';
  const svc = data.service_requested[0] || null;
  const serviceLabel = svc
    ? [svc.service_type_name, svc.service_catg_name].filter(Boolean).join(' · ') || 'Service'
    : 'Service';
  const addr = data.address;
  const assembledAddress = [addr.building, addr.address, addr.city_name, addr.landmark, addr.pin_code]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(', ');
  const apptLabel = [data.schedule.requested_date_label, data.schedule.time_slot].filter(Boolean).join(' · ');
  const directionsUrl = buildDirectionsUrl(addr.gps_location, addr.address || assembledAddress || null);

  function openCallDialog() {
    setCallerMobile('');
    setCallStep('number');
    setPreview(null);
    setDialogOpen(true);
  }

  async function loadPreview() {
    if (!/^\d{10}$/.test(callerMobile)) { showToast('Enter a valid 10-digit mobile number.', 'err'); return; }
    setPreview('loading');
    try {
      const p = await publicFetch<{ from: string | null; to: string | null; suppressed: boolean }>(
        `/public/shared-job/${encodeURIComponent(token)}/customer-call/preview`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caller_mobile: callerMobile }) },
      );
      setPreview(p);
      setCallStep('confirm');
    } catch (err) {
      const e = err as { status?: number; message?: string };
      setPreview(null);
      showToast(e.message || 'Could not check call details. Please try again.', 'err');
    }
  }

  async function placeCall() {
    setBusy(true);
    try {
      const r = await publicFetch<{ delivered: boolean; suppressed?: boolean }>(
        `/public/shared-job/${encodeURIComponent(token)}/customer-call`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caller_mobile: callerMobile }) },
      );
      setDialogOpen(false);
      if (r.delivered) showToast('Connecting your call — please keep your phone handy.', 'ok');
      else if (r.suppressed) showToast('Test mode — calling is not active in this environment.', 'ok');
      else showToast('Calling is currently unavailable. Please try again later.', 'err');
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 429) showToast('Call limit reached for this job today. Please try again later.', 'err');
      else showToast(e.message || 'Could not place the call. Please try again.', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* Ephemeral toast */}
      {toast && (
        <div role="status" className={`rounded-md px-4 py-3 text-sm border ${
          toast.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'
        }`}>
          {toast.text}
        </div>
      )}

      {/* Header band — client/brand + Fulfilled by EasyFix. Same treatment as
          the job-completion page: dark slate gradient + 3px sky underline. */}
      <div className="rounded-lg bg-gradient-to-r from-slate-900 via-slate-700 to-slate-900 px-5 py-4 text-white shadow-[inset_0_-3px_0_0_rgba(14,165,233,0.85)]">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-white/70">Job For</div>
        <div className="mt-1 flex items-end justify-between gap-3 sm:items-center">
          <div className="min-w-0 truncate text-2xl font-bold leading-tight">{clientName}</div>
          <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs font-medium text-white/80 sm:flex-row sm:items-center sm:gap-2">
            <span>Fulfilled by</span>
            <Image src="/logo-full.png" alt="EasyFix" width={139} height={34} className="h-5 w-auto" priority />
          </span>
        </div>
      </div>

      <div className="px-1 text-sm text-slate-500">Job ID #{data.job_id}</div>

      {/* Service Requested */}
      <InfoCard icon={<Wrench className="h-4 w-4" />} title="Service Requested">
        <div className="text-base font-medium text-slate-800">{serviceLabel}</div>
      </InfoCard>

      {/* Issue / description */}
      {data.job_desc && (
        <InfoCard icon={<FileText className="h-4 w-4" />} title="Issue">
          <div className="text-sm text-slate-700 whitespace-pre-wrap">{data.job_desc}</div>
        </InfoCard>
      )}

      {/* Appointment */}
      {apptLabel && (
        <InfoCard icon={<CalendarClock className="h-4 w-4" />} title="Appointment">
          <div className="text-base font-semibold text-slate-900">{apptLabel}</div>
        </InfoCard>
      )}

      {/* Service Address + Navigate */}
      <InfoCard icon={<MapPin className="h-4 w-4" />} title="Service Address">
        <div className="flex w-full rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-base text-slate-600">
          {assembledAddress || '—'}
        </div>
        {addr.address_instruction && (
          <p className="text-xs text-slate-500">Landmark / instructions: {addr.address_instruction}</p>
        )}
        {directionsUrl && (
          <div className="flex justify-center">
            <a href={directionsUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-md border border-sky-300 bg-white px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50">
              <Navigation className="h-4 w-4" />
              Navigate
            </a>
          </div>
        )}
      </InfoCard>

      {/* Call Customer */}
      <InfoCard icon={<Phone className="h-4 w-4" />} title="Contact">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-slate-600">Connect to the customer — your number stays private.</div>
          <Button type="button" onClick={openCallDialog}
            className="w-full shrink-0 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 sm:w-auto">
            <Phone className="h-4 w-4" />
            Call Customer
          </Button>
        </div>
      </InfoCard>

      {/* Call dialog — step 1 number entry → step 2 masked confirm */}
      {dialogOpen && (
        <OverlayShell title="Call Customer" busy={busy} onClose={() => { if (!busy) setDialogOpen(false); }}>
          {callStep === 'number' ? (
            <>
              <p className="text-sm text-slate-600">
                Enter your mobile number so we can connect you to the customer. The customer&apos;s number stays hidden.
              </p>
              <input
                type="tel" inputMode="numeric" autoComplete="tel" placeholder="10-digit mobile"
                value={callerMobile}
                onChange={(e) => setCallerMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
                className="flex w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
              />
              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                <Button type="button" size="lg" variant="outline" onClick={() => setDialogOpen(false)} className="w-full sm:w-auto">
                  Cancel
                </Button>
                <Button type="button" size="lg" disabled={preview === 'loading'} onClick={loadPreview}
                  className="w-full sm:w-auto bg-sky-600 hover:bg-sky-700 text-white">
                  {preview === 'loading' ? 'Checking…' : 'Continue'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">Connect this call? We&apos;ll ring your phone, then the customer.</p>
              <CallLegsPreview
                loading={preview === 'loading'}
                from={preview && preview !== 'loading' ? preview.from : null}
                to={preview && preview !== 'loading' ? preview.to : null}
                suppressed={!!(preview && preview !== 'loading' && preview.suppressed)}
              />
              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                <Button type="button" size="lg" variant="outline" disabled={busy} onClick={() => setCallStep('number')} className="w-full sm:w-auto">
                  Back
                </Button>
                <Button type="button" size="lg" disabled={busy} onClick={placeCall}
                  className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white gap-2">
                  <CheckCircle2 className="h-5 w-5" />
                  {busy ? 'Connecting…' : 'Call Now'}
                </Button>
              </div>
            </>
          )}
        </OverlayShell>
      )}
    </div>
  );
}
