/*
 * Shared display formatters. Keep this file small and side-effect-free
 * so it can be imported anywhere.
 */

/*
 * INDIAN_MOBILE_REGEX — canonical 10-digit mobile-format check.
 *
 * Format: digit-1 ∈ {6,7,8,9} (the Indian carrier ranges the legacy
 * CRM has always relied on), followed by exactly 9 more digits.
 * NO country code, NO leading 0, NO spaces — the form inputs strip
 * non-digits before this gets evaluated.
 *
 * Reuse everywhere a mobile is captured:
 *   - Alt Number (JobModal Confirm + Book New Call)
 *   - Customer Mobile (Book New Call create form)
 *   - SPOC mobile fields (Add/Edit Client)
 *   - Any other phone input
 *
 * Companion helper `isValidIndianMobile()` accepts an empty string
 * as valid (most call sites treat the field as optional). Pass an
 * explicit `{ required: true }` to disallow empty.
 */
export const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

export function isValidIndianMobile(value: unknown, opts?: { required?: boolean }): boolean {
  const raw = String(value ?? '');
  if (raw === '') return !opts?.required;
  return INDIAN_MOBILE_REGEX.test(raw);
}

/*
 * Human-readable error to pair with the regex. Centralised so every
 * form's inline error reads identically.
 */
export const INDIAN_MOBILE_ERROR =
  'Must be a 10-digit Indian mobile starting with 6, 7, 8, or 9.';

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

/*
 * fmtDuration — render a number of seconds as a clock-style mm:ss string.
 *
 *   fmtDuration(0)   → '0:00'
 *   fmtDuration(75)  → '1:15'
 *   fmtDuration(605) → '10:05'
 *   fmtDuration(null)→ '0:00'
 *
 * Minutes are NOT zero-padded (so a sub-10-minute call reads "1:15", not
 * "01:15"); seconds always are. Used by the live-call timer and the
 * "Call Ended · m:ss" outcome line in LiveCallPanel.
 *
 * Distinct from ClickToCallTab's private "1m 15s" duration formatter, which
 * targets a history-table column — this one is the running-clock format.
 */
export function fmtDuration(sec: number | null): string {
  const total = sec == null || !Number.isFinite(sec) || sec < 0 ? 0 : Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/*
 * Title-case a display label coming from a DB key that may arrive as
 * lower-snake ("store_name"), lower-space ("store name"), or already
 * Title Case ("Store Name"). Normalises separators (_ / - / spaces) to
 * single spaces, then capitalises each word.
 *
 * Articles, prepositions, and "and" / "or" / "of" / "the" stay lowercase
 * when mid-phrase (per the project's Title Case convention referenced in
 * MEMORY.md / feedback_easyfix_label_casing) — except the FIRST word
 * which is always capitalised.
 *
 * Letter clusters that are clearly acronyms (all-uppercase 2+ chars in
 * the source, e.g. "GSTIN/UIN", "SKU", "AGL", "QR") are preserved as-is.
 * Hyphens inside words (e.g. "Magic-Link") are also preserved.
 *
 * Examples:
 *   titleCaseLabel('store_name')           → 'Store Name'
 *   titleCaseLabel('Pin Code')             → 'Pin Code'   (idempotent)
 *   titleCaseLabel('ask property and building name')
 *                                          → 'Ask Property and Building Name'
 *   titleCaseLabel('issue panel qr code')  → 'Issue Panel QR Code'  (QR lower-input falls back to Title-cased; preserved if already upper)
 *   titleCaseLabel('GSTIN/UIN')            → 'GSTIN/UIN' (acronyms preserved)
 */
const LOWERCASE_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor',
  'of', 'on', 'or', 'the', 'to', 'with',
]);

export function titleCaseLabel(input: unknown): string {
  if (input == null) return '';
  const raw = String(input).trim();
  if (!raw) return '';
  // Normalise separators (underscores AND hyphens-between-words become
  // spaces; in-word hyphens like "Magic-Link" survive because we split
  // on whitespace, not on hyphens).
  const spaced = raw.replace(/_+/g, ' ').replace(/\s+/g, ' ');
  const words = spaced.split(' ');
  return words.map((word, idx) => {
    if (!word) return word;
    // Acronym pass-through: 2+ uppercase letters preserved verbatim.
    // Also handles slash-joined acronyms ("GSTIN/UIN") and mixed
    // alphanumeric ("QR" inside larger tokens).
    if (/^[A-Z0-9/]+$/.test(word) && word.length >= 2) return word;
    // First word always capitalised; otherwise respect the small-words
    // lowercase list.
    const lower = word.toLowerCase();
    if (idx > 0 && LOWERCASE_WORDS.has(lower)) return lower;
    // Capitalise after each in-word hyphen too ("magic-link" → "Magic-Link").
    return lower.split('-').map((seg) => seg ? seg[0].toUpperCase() + seg.slice(1) : seg).join('-');
  }).join(' ');
}

/*
 * formatServiceAddress — the canonical single-line "Service Address" shown
 * across the CRM. Combines the parts in a FIXED order —
 * Building · Complete Address · Landmark · City · Pincode — dropping any
 * empty/whitespace-only part and joining with ' · '. Returns `fallback`
 * ('—') when nothing is set. Keep the order stable so every address reads
 * the same way everywhere it appears.
 */
export function formatServiceAddress(
  // `unknown` so callers can pass a whole job/address object directly,
  // regardless of how loosely (or strictly, via an index signature) its type
  // declares these fields. We read the 5 named parts defensively and
  // coerce/null-check each — avoids TS weak-type errors + per-site casts.
  parts: unknown,
  opts?: { separator?: string; fallback?: string },
): string {
  const p = (parts && typeof parts === 'object' ? parts : {}) as Record<string, unknown>;
  const ordered = [p.building, p.address, p.landmark, p.city_name, p.pin_code];
  const clean = ordered
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter((v) => v !== '');
  return clean.length ? clean.join(opts?.separator ?? ' · ') : (opts?.fallback ?? '—');
}
