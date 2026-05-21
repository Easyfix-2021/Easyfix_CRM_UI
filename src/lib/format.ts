/*
 * Shared display formatters. Keep this file small and side-effect-free
 * so it can be imported anywhere.
 */

/*
 * maskMobile — render a mobile number with first N digits visible and
 * the rest replaced by bullets.
 *
 * Most surfaces should NOT need to call this directly. The backend's
 * /api/admin/* response middleware (EasyFix_Backend/middleware/mask-mobile.js)
 * already masks every mobile-bearing field before it crosses the wire,
 * so values rendered straight from API responses arrive pre-masked.
 *
 * Call this when:
 *   - The FE has a raw, unmasked mobile in hand (e.g. a value the operator
 *     just typed into a form, or an env-supplied test number from
 *     KALEYRA_CALL_FROM/TO, or a hardcoded fallback) and you want to
 *     display a masked version of it.
 *   - You're rendering a number that came from an endpoint outside the
 *     masking middleware's scope (e.g. /integration/v1/* — but you
 *     probably shouldn't be hitting those from the CRM).
 *
 * Idempotent: if the input already contains a bullet character we
 * assume the backend has already masked it and return verbatim. Without
 * this guard, the digit-stripping regex would erase the bullets and the
 * "≤ visible" branch would truncate "9310••••••" back to "9310" — a
 * silent data-display bug.
 */
export function maskMobile(s: unknown, visible = 4): string {
  if (s == null || s === '') return '—';
  // Coerce defensively — call sites may pass values typed as `unknown` from
  // dynamic API payloads. `String(...)` is safe even for arrays/objects;
  // garbage-shaped input still flows through the digit-strip and returns
  // `—` if no digits remain.
  const str = String(s);
  // Already-masked short-circuit. The bullet character is our sentinel.
  if (str.includes('•')) return str;
  const digits = str.replace(/\D/g, '');
  if (!digits) return '—';
  if (digits.length <= visible) return digits;
  return digits.slice(0, visible) + '•'.repeat(digits.length - visible);
}
