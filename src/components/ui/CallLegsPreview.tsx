import { Phone, ArrowRight } from 'lucide-react';

/*
 * Shared masked from→to call preview — two phone chips joined by an arrow,
 * centred. Used by BOTH the public magic-link "Need Help" / "Contact Support"
 * confirmations and the CRM operator click-to-call confirm dialog so the
 * "who will be dialled" visual is identical across the stack.
 *
 * Numbers are ALREADY masked server-side (first-4-then-bullets, +91 stripped)
 * via kaleyra.previewCallLegs — this component is display-only and never sees a
 * raw number. Renders nothing when there's no data and not loading.
 */
export function CallLegsPreview({
  from,
  to,
  suppressed = false,
  loading = false,
  className = '',
}: {
  from: string | null;
  to: string | null;
  suppressed?: boolean;
  loading?: boolean;
  className?: string;
}) {
  if (loading) {
    return <p className={`text-center text-xs text-ink-500 ${className}`}>Checking call details…</p>;
  }
  if (!from && !to) return null;

  return (
    <div className={`flex flex-col items-center gap-2 rounded-lg border border-ink-100 bg-ink-50 px-4 py-4 ${className}`}>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-100 bg-card px-3 py-1.5 shadow-sm">
          <Phone className="h-4 w-4 text-success" aria-hidden />
          <span className="font-mono text-sm font-semibold tracking-wide text-ink-900">{from || '—'}</span>
        </span>
        <ArrowRight className="h-5 w-5 shrink-0 text-ink-500" aria-hidden />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-100 bg-card px-3 py-1.5 shadow-sm">
          <Phone className="h-4 w-4 text-info" aria-hidden />
          <span className="font-mono text-sm font-semibold tracking-wide text-ink-900">{to || '—'}</span>
        </span>
      </div>
      {suppressed && (
        <p className="text-center text-xs text-warning">
          Test mode — calling is not active in this environment.
        </p>
      )}
    </div>
  );
}
