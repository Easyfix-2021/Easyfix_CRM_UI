/*
 * Employee code — ONE definition of the format, shared by every screen that
 * shows or edits it.
 *
 * The stored value on tbl_user.user_code is the whole string, the prefix plus
 * six zero-padded digits (E200244). The operator only ever edits the COUNT: the
 * prefix is rendered as a fixed affix beside the input, exactly like the
 * `@easyfix.in` suffix on Official Email, so a foreign prefix cannot be typed.
 *
 * This mirrors the backend's lib/emp-code.js. Two copies of a format is how a
 * format drifts, so if either side changes, change both in the same commit —
 * the backend is the one that validates, and a frontend that pads differently
 * just produces a 400 the operator cannot act on.
 */

/*
 * A PARAMETER, not a literal. It was briefly 'EF' — the real codes already in
 * the business are E200244, one letter. Everything below derives from these two
 * constants, so a future change is one line here and one in the backend's
 * lib/emp-code.js. They must change together: this side renders the prefix as a
 * fixed affix and posts only the digits, so a disagreement produces a 400 the
 * operator cannot act on.
 */
export const EMP_CODE_PREFIX = 'E';
export const EMP_CODE_DIGITS = 6;
export const EMP_CODE_RE = new RegExp(`^${EMP_CODE_PREFIX}\\d{${EMP_CODE_DIGITS}}$`);

/** 200244 -> 'E200244'. Returns '' for anything that cannot be a code. */
export function formatEmpCode(count: string | number | null | undefined): string {
  const digits = String(count ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || n < 1 || digits.length > EMP_CODE_DIGITS) return '';
  return EMP_CODE_PREFIX + digits.padStart(EMP_CODE_DIGITS, '0');
}

/**
 * 'E200244' -> '200244'. Leading zeros are STRIPPED so the operator edits the
 * number they think in, not a padded string — formatEmpCode pads it back on the
 * way out. A value that is not a well-formed code yields '' rather than a
 * half-parsed guess.
 */
export function parseEmpCodeCount(code: string | null | undefined): string {
  const raw = String(code ?? '').trim().toUpperCase();
  if (!EMP_CODE_RE.test(raw)) return '';
  return String(Number(raw.slice(EMP_CODE_PREFIX.length)));
}

/** Digits-only, capped at the code width — for onChange on the count input. */
export function sanitiseEmpCount(value: string): string {
  return value.replace(/\D+/g, '').slice(0, EMP_CODE_DIGITS);
}
