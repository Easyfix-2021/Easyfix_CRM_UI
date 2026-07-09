'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';

/*
 * Canonical "back" control — ArrowLeft + label as a text hyperlink (hover
 * underline), matching the pattern hand-rolled across the detail pages
 * (customers/[id], settings/zones/[zoneId], easyfixers verification). Not a
 * styled Button.
 *
 * Two modes:
 *   - `href` given  → deterministic "return to origin" (router.push). Use
 *     when the caller knows where back should go (e.g. a `?from=` param).
 *   - no `href`     → smart back: browser-back when history exists, else
 *     fall back to `fallback`. Use on pages reached from the sidebar where
 *     "wherever we came from" is the right target.
 */
export function BackLink({
  href,
  label = 'Back',
  fallback = '/',
  className,
}: {
  href?: string;
  label?: string;
  fallback?: string;
  className?: string;
}) {
  const router = useRouter();

  const onClick = () => {
    if (href) {
      router.push(href);
      return;
    }
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(fallback);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={className ?? 'text-sm text-primary inline-flex items-center gap-1 hover:underline'}
    >
      <ArrowLeft className="size-4" /> {label}
    </button>
  );
}
