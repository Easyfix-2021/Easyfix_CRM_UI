'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

/*
 * WebCallContext — single active BROWSER (WebRTC) call, app-wide.
 *
 * Web Call mode (voice.call.mode='web'): the operator talks from the laptop.
 * The Plivo Browser SDK logs in as a Plivo Endpoint and places the call; our
 * Voice Application's Answer URL bridges to the customer. Masking is preserved:
 * POST /admin/calls/web-start resolves the receiver server-side and returns an
 * OPAQUE one-time dialId — the browser dials the id, NOT the real number.
 *
 * The SDK is browser-only (WebRTC / getUserMedia), so it's loaded via dynamic
 * import() inside the call flow — never at module top-level — to keep Next.js
 * SSR/build safe. Login is lazy (first call) so we don't prompt for mic / login
 * on every page load.
 *
 * Single active call by design (mirrors LiveCallContext): a call in progress
 * blocks starting another.
 */

import * as React from 'react';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { shouldRetryWebCall } from '@/lib/web-call-retry';

export type WebCallStatus = 'idle' | 'connecting' | 'ringing' | 'in_progress' | 'ended' | 'failed';

// A leg that is actually up (or coming up). 'ended'/'failed' keep `active` set
// so the panel can show the outcome, but they must never block the next call.
export const isLiveWebStatus = (s: WebCallStatus) =>
  s === 'connecting' || s === 'ringing' || s === 'in_progress';

export type WebCallTarget = {
  jobId?: number;
  customerId?: number;
  efrId?: number;
  reportingContactId?: number;
  // The job whose tbl_job.client_spoc should be dialled. /web-start shares the
  // clickToCallBody validator + resolveReceiver with /click-to-call, so the
  // target works identically in web mode; it's listed here because placeWebCall
  // forwards the target's keys verbatim and an absent key would be dropped.
  spocJobId?: number;
  useAlt?: boolean;
};

export type ActiveWebCall = {
  jobCallerInfoId: number;
  toMasked: string | null;
  name: string | null;
  startedAt: number | null;   // ms epoch when answered (drives the timer)
  endedReason: string | null;
  /*
   * conferenceId — the Plivo Multi-Party Call this browser leg belongs to,
   * when the backend minted one for it. The exact twin of
   * `LiveCall.conferenceId`, and for the same reasons (see LiveCallContext for
   * the long note on why the FE must never create the room itself).
   *
   * WEB IS NOT A SECOND-CLASS MODE. `voice.call.mode` decides whether Plivo
   * rings the operator's PHONE or their BROWSER — an ergonomics setting nobody
   * would expect to decide whether a call can gain a third person. So
   * /admin/calls/web-start mints a conference exactly like /click-to-call, and
   * /api/public/plivo/web-answer joins it with the same operator XML. Dropping
   * this field on the floor here — which is what the FE did until now — was the
   * only thing making web-mode conferences invisible: the room was live, the
   * customer was in it, and the panel had no id to poll.
   *
   * Optional/nullable on purpose: createConference is fail-soft, so a web call
   * whose room could not be minted still connects on the classic bridge and
   * simply shows the can't-add-participants notice.
   */
  conferenceId: number | null;
};

type WebCallValue = {
  status: WebCallStatus;
  active: ActiveWebCall | null;
  muted: boolean;
  error: string | null;
  /*
   * configWarnings — why web calling CANNOT work in this environment, straight
   * from GET /admin/calls/web-credentials. Empty on a healthy setup.
   *
   * The server already knows: it checks PLIVO_WEB_APP_ID / PLIVO_CALLER_ID /
   * the callback base and logs each miss at error level. The FE used to
   * destructure that array away, which is how an unset PLIVO_WEB_APP_ID —
   * a token with no `app` claim, so Plivo has no Voice Application to route
   * the browser leg to and never fetches /web-answer — reached the operator as
   * a bare "Busy" chip and nothing else. Carrying it into state is the whole
   * point: the diagnostic already exists, it just never reached a human.
   */
  configWarnings: string[];
  busy: boolean;              // between click and the SDK call being placed
  /*
   * Noise Filter — the operator's preference, and whether this browser can
   * honour it (false until the SDK's worklet is ready, and forever on Safari,
   * which the SDK does not support). Toggling mid-call swaps the live mic
   * stream; toggling between calls applies to the next one.
   */
  noiseFilter: boolean;
  noiseFilterAvailable: boolean;
  toggleNoiseFilter: () => void;
  placeWebCall: (target: WebCallTarget, opts?: { callTo?: string; teleprompterSessionId?: string; flow?: string }) => Promise<void>;
  hangup: () => void;
  toggleMute: () => void;
  dismiss: () => void;
};

const Ctx = React.createContext<WebCallValue | null>(null);

// permOnClick:true → mic permission is requested at call time (not on login).
const SDK_OPTIONS = {
  debug: 'ERROR',
  permOnClick: true,
  enableTracking: true,
  closeProtection: false,
  maxAverageBitrate: 48000,
  allowMultipleIncomingCalls: false,
  // LOADS the SDK's RNNoise suppressor for the OPERATOR's mic (what the
  // customer hears). It does not filter anything by itself: the SDK applies it
  // only after client.startNoiseReduction() — see the Noise Filter preference
  // below. The worklet loads from cdn.plivo.com; Safari is skipped by the SDK.
  enableNoiseReduction: true,
};

// Per-operator Noise Filter preference (default ON). Browser-local by design:
// it is about this operator's room and headset, not about the call.
const NOISE_FILTER_LS_KEY = 'ef-noise-filter';
function readNoiseFilterPref(): boolean {
  try { return localStorage.getItem(NOISE_FILTER_LS_KEY) !== '0'; } catch { return true; }
}

// Refresh the Plivo login this long BEFORE the token's own `exp` (1h, minted by
// plivo.webAccessToken) so a call is never placed on a token about to lapse.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function WebCallProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<WebCallStatus>('idle');
  const [active, setActive] = React.useState<ActiveWebCall | null>(null);
  const [muted, setMuted] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Environment-level, NOT call-level — so dismiss() deliberately leaves it be.
  const [configWarnings, setConfigWarnings] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  // Initialised ON (the default) and synced from localStorage after mount, so
  // the SSR pass and first client render agree.
  const [noiseFilter, setNoiseFilter] = React.useState(true);
  const [noiseFilterAvailable, setNoiseFilterAvailable] = React.useState(false);
  // Read by the SDK's ready handler, which is wired once per client.
  const noiseFilterRef = React.useRef(true);
  React.useEffect(() => {
    const pref = readNoiseFilterPref();
    noiseFilterRef.current = pref;
    setNoiseFilter(pref);
  }, []);

  // Plivo client + a memoised login promise — created lazily on first call.
  const clientRef = React.useRef<any>(null);
  const loginRef = React.useRef<Promise<any> | null>(null);
  // ms epoch the current login's access token expires (its JWT `exp`).
  const tokenExpRef = React.useRef(0);
  // The company DID the browser dials INTO (a real phone number — the SDK needs
  // a valid number as the destination); the answer URL bridges to the customer.
  const callerIdRef = React.useRef<string | null>(null);
  // True once the OPERATOR clicked Hangup — so the SDK's onCallFailed('Cancelled')
  // that follows a pre-answer hangup reads as a normal "ended", not a failure.
  const endedByUserRef = React.useRef(false);
  /*
   * The audit row the browser leg belongs to, mirrored into a ref because the
   * SDK event handlers are wired ONCE inside ensureClient (memoised, empty
   * deps) and would otherwise close over the `active` of the first call
   * forever. Cleared wherever `active` is.
   */
  const activeCallIdRef = React.useRef<number | null>(null);
  // Whether the browser leg ever actually connected. Drives whether a hangup
  // is an ordinary end or the death of a leg that never came up.
  const reachedInProgressRef = React.useRef(false);
  /*
   * ONE automatic retry per operator click, for "Not Found" only (see
   * onCallFailed). Holds that click's target/opts so the retry dials exactly
   * what was asked; `used` makes a second "Not Found" a real failure.
   * startCallRef lets the once-wired SDK handler reach the CURRENT starter.
   */
  type PlaceOpts = { callTo?: string; teleprompterSessionId?: string; flow?: string };
  const retryRef = React.useRef<{ target: WebCallTarget; opts?: PlaceOpts; used: boolean } | null>(null);
  const startCallRef = React.useRef<((t: WebCallTarget, o: PlaceOpts | undefined, isRetry: boolean) => Promise<void>) | null>(null);

  /*
   * Tell the server the BROWSER leg died. The server sees the operator leg's
   * fate only through Plivo, and when Plivo never routed the call to a Voice
   * Application there is no callback to see — so this is the only signal that
   * the leg is gone, and the row would otherwise sit on "Dialling" forever.
   *
   * TELEMETRY, NEVER THE CALL: fire-and-forget, every failure swallowed. The
   * operator's leg is already dead by the time we get here; a failing POST
   * must not add a second visible error on top of the real one.
   */
  const reportWebFailure = React.useCallback((reason: string) => {
    const id = activeCallIdRef.current;
    if (!id) return;                       // nothing started ⇒ nothing to report
    try {
      // Joi caps `reason` at 120 chars — a raw SDK reason can be longer.
      void api.post(`/admin/calls/${id}/web-failed`, { reason: reason.slice(0, 120) })
        .catch(() => { /* telemetry only */ });
    } catch { /* telemetry only */ }
  }, []);

  // The Plivo SDK logs a benign console.error when we hang up a call BEFORE it
  // connects ("PlivoSDK … Outgoing call failed: Canceled"). We already handle
  // cancel as a normal end (see onCallFailed + endedByUserRef), but Next.js's
  // dev overlay surfaces that raw SDK log as a "Console Error", which reads like
  // a real failure. Filter out ONLY that one line — it must match BOTH the
  // PlivoSDK prefix AND a cancel reason — so every other error (real Plivo /
  // login / app failures) still passes through untouched. Restored on unmount.
  React.useEffect(() => {
    const orig = console.error;
    console.error = (...args: any[]) => {
      try {
        const msg = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
        if (/plivosdk/i.test(msg) && /call failed:\s*cancel/i.test(msg)) return;
      } catch { /* fall through to the original logger */ }
      orig(...args);
    };
    return () => { console.error = orig; };
  }, []);

  const resetClient = React.useCallback(() => {
    try { clientRef.current?.logout?.(); } catch { /* ignore */ }
    clientRef.current = null;
    loginRef.current = null;
  }, []);

  // Build the client (dynamic import), wire events, log in. Memoised so repeat
  // calls reuse the same logged-in endpoint — but ONLY while that login is
  // still good.
  const ensureClient = React.useCallback(async () => {
    /*
     * A STALE LOGIN FAILS AS "Not Found", AND ONLY A FRESH ONE FIXES IT.
     *
     * The access token lives 1h; this client used to be reused for the life of
     * the tab. Once the token lapsed (or the SIP registration dropped — laptop
     * sleep, network change) Plivo rejected every INVITE with 404 before routing
     * it to our Voice Application: /web-start logged a 200, /web-answer was never
     * called, and the operator saw "Not Found" on every retry until a page
     * reload fetched new credentials (Prod 2026-09-24: 13 such failures across 4
     * operators, each cleared by the next /web-credentials). So: re-login when
     * the token is near expiry OR the SDK no longer reports itself registered.
     */
    if (clientRef.current && loginRef.current) {
      const expired = Date.now() > tokenExpRef.current - TOKEN_REFRESH_MARGIN_MS;
      let registered = true;
      try { registered = clientRef.current.isRegistered?.() !== false; } catch { /* keep */ }
      if (expired || !registered) {
        resetClient();
      } else {
        await loginRef.current;
        return clientRef.current;
      }
    }
    // Per-operator access token + caller-id (gated; 409 if web mode off / Plivo
    // off). No shared endpoint password crosses the wire.
    //
    // `warnings` is the server's own read of whether this environment can place
    // a web call at all. It is NOT an error — the token is valid and login will
    // succeed — which is exactly why it has to be surfaced: without it the only
    // symptom is a "Busy" chip on every call.
    const creds = await api.get<{ token: string; callerId: string | null; warnings?: string[] }>('/admin/calls/web-credentials');
    callerIdRef.current = creds.callerId;
    // The token's own `exp` — no FE copy of the server's TTL to drift. An
    // undecodable token reads as already-expired, so the next call re-logs in.
    try { tokenExpRef.current = JSON.parse(atob(creds.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000 || 0; }
    catch { tokenExpRef.current = 0; }
    setConfigWarnings(Array.isArray(creds.warnings) ? creds.warnings : []);

    const mod: any = await import('plivo-browser-sdk');      // browser-only — never SSR'd
    const PlivoCtor = mod.Plivo || mod.default;
    const sdk = new PlivoCtor(SDK_OPTIONS);
    const client = sdk.client;
    clientRef.current = client;

    // The suppressor's worklet finished loading (never fires on Safari). Only
    // now can it be switched on — and until it is, calls go out unfiltered.
    client.on('onNoiseReductionReady', () => {
      setNoiseFilterAvailable(true);
      if (noiseFilterRef.current) void client.startNoiseReduction?.();
    });

    // Call lifecycle → UI state.
    client.on('onCalling', () => setStatus('connecting'));
    client.on('onCallRemoteRinging', () => setStatus('ringing'));
    client.on('onCallAnswered', () => {
      reachedInProgressRef.current = true;
      setStatus('in_progress');
      setActive((a) => (a ? { ...a, startedAt: Date.now() } : a));
    });
    client.on('onCallTerminated', () => setStatus((s) => (s === 'failed' ? s : 'ended')));
    client.on('onCallFailed', (reason: any) => {
      // A hangup before the call connects surfaces here as 'Cancelled' — and an
      // operator-initiated hangup too. Neither is a failure → show "Call Ended".
      const r = String(reason || '');
      if (endedByUserRef.current || /cancel/i.test(r)) {
        setStatus('ended');
        return;
      }
      // Normalise the reason to a clean chip label (shown AS the red chip).
      const pretty = /busy/i.test(r) ? 'Busy'
        : /no.?answer|noanswer|timeout|no.?user/i.test(r) ? 'No Answer'
        : /reject|declin/i.test(r) ? 'Declined'
        : (r || 'Failed');
      /*
       * "Not Found" = Plivo rejected the INVITE because this browser's login is
       * stale; the customer was never dialled (no /web-answer), so dialling
       * again is safe — and a FRESH login is exactly what fixes it. Retry once,
       * silently: the operator sees "Connecting…" instead of an error they'd
       * have to click through. The failed row is still reported for the audit.
       */
      const retry = retryRef.current;
      if (retry && shouldRetryWebCall(r, { attemptUsed: retry.used, reachedInProgress: reachedInProgressRef.current })) {
        retry.used = true;
        reportWebFailure(pretty);
        resetClient();
        setStatus('connecting');
        // Off the SDK's own event dispatch — that client was just logged out.
        setTimeout(() => { void startCallRef.current?.(retry.target, retry.opts, true); }, 0);
        return;
      }
      setStatus('failed');
      setActive((a) => (a ? { ...a, endedReason: pretty } : a));
      // The server has no other way to learn this leg died: when Plivo never
      // routed the call to a Voice Application it fetched nothing and called
      // back nowhere, so without this the row stays "Dialling" indefinitely.
      reportWebFailure(pretty);
      // SIP 404 = Plivo no longer knows this endpoint's login (see ensureClient).
      // Drop it so the operator's retry logs in afresh instead of failing again.
      if (/not.?found/i.test(r)) resetClient();
    });

    loginRef.current = new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Plivo login timed out')), 15000);
      client.on('onLogin', () => { clearTimeout(to); resolve(client); });
      client.on('onLoginFailed', (e: any) => { clearTimeout(to); reject(new Error(`Plivo login failed${e ? `: ${e}` : ''}`)); });
      try { client.loginWithAccessToken(creds.token); }
      catch (e) { clearTimeout(to); reject(e as Error); }
    });
    await loginRef.current;
    return client;
  }, [reportWebFailure, resetClient]);

  const startWebCall = React.useCallback(async (target: WebCallTarget, opts: PlaceOpts | undefined, isRetry: boolean) => {
    if (!isRetry) {
      if (busy) return;
      // Only a LIVE leg blocks. An ended/failed call is just a panel still on
      // screen — the new call below replaces `active` wholesale. (The retry
      // skips this: the leg it replaces still reads 'connecting' here.)
      if (active && isLiveWebStatus(status)) { setError('A call is already in progress — hang up the current call before starting another.'); return; }
      retryRef.current = { target, opts, used: false };
    }
    setBusy(true); setError(null); setMuted(false);
    endedByUserRef.current = false;
    reachedInProgressRef.current = false;
    try {
      let client: any;
      try {
        client = await ensureClient();
      } catch (e) {
        resetClient();                 // force a clean re-login next attempt
        throw e;
      }

      // Server resolves the receiver + returns an OPAQUE one-time dialId. In QA
      // mode the operator-supplied callTo (prefilled from PLIVO_CALL_TO) is the
      // number actually dialed — the BE requires it and never dials the customer.
      const body: Record<string, number | boolean | string> = {};
      for (const [k, v] of Object.entries(target)) if (v != null) body[k] = v as number | boolean;
      if (opts?.callTo) body.callTo = opts.callTo;
      // AI Teleprompter (additive): tag the flow + pass the session so web-answer
      // forks the call audio to STT. Absent ⇒ an ordinary web call, unchanged.
      if (opts?.teleprompterSessionId) body.teleprompterSessionId = opts.teleprompterSessionId;
      if (opts?.flow) body.flow = opts.flow;
      const resp = await api.post<{
        jobCallerInfoId: number; dialId: string; toMasked: string | null; receiverName: string | null;
        /*
         * The Multi-Party Call this browser leg was placed into. /web-start has
         * returned this since conferencing shipped; it is nullable because
         * conference creation is fail-soft, never because web mode is special.
         */
        conferenceId?: number | null;
      }>('/admin/calls/web-start', body);

      setActive({
        jobCallerInfoId: resp.jobCallerInfoId,
        toMasked: resp.toMasked,
        name: resp.receiverName ?? null,
        startedAt: null,
        endedReason: null,
        conferenceId: resp.conferenceId ?? null,
      });
      // Mirrored for the SDK handlers, which cannot see `active` (see the ref).
      activeCallIdRef.current = resp.jobCallerInfoId;
      setStatus('connecting');
      // The SDK requires a real phone number as the destination, so we dial the
      // company DID and pass the opaque dialId in a custom INVITE header; the
      // answer URL maps it → the real customer number (masking preserved).
      const dest = callerIdRef.current;
      if (!dest) throw new Error('Web calling caller-id is not configured.');
      client.call(dest, { 'X-PH-Dialid': resp.dialId });   // browser prompts for mic here (permOnClick)
    } catch (err) {
      setStatus('idle');
      setActive(null);
      activeCallIdRef.current = null;   // nothing was placed ⇒ nothing to report on
      setError(formatApiError(err, { fallback: 'Could not start the web call.' }));
    } finally {
      setBusy(false);
    }
  }, [busy, active, status, ensureClient, resetClient]);
  React.useEffect(() => { startCallRef.current = startWebCall; }, [startWebCall]);

  const placeWebCall = React.useCallback(
    (target: WebCallTarget, opts?: PlaceOpts) => startWebCall(target, opts, false),
    [startWebCall],
  );

  const hangup = React.useCallback(() => {
    endedByUserRef.current = true;   // so the SDK's follow-up onCallFailed('Cancelled') reads as a normal end
    /*
     * A leg that never reached in_progress is one the server never saw come up
     * either — and endedByUserRef makes the SDK's follow-up onCallFailed take
     * the "normal end" path, so this is the ONLY place that death is reported.
     * A leg that DID connect is left alone: Plivo's own callbacks cover it.
     */
    if (!reachedInProgressRef.current) reportWebFailure('Operator ended the call before the browser leg connected');
    try { clientRef.current?.hangup(); } catch { /* ignore */ }
    setStatus((s) => (s === 'connecting' || s === 'ringing' || s === 'in_progress' ? 'ended' : s));
  }, [reportWebFailure]);

  const toggleMute = React.useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    setMuted((m) => {
      try { if (m) c.unmute(); else c.mute(); } catch { /* ignore */ }
      return !m;
    });
  }, []);

  const toggleNoiseFilter = React.useCallback(() => {
    const next = !noiseFilterRef.current;
    noiseFilterRef.current = next;
    setNoiseFilter(next);
    try { localStorage.setItem(NOISE_FILTER_LS_KEY, next ? '1' : '0'); } catch { /* per-viewer nicety only */ }
    // Resolves false (never rejects) when unsupported; mid-call it swaps the
    // live mic stream, between calls it just arms/disarms the next one.
    const c = clientRef.current;
    try { void (next ? c?.startNoiseReduction?.() : c?.stopNoiseReduction?.()); } catch { /* ignore */ }
  }, []);

  const dismiss = React.useCallback(() => {
    setActive(null);
    activeCallIdRef.current = null;
    setStatus('idle');
    setMuted(false);
    setError(null);
    // configWarnings is NOT cleared — it describes the environment, not this
    // call, and the next call will fail for exactly the same reason.
  }, []);

  const value = React.useMemo<WebCallValue>(() => ({
    status, active, muted, error, configWarnings, busy, placeWebCall, hangup, toggleMute, dismiss,
    noiseFilter, noiseFilterAvailable, toggleNoiseFilter,
  }), [status, active, muted, error, configWarnings, busy, placeWebCall, hangup, toggleMute, dismiss,
    noiseFilter, noiseFilterAvailable, toggleNoiseFilter]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/*
 * useWebCall — access the active web call + controls. Returns inert no-ops when
 * used outside the provider so a CallButton in an unexpected subtree degrades
 * gracefully (mirrors useLiveCall).
 */
export function useWebCall(): WebCallValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    return {
      status: 'idle', active: null, muted: false, error: null, configWarnings: [], busy: false,
      placeWebCall: async () => {}, hangup: () => {}, toggleMute: () => {}, dismiss: () => {},
      noiseFilter: false, noiseFilterAvailable: false, toggleNoiseFilter: () => {},
    };
  }
  return ctx;
}
