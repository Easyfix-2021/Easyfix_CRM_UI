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

/*
 * normalizeMobileDigits — sanitise a typed/pasted phone value to bare 10-digit
 * form for lookup + storage. Strips non-digits, then drops a country/trunk
 * prefix ("+91…", leading-0 STD, or "091…") — but ONLY while the value runs
 * LONGER than 10 digits, so a genuine 10-digit number (Indian mobiles start
 * 6-9) is never altered. Finally caps at 10.
 *
 *   "+91 89681 72921" → "8968172921"   (pasted country code)
 *   "08968172921"     → "8968172921"   (leading trunk 0, 11 digits)
 *   "8968172921"      → "8968172921"   (unchanged)
 *
 * Use this in every mobile input's onChange in place of a bare
 * `.replace(/\D/g,'').slice(0,10)` — that pattern silently mangles a pasted
 * +91 number into the wrong 10 digits (918968172921 → 9189687129).
 */
export function normalizeMobileDigits(raw: unknown): string {
  let d = String(raw ?? '').replace(/\D/g, '');
  while (d.length > 10 && (d.startsWith('91') || d.startsWith('0'))) {
    d = d.startsWith('91') ? d.slice(2) : d.slice(1);
  }
  return d.slice(0, 10);
}

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
 *   titleCaseLabel('issue panel QR code')  → 'Issue Panel QR Code'
 *   titleCaseLabel('issue panel qr code')  → 'Issue Panel Qr Code'
 *        ⚠ NOT recoverable. Source casing is the only signal an acronym has, so
 *        a lowercase 'qr' is indistinguishable from an ordinary word. Fix the DB
 *        label, not this function — a hard-coded acronym list would mangle every
 *        real word that collides with one.
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
  // Normalise separators: underscores become spaces, then runs of whitespace
  // collapse. Hyphens are deliberately NOT touched — we split on whitespace
  // only, so "Magic-Link" stays one word and is capitalised segment-wise below.
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
 * formatServiceAddress — the canonical "Service Address" shown across the CRM.
 *
 * tbl_address column roles (per ops 2026-07-14):
 *   - `address`  = the ACTUAL service address, populated by the booking flows
 *                  (Book New Call, bulk upload, client API, magic-link). This —
 *                  and ONLY this — IS the Service Address. Treated as
 *                  non-editable in the Confirm & Schedule view.
 *   - `building` = REPURPOSED to hold the Google-Map search text, used ONLY to
 *                  derive GPS coordinates; NOT part of the Service Address.
 *   - landmark / city / pincode stay their own fields.
 *
 * So the summary is simply the `address` value (trimmed), falling back to
 * `fallback` ('—') when absent. (Earlier revisions composed
 * building · [address] · landmark · city · pincode — retired: ops want the
 * single authoritative address string, nothing else. `opts.separator` is now
 * unused; kept for call-site signature compatibility.)
 */
export function formatServiceAddress(
  // `unknown` so callers can pass a whole job/address object directly,
  // regardless of how loosely (or strictly, via an index signature) its type
  // declares these fields. We read `address` defensively and coerce/null-check
  // it — avoids TS weak-type errors + per-site casts.
  parts: unknown,
  opts?: { separator?: string; fallback?: string },
): string {
  const p = (parts && typeof parts === 'object' ? parts : {}) as Record<string, unknown>;
  const addr = p.address == null ? '' : String(p.address).trim();
  return addr !== '' ? addr : (opts?.fallback ?? '—');
}

/*
 * "1 person" / "3 people". Interpolating a bare count next to a hard-coded
 * plural noun reads wrong at exactly 1 — which, on a two-leg ops call, is the
 * commonest case, not an edge one.
 */
export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/*
 * ─── IST datetime parsing ───────────────────────────────────────────────────
 *
 * MySQL DATETIMEs reach this app as a ZONE-LESS wall-clock string —
 * "2026-08-25 16:56:17" — because the backend pool runs `dateStrings: true`
 * with `timezone: '+05:30'`. The string is IST. It does not say so.
 *
 * `new Date("2026-08-25 16:56:17")` parses that as the BROWSER's local time.
 * On an IST machine that is right by accident; anywhere else it is wrong by
 * the offset, and a caller that then formats with `timeZone: 'Asia/Kolkata'`
 * shifts it a second time. A job stamped 00:30 IST renders as the previous day
 * for anyone abroad — the same class of bug the backend's ist-calendar helpers
 * exist to prevent on the other side of the wire.
 *
 * So: a value that carries NO zone is stamped +05:30 explicitly, and a value
 * that carries one is left alone — it is already an absolute instant, and
 * re-stamping it would corrupt a correct timestamp to fix an incorrect one.
 *
 * The zone test matches `toIstClockTime()` in lib/utils.ts, which reached the
 * same conclusion for clock times. One convention, two renderers.
 *
 * Lives here rather than in utils.ts because this module is dependency-free
 * and therefore reachable by `npm run test:build` — utils.ts imports a .tsx
 * component and cannot be compiled standalone.
 */

/** True when a string states its own UTC offset (trailing Z, +hh:mm or -hhmm). */
export function hasExplicitZone(value: string): boolean {
  return /[Zz]$|[+-]\d{2}:?\d{2}$/.test(value.trim());
}

/*
 * A bare calendar date or a zone-less datetime, and nothing else. Anchored at
 * both ends, so anything carrying an offset or a trailing Z falls through to
 * the normal Date parse rather than being re-stamped.
 */
const NAIVE_DATETIME = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?))?$/;

/**
 * Parse a value that may be an IST wall clock into a real instant.
 *
 * A Date passes through. A string with an explicit zone passes through. A
 * zone-less date or datetime is read AS IST, not as browser-local time.
 * Returns an Invalid Date for junk — callers already guard on isNaN.
 */
export function parseIstDateTime(value: string | Date): Date {
  if (value instanceof Date) return value;
  const raw = String(value).trim();
  if (!hasExplicitZone(raw)) {
    const m = raw.match(NAIVE_DATETIME);
    // A date with no time is midnight IST. Left to the default Date parse it
    // would be midnight UTC — 05:30 IST — which reads as the right day but the
    // wrong time, and as the WRONG DAY for anyone west of Greenwich.
    if (m) return new Date(`${m[1]}T${m[2] ?? '00:00:00'}+05:30`);
  }
  return new Date(raw);
}
