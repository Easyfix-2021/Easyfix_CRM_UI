'use client';

import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Phone, Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { useConfirm } from '@/components/ui/confirm-dialog';

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

// ─── Shared hook — owns the confirm, POST, busy state, and toast lifecycle
function useClickToCall(jobId: number | undefined, customerId: number | undefined) {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ variant: ToastVariant; message: string } | null>(null);
  const confirm = useConfirm();

  // Success auto-dismiss; errors stay until explicitly closed.
  useEffect(() => {
    if (!toast || toast.variant !== 'success') return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const placeCall = useCallback(async (e?: React.MouseEvent) => {
    // Stop propagation in case the surface is inside a clickable row.
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (busy) return;
    const idCount = (jobId != null ? 1 : 0) + (customerId != null ? 1 : 0);
    if (idCount !== 1) return; // programming error, fail silently

    // ── Confirmation step ──
    // useConfirm renders the shared themed Dialog primitive (see
    // src/components/ui/confirm-dialog.tsx). The promise resolves false
    // on Cancel / Esc / outside-click, true on the green Confirm button.
    // Customer name/number is intentionally OMITTED from the prompt
    // because the FE doesn't possess the unmasked mobile — the backend
    // resolves it. Wording stays generic + unambiguous instead.
    const ok = await confirm({
      title: 'Call this Customer?',
      // Provider name (Kaleyra) intentionally omitted — operators don't
      // need to know which vendor we use; the bridge mechanic is what
      // matters so they know to keep their handset ready.
      description:
        'A call will be placed. Your registered mobile rings first; once you pick up, the customer’s line is dialled and bridged.',
      confirmLabel: 'Yes, call now',
      cancelLabel: 'Cancel',
      variant: 'default',
      // Phone icon in an emerald-tinted plate gives the operator instant
      // visual context — they know what kind of action they're confirming
      // before reading a word.
      icon: <Phone className="h-4 w-4" />,
      iconAccent: 'emerald',
    });
    if (!ok) return;

    setBusy(true); setToast(null);
    try {
      const body: Record<string, number> = jobId != null
        ? { jobId }
        : { customerId: customerId! };
      // The route returns a `message` but we deliberately ignore it for the
      // success toast — operator wanted a fixed, branded copy regardless of
      // whether the server hinted "overridden" or "calling shortly".
      await api.post<{ delivered: boolean; message?: string }>('/admin/calls/click-to-call', body);
      setToast({ variant: 'success', message: 'Call initiated Successfully' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Call failed';
      setToast({ variant: 'error', message: msg });
    } finally {
      setBusy(false);
    }
  }, [busy, jobId, customerId, confirm]);

  const toastNode = toast
    ? <CallToast variant={toast.variant} message={toast.message} onDismiss={() => setToast(null)} />
    : null;

  return { busy, placeCall, toastNode };
}

// ─── <CallButton> — labelled CTA (currently unused but exported) ──────
type ButtonProps = {
  jobId?: number;
  customerId?: number;
  size?: 'sm' | 'md';
  label?: string;
  className?: string;
};

export function CallButton({
  jobId, customerId, size = 'md', label = 'Call Customer', className,
}: ButtonProps) {
  const { me } = useMe();
  const { busy, placeCall, toastNode } = useClickToCall(jobId, customerId);
  if (!hasAction(me, 'isClickToCall')) return null;
  const idCount = (jobId != null ? 1 : 0) + (customerId != null ? 1 : 0);
  if (idCount !== 1) return null;

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
      {toastNode}
    </>
  );
}

// ─── <CallableMobile> — clickable mobile display ──────────────────────
type MobileProps = {
  jobId?: number;
  customerId?: number;
  mobile: string | null | undefined;
  className?: string;
  hideWhenUnauthorized?: boolean;
};

export function CallableMobile({
  jobId, customerId, mobile, className, hideWhenUnauthorized = false,
}: MobileProps) {
  const { me } = useMe();
  const { busy, placeCall, toastNode } = useClickToCall(jobId, customerId);

  const display = mobile && String(mobile).trim() !== '' ? mobile : '—';
  const can = hasAction(me, 'isClickToCall');
  const idCount = (jobId != null ? 1 : 0) + (customerId != null ? 1 : 0);
  const clickable = can && idCount === 1 && display !== '—';

  if (!clickable) {
    if (hideWhenUnauthorized && !can) return null;
    return <span className={cn('text-xs', className)}>{display}</span>;
  }

  return (
    <>
      <button
        type="button"
        onClick={placeCall}
        disabled={busy}
        title="Click to call this customer"
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
        <span className="font-mono">{display}</span>
      </button>
      {toastNode}
    </>
  );
}
