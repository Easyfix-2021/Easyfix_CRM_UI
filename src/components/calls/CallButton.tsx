'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Phone, Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFetchOnce } from '@/lib/hooks';
import { CallCustomNumbersDialog } from './CallCustomNumbersDialog';
import { CallLegsPreview } from '@/components/ui/CallLegsPreview';
import { useLiveCall } from './LiveCallContext';

/*
 * Click-to-call surface — two exports:
 *
 *   <CallButton>      — labelled green CTA (currently no longer rendered
 *                       anywhere in the CRM but kept as a parameterised
 *                       option for future surfaces — see history).
 *
 *   <CallableMobile>  — wraps a customer mobile-number string; clicking the
 *                       number itself fires the call. Used on list rows
 *                       (/jobs, /my-orders) and the Customer popup.
 *
 * Confirmation flow:
 *   Every click goes through useConfirm() first — a portal-themed modal
 *   ("Are you sure you want to call this customer?") replaces the previous
 *   no-confirmation behaviour. Catches accidental clicks and matches the
 *   portal's overall UX, since Kaleyra click2call rings the operator's own
 *   desk phone immediately and we don't want misclicks to interrupt them.
 *
 * Toast feedback:
 *   - Bottom-centre of viewport (was top-right), portal-rendered so it
 *     escapes every parent overflow context.
 *   - Success: solid emerald background, white text, "Call initiated
 *     Successfully" — auto-dismisses after 4s.
 *   - Error: rose background, sticky until the operator dismisses, full
 *     error text from the backend.
 *
 * Both share the same backend contract:
 *   - NEVER accepts a mobile-number prop. Only `jobId` or `customerId`.
 *   - The backend resolves the unmasked digits server-side from the joined
 *     row, so the FE never possesses the clear-text number.
 */

// ─── Toast portal — shared by both exports ─────────────────────────────
type ToastVariant = 'success' | 'error';

function CallToast({ variant, message, onDismiss }: {
  variant: ToastVariant;
  message: string;
  onDismiss: () => void;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={cn(
        // Bottom-centre placement. `left-1/2 -translate-x-1/2` is the
        // standard non-flex way to centre a fixed element. z-index is
        // deliberately high because the toast must clear every modal
        // overlay (Radix Dialog defaults to z-50).
        'fixed bottom-8 left-1/2 -translate-x-1/2 z-[9999]',
        'max-w-md min-w-[280px] shadow-xl rounded-lg px-4 py-3',
        'flex items-start gap-2 text-sm border',
        // Solid green on success — matches the portal's primary CTA palette
        // and stays legible at the bottom edge of any background. White
        // text + white icon + white close button on a saturated emerald
        // backdrop is the clearest "operation completed" signal we have.
        variant === 'success' && 'bg-emerald-600 border-emerald-700 text-white',
        // Error keeps the lighter rose tone so it doesn't look like a system
        // crash — but with a stronger ring than the old top-right chip.
        variant === 'error'   && 'bg-rose-50 border-rose-300 text-rose-800',
      )}
    >
      {variant === 'success'
        ? <CheckCircle2 className="h-5 w-5 mt-0.5 shrink-0 text-white" />
        : <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0 text-rose-600" />}
      <span className="flex-1 break-words font-medium">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className={cn(
          'rounded p-0.5 shrink-0',
          variant === 'success' ? 'hover:bg-emerald-700/40 text-white' : 'hover:bg-rose-100 text-rose-700',
        )}
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>,
    document.body,
  );
}

// ─── Provider constants (BE contract) ─────────────────────────────────
type CallProvider = 'kaleyra' | 'plivo';

const PROVIDER_LABEL: Record<CallProvider, string> = {
  kaleyra: 'Via Kaleyra',
  plivo:   'Via Plivo',
};

// localStorage key for the operator's last-chosen provider. Persisted so a
// multi-provider operator's preference sticks across sessions/page loads.
const PROVIDER_LS_KEY = 'ef-call-provider';

// ─── Provider radio (rendered inside the confirm dialog description) ───
//
// confirm() captures the `description` JSX ONCE, so a value held only in the
// hook's React state wouldn't re-render the radio when the operator clicks a
// different option. This tiny sub-component therefore owns its OWN local
// state (seeded from the hook's current choice) and reports each change back
// via onChange — which updates the hook state + persists to localStorage.
// Because the dialog re-renders THIS component (not the captured tree) on its
// internal state change, the selected radio reflects the click immediately,
// and the up-to-date value is already in the hook by the time the operator
// confirms. Kept deliberately simple and self-contained.
function ProviderRadioGroup({
  options,
  initial,
  onChange,
}: {
  options: CallProvider[];
  initial: CallProvider;
  onChange: (p: CallProvider) => void;
}) {
  const [value, setValue] = useState<CallProvider>(initial);
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Calling Provider
      </p>
      <div className="flex flex-wrap gap-4">
        {options.map((p) => (
          <label key={p} className="inline-flex cursor-pointer items-center gap-2 text-sm text-foreground/90">
            <input
              type="radio"
              name="ef-call-provider"
              value={p}
              checked={value === p}
              onChange={() => { setValue(p); onChange(p); }}
              className="h-4 w-4 accent-emerald-600"
            />
            {PROVIDER_LABEL[p]}
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Calling config + preview types (BE contract) ─────────────────────
type CallConfig = {
  mode: 'qa' | 'dev' | 'prod';
  promptForNumbers: boolean;
  /* QA-only — env defaults to pre-fill the custom-numbers dialog.
     Unmasked because env config is operator-known, not user PII. */
  qaDefaults: { from: string | null; to: string | null } | null;
  /* Multi-provider fields (BE contract, 2026-06). When more than one
     provider is enabled, the confirm dialog exposes a radio to pick the
     leg. With Plivo OFF, enabledProviders === ['kaleyra'] → the radio stays
     hidden and behaviour is identical to today. */
  enabledProviders?: CallProvider[];
  defaultProvider?: CallProvider;
};

type CallPreview = {
  mode: 'qa' | 'dev' | 'prod';
  /* BOTH masked to first-4-digits-then-bullets by the backend. */
  dialFrom: string | null;
  dialTo: string | null;
};

/* Receiver-identifier shapes accepted by the hook + components. The BE
 * resolves the unmasked mobile from whichever ONE of these is supplied
 * — never trusts a FE-supplied mobile string. */
type CallTarget = {
  jobId?: number;
  customerId?: number;
  efrId?: number;             // call a technician
  reportingContactId?: number; // call a client SPOC
  // useAlt (2026-06-03): modifier flag for the `jobId` path — when true
  // the BE dials tbl_job.additional_number (the customer's per-job
  // alternate) instead of the customer's master mobile. Ignored on
  // every other path. NOT a target key in itself; the target is still
  // `jobId`, which is why pickTargetKey filters it out below.
  useAlt?: boolean;
};

// The "target keys" are the receiver-id slots the BE selects ON;
// `useAlt` is a modifier, not a target, so it's intentionally excluded
// here (otherwise a {jobId, useAlt} target would look ambiguous to
// pickTargetKey and the call would refuse to fire).
function pickTargetKey(t: CallTarget): Exclude<keyof CallTarget, 'useAlt'> | null {
  const keys: Array<Exclude<keyof CallTarget, 'useAlt'>> = [
    'jobId', 'customerId', 'efrId', 'reportingContactId',
  ];
  const present = keys.filter((k) => t[k] != null);
  return present.length === 1 ? present[0] : null;
}

// ─── Shared hook — owns the confirm, POST, busy state, and toast lifecycle
function useClickToCall(target: CallTarget) {
  const { me } = useMe();
  const liveCall = useLiveCall();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ variant: ToastVariant; message: string } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const confirm = useConfirm();

  // Fetch the calling-mode config once (module-level dedupe inside
  // useFetchOnce means N CallableMobile instances on the same page share
  // a single round-trip). Defaults to non-prompt mode if the request
  // fails or hasn't returned yet — production-safe (operators see the
  // simple confirm, no spurious form prompt).
  const cfg = useFetchOnce<CallConfig>('/admin/calls/config');
  const promptForNumbers = cfg.data?.promptForNumbers === true;
  const qaDefaults = cfg.data?.qaDefaults ?? null;

  // Multi-provider config. With Plivo off, enabledProviders === ['kaleyra']
  // → showProviderPicker stays false and the radio never renders, so the
  // confirm dialog (and the whole flow) is identical to today.
  const enabledProviders = cfg.data?.enabledProviders;
  const defaultProvider: CallProvider = cfg.data?.defaultProvider ?? 'kaleyra';
  const showProviderPicker = (enabledProviders?.length ?? 0) > 1;

  // Chosen provider. Initialised from localStorage IF it's a currently-
  // enabled provider, else the BE default (else kaleyra). SSR-guarded.
  const [provider, setProvider] = useState<CallProvider>(defaultProvider);

  // Re-sync the initial choice once config arrives (the first render runs
  // before useFetchOnce resolves, so defaultProvider is 'kaleyra' then).
  // Only seeds — once the operator has picked, their choice owns the value.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (!enabledProviders || enabledProviders.length === 0) return;
    seededRef.current = true;
    let next: CallProvider = defaultProvider;
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem(PROVIDER_LS_KEY) as CallProvider | null;
      if (saved && enabledProviders.includes(saved)) next = saved;
    }
    setProvider(next);
  }, [enabledProviders, defaultProvider]);

  // Update + persist the operator's choice (from the radio in the dialog).
  const chooseProvider = useCallback((p: CallProvider) => {
    setProvider(p);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(PROVIDER_LS_KEY, p); } catch { /* quota / private mode — non-fatal */ }
    }
  }, []);

  // Success auto-dismiss; errors stay until explicitly closed.
  useEffect(() => {
    if (!toast || toast.variant !== 'success') return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  /*
   * Resolve the single supplied identifier into a query/body object the
   * BE understands. Returns null if zero or more-than-one identifiers
   * are present (programming error).
   */
  const targetKey = pickTargetKey(target);
  // Build the receiver-identifier body. useAlt is appended as a
  // separate boolean so the BE handler can fork on it inside the
  // jobId branch (see routes/admin/calls.js). Validator accepts it
  // alongside any target id — but only the jobId branch consumes it.
  //
  // 2026-06-05: encode useAlt as the literal boolean `true`, NOT
  // the number `1`. The BE body validator (validators/calls.validator.js)
  // declares `useAlt: Joi.boolean()` — Joi's `convert: true` coerces
  // string 'true'/'false' but not arbitrary numbers (number 1 is NOT
  // in Joi's default truthy set), so sending `useAlt: 1` was 400ing on
  // prod with "must be a boolean". Sending the actual boolean is the
  // only shape Joi.boolean() reliably accepts in a JSON body. The
  // query-side `/preview` path uses a separate `callListQuery` schema
  // with explicit string alternatives and is unaffected.
  const targetBody: Record<string, number | boolean> | null = targetKey
    ? {
        [targetKey]: target[targetKey] as number,
        ...(target.useAlt ? { useAlt: true } : {}),
      }
    : null;

  /*
   * The actual POST. Factored out so both confirmation paths (simple
   * confirm + QA-mode custom-numbers dialog) can share it. callFrom /
   * callTo are sent ONLY in QA mode; the BE rejects them otherwise (see
   * routes/admin/calls.js for the anti-spoofing guard).
   */
  // previewLegs carries the masked from/to from the just-fetched /preview
  // so a successful live-status (Plivo) call can seed the LiveCallPanel
  // header without re-deriving them. Undefined on the QA custom-numbers
  // path (which never opens the live panel anyway).
  const performCall = useCallback(async (
    callFrom?: string,
    callTo?: string,
    previewLegs?: { from: string | null; to: string | null },
    providerOverride?: CallProvider,
  ) => {
    if (busy || !targetBody) return;
    setBusy(true); setToast(null);
    try {
      // Widened to include `boolean` so `useAlt: true` from targetBody
      // type-narrows cleanly. Without this, the spread fails TS strict.
      const body: Record<string, number | string | boolean> = { ...targetBody };
      if (callFrom) body.callFrom = callFrom;
      if (callTo)   body.callTo   = callTo;
      // Always send the chosen provider. providerOverride wins when the
      // caller threaded the dialog's freshly-picked value (avoids the
      // stale-closure trap on the radio); otherwise fall back to state.
      // With Plivo off it's 'kaleyra' (the default) — the BE ignores/
      // validates it and the flow is unchanged.
      body.provider = providerOverride ?? provider;
      const resp = await api.post<{
        delivered: boolean;
        jobCallerInfoId?: number;
        provider?: string;
        supportsLiveStatus?: boolean;
        message?: string;
      }>('/admin/calls/click-to-call', body);

      // Guard FIRST: the BE returns HTTP 200 with delivered:false when it
      // ACCEPTED the request but did NOT place a call (provider disabled,
      // QA-suppressed, missing creds, caller==receiver, …). Surface the reason
      // instead of a misleading green "success" toast (or, for Plivo, opening
      // an empty live panel for a call that never happened).
      if (resp.delivered === false) {
        setToast({ variant: 'error', message: resp.message || 'Call was not placed' });
      } else if (resp.supportsLiveStatus && resp.jobCallerInfoId) {
        // Live-status path (Plivo): open the bottom-right live panel instead
        // of the fire-and-forget toast.
        liveCall.startCall({
          id: resp.jobCallerInfoId,
          fromMasked: previewLegs?.from ?? null,
          toMasked: previewLegs?.to ?? null,
        });
      } else {
        setToast({ variant: 'success', message: 'Call initiated Successfully' });
      }
    } catch (err) {
      // formatApiError unpacks `ApiError.details` (Joi 400 field-level
      // messages) so operators see "Validation failed — useAlt must be
      // a boolean" instead of the generic "Validation failed". Falls
      // through to err.message for non-validation errors and to 'Call
      // failed' if it isn't even an Error.
      setToast({ variant: 'error', message: formatApiError(err, { fallback: 'Call failed' }) });
    } finally {
      setBusy(false);
    }
  }, [busy, targetBody, provider, liveCall]);

  const placeCall = useCallback(async (e?: React.MouseEvent) => {
    // Stop propagation in case the surface is inside a clickable row.
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (busy || !targetBody) return; // missing or ambiguous target → fail silently

    // ── Branch on environment mode ──
    // QA prompt mode → custom-numbers dialog with two text inputs.
    // Everywhere else → fetch the masked preview, then show simple confirm
    // with the dial targets visible (so operator can verify before placing).
    if (promptForNumbers) {
      setCustomOpen(true);
      return;
    }

    // Fetch masked preview from the BE. Show a brief busy state during
    // the fetch — typically <100ms. Preview failure is non-fatal: we still
    // open the confirm, just without the masked dial-target line.
    //
    // Query coercion (2026-06-05): api.get's query-string signature is
    // `Record<string, string | number | undefined>` — no boolean lane
    // (booleans don't serialise unambiguously across all query parsers).
    // So we project `useAlt: true` → `useAlt: 1` for the GET path. The
    // BE's `callListQuery` schema accepts boolean / string / number for
    // useAlt (see validators/calls.validator.js), so the numeric 1 is
    // a valid wire format.
    const previewQuery: Record<string, string | number | undefined> = {};
    for (const [k, v] of Object.entries(targetBody)) {
      if (typeof v === 'boolean') previewQuery[k] = v ? 1 : 0;
      else if (typeof v === 'number' || typeof v === 'string') previewQuery[k] = v;
    }
    // Pass the chosen provider so the BE can preview the correct caller leg
    // (some providers dial from a different number). Harmless with one
    // provider — the BE just previews kaleyra's leg as before.
    previewQuery.provider = provider;
    setBusy(true);
    let preview: CallPreview | null = null;
    try {
      preview = await api.get<CallPreview>('/admin/calls/preview', previewQuery);
    } catch {
      // swallow — confirm still opens, just without preview line
    } finally {
      setBusy(false);
    }

    // Local, mutable copy of the provider the operator confirms with. The
    // radio sub-component reports changes here (and into hook state via
    // chooseProvider). Threading this value explicitly into performCall
    // sidesteps the stale-closure trap (confirm() captures the description
    // tree once; performCall closed over the pre-radio provider value).
    let chosenProvider: CallProvider = provider;

    // Build a description with two clearly separated zones:
    //   1. Prose paragraph explaining the bridge mechanic (operator's
    //      handset rings first, then customer's line).
    //   2. A verification block — emerald-tinted card with a 2-column
    //      grid so From and To values line up vertically for instant
    //      scanning. Both legs already masked to first-4-then-bullets
    //      by the BE so this is safe to display.
    // The chip is a block element (NOT inline-flex), so it cleanly sits
    // BELOW the prose instead of floating mid-sentence.
    const hasPreview = preview && (preview.dialFrom || preview.dialTo);

    const ok = await confirm({
      title: 'Call this Customer?',
      description: (
        <>
          <p className="text-foreground/85">
            A call will be placed. Your registered mobile rings first; once you pick up,
            the customer’s line is dialled and bridged.
          </p>
          {/* Provider radio — only when more than one provider is enabled.
              With Plivo off (enabledProviders === ['kaleyra']) this is
              false, so the radio never renders and the dialog is identical
              to today. */}
          {showProviderPicker && enabledProviders && (
            <ProviderRadioGroup
              options={enabledProviders}
              initial={chosenProvider}
              onChange={(p) => { chosenProvider = p; chooseProvider(p); }}
            />
          )}
          {hasPreview && (
            // Shared masked from→to preview — same component the public
            // magic-link "Need Help" / "Contact Support" confirmations use, so
            // the "who gets dialled" visual is identical across the stack.
            <CallLegsPreview from={preview!.dialFrom} to={preview!.dialTo} className="mt-3" />
          )}
        </>
      ),
      confirmLabel: 'Yes, call now',
      cancelLabel: 'Cancel',
      variant: 'default',
      icon: <Phone className="h-4 w-4" />,
      iconAccent: 'emerald',
    });
    if (!ok) return;
    await performCall(
      undefined,
      undefined,
      preview ? { from: preview.dialFrom, to: preview.dialTo } : undefined,
      chosenProvider,
    );
  }, [
    busy, targetBody, confirm, promptForNumbers, performCall,
    provider, showProviderPicker, enabledProviders, chooseProvider,
  ]);

  // The custom-numbers dialog (QA mode only) lives as a sibling node
  // returned by the hook. Pre-fill precedence:
  //   1. qaDefaults.from / qaDefaults.to from BE (env vars)
  //   2. Operator's own mobile (only for Call From; To is left blank)
  // qaDefaults are unmasked because they're operator-managed config.
  const customNode = (
    <CallCustomNumbersDialog
      open={customOpen}
      defaultFrom={qaDefaults?.from || String(me?.user?.mobile_no || '')}
      defaultTo={qaDefaults?.to || ''}
      onCancel={() => setCustomOpen(false)}
      onConfirm={(callFrom, callTo) => {
        setCustomOpen(false);
        void performCall(callFrom, callTo);
      }}
    />
  );

  const toastNode = toast
    ? <CallToast variant={toast.variant} message={toast.message} onDismiss={() => setToast(null)} />
    : null;

  return { busy, placeCall, toastNode, customNode };
}

// ─── <CallButton> — labelled CTA (currently unused but exported) ──────
type ButtonProps = CallTarget & {
  size?: 'sm' | 'md';
  label?: string;
  className?: string;
};

export function CallButton({
  jobId, customerId, efrId, reportingContactId, useAlt,
  size = 'md', label = 'Call Customer', className,
}: ButtonProps) {
  const { me } = useMe();
  const target: CallTarget = { jobId, customerId, efrId, reportingContactId, useAlt };
  const { busy, placeCall, toastNode, customNode } = useClickToCall(target);
  if (!hasAction(me, 'isClickToCall')) return null;
  if (pickTargetKey(target) == null) return null;

  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <>
      <button
        type="button"
        onClick={placeCall}
        disabled={busy}
        className={cn(
          'inline-flex items-center gap-1.5 px-3 h-9 rounded-md',
          'bg-emerald-600 text-white text-xs font-semibold shadow-sm',
          'hover:bg-emerald-700 hover:shadow-md transition-all',
          busy && 'opacity-60 cursor-wait',
          className,
        )}
      >
        {busy
          ? <Loader2 className={cn(iconSize, 'animate-spin')} />
          : <Phone className={iconSize} />}
        {busy ? 'Calling…' : label}
      </button>
      {customNode}
      {toastNode}
    </>
  );
}

// ─── <CallableMobile> — clickable mobile display ──────────────────────
type MobileProps = CallTarget & {
  mobile: string | null | undefined;
  className?: string;
  hideWhenUnauthorized?: boolean;
  /*
   * Suppresses the inline mobile-number text inside the button so the
   * affordance reads as a pure icon-button. Use when CallableMobile is
   * paired with a SEPARATE display element that already shows the
   * masked number (e.g. the Confirm & Schedule modal's Client SPOC
   * Phone field, where the masked Input shows the digits and the
   * adjacent CallableMobile is just the dial action). Defaults to
   * false to preserve every existing list/table call site where the
   * button IS the only place the number appears.
   */
  iconOnly?: boolean;
};

export function CallableMobile({
  jobId, customerId, efrId, reportingContactId, useAlt,
  mobile, className, hideWhenUnauthorized = false, iconOnly = false,
}: MobileProps) {
  const { me } = useMe();
  const target: CallTarget = { jobId, customerId, efrId, reportingContactId, useAlt };
  const { busy, placeCall, toastNode, customNode } = useClickToCall(target);

  const display = mobile && String(mobile).trim() !== '' ? mobile : '—';
  const can = hasAction(me, 'isClickToCall');
  const clickable = can && pickTargetKey(target) != null && display !== '—';

  if (!clickable) {
    if (hideWhenUnauthorized && !can) return null;
    // iconOnly callers (e.g. fields where a SEPARATE display element
    // already shows the masked digits) NEVER want the fallback span to
    // render the raw mobile — that's exactly the duplicate-display bug
    // the prop exists to prevent. Return null in iconOnly mode so the
    // affordance vanishes entirely when clickable is false (no target
    // id, or display === '—'). Non-iconOnly callers keep the original
    // span fallback so list/table cells still show the digits when the
    // call action isn't available.
    if (iconOnly) return null;
    return <span className={cn('text-xs', className)}>{display}</span>;
  }

  return (
    <>
      <button
        type="button"
        onClick={placeCall}
        disabled={busy}
        // Tooltip names the leg so hover confirms before click —
        // "Click to call alternate number" when useAlt is in effect,
        // matches the visible "Alt" pill below.
        title={useAlt ? 'Click to call alternate number' : 'Click to call this customer'}
        className={cn(
          'inline-flex items-center gap-1 text-xs',
          'text-emerald-700 hover:text-emerald-900 hover:underline',
          busy && 'opacity-60 cursor-wait',
          className,
        )}
      >
        {busy
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : <Phone className="h-3 w-3" />}
        {/* "Alt" pill (2026-06-03) — visible only when this instance
            is wired to dial the JOB's alternate number rather than
            the customer's master mobile. Amber tint distinguishes
            from the primary green-phone affordance at a glance and
            matches the warning palette used elsewhere for "not the
            default path" cues. The pill stays clickable as part of
            the same button so the operator's click target remains
            one wide tap zone. */}
        {useAlt && (
          <span className="bg-amber-100 text-amber-800 border border-amber-200 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide leading-none">
            Alt
          </span>
        )}
        {/* iconOnly suppresses the inline number text so paired display
            elements (e.g. a sibling Input showing the masked digits)
            don't render the value twice. See the prop's docstring. */}
        {!iconOnly && <span className="font-mono">{display}</span>}
      </button>
      {customNode}
      {toastNode}
    </>
  );
}
