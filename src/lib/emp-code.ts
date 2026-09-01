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

/**
 * 200244 -> 'E200244'. Returns '' for anything that cannot be a code.
 *
 * ZERO IS ACCEPTED, and it did not used to be (2026-09-01). There was an
 * `n < 1` guard here so an operator could not type 0 into a mandatory field and
 * mint E000000. It looked like the careful choice and it was the wrong one.
 *
 * It never stopped E000000 EXISTING — the backend's own formatEmpCode accepts 0
 * and its regex matches the result, so a manually seeded row can hold one. What
 * the guard actually did was make that user uneditable: the dialog hydrates the
 * code down to its count ('0'), re-assembles it to '', and blocks the save with
 * "Employee Code is required" on a field the operator can see is filled. Since
 * user_code is posted on every save, that blocked changing their ROLE or their
 * STATUS too — nothing about that person could be edited from the CRM at all.
 *
 * The two failures are not the same size. Accepting 0 risks an operator minting
 * E000000, which is visible on the row, fixable with one edit, and harmless to
 * allocation (nextEmpCode takes MAX + 1, and a 0 row contributes nothing to the
 * MAX). Refusing it strands a record with no route out of the UI. So this now
 * matches the backend exactly, which is the property that was worth having:
 * every code the validator accepts, this can round-trip.
 *
 * Emptiness is still refused — `if (!digits)` above is what makes the dialog's
 * "Employee Code is required" fire, and it is untouched.
 */
export function formatEmpCode(count: string | number | null | undefined): string {
  const digits = String(count ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || digits.length > EMP_CODE_DIGITS) return '';
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
