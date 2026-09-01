const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  EMP_CODE_PREFIX, EMP_CODE_DIGITS, EMP_CODE_RE,
  formatEmpCode, parseEmpCodeCount, sanitiseEmpCount,
} = require('../.test-build/emp-code');

/*
 * The employee-code format, as this repo believes it.
 *
 * WHY A TEST OVER FOUR TINY FUNCTIONS. This module is one half of a format that
 * lives in two repos: the backend's lib/emp-code.js validates, and this side
 * assembles the value that gets posted. Nothing mechanically checks that the two
 * agree — they are separate repos with separate CI — so the only thing keeping
 * them together is a comment in each asking the editor to change both.
 *
 * That comment has already failed once. The prefix shipped as 'EF' on both
 * sides, the real codes turned out to be E200244, and the correction had to be
 * made twice. The backend has pinned its half to a literal ever since; this half
 * had no test at all, so a CRM-only edit would have gone out silently and turned
 * every Add User into a 400 the operator cannot act on — the form would prepend
 * a prefix the backend's regex rejects, with no clue on screen as to why.
 *
 * PINNED TO A LITERAL, deliberately, exactly as the backend's suite is. Deriving
 * the expectation from EMP_CODE_PREFIX would make this agree with any prefix
 * including one changed by accident, which is the whole failure it exists to
 * catch. If the scheme genuinely changes, this line and the backend's
 * tests/emp-code.test.js both change, in the same breath as the two modules.
 */
test('the scheme is E + 6 digits, and matches the backend byte for byte', () => {
  assert.equal(EMP_CODE_PREFIX, 'E');
  assert.equal(EMP_CODE_DIGITS, 6);
  assert.ok(EMP_CODE_RE.test('E200244'), 'a real employee code must validate');
  assert.ok(!EMP_CODE_RE.test('EF200244'), 'the retired two-letter prefix must not');
});

/*
 * The operator types a count; the form posts prefix + padded count. This is the
 * only thing the wire actually sees, so it is the assertion that matters most.
 */
test('formatEmpCode assembles exactly what the backend regex accepts', () => {
  for (const [input, expected] of [
    [1, 'E000001'], ['1', 'E000001'], [200244, 'E200244'], ['200244', 'E200244'],
    [999999, 'E999999'], ['  200244  ', 'E200244'],
  ]) {
    assert.equal(formatEmpCode(input), expected);
    assert.ok(EMP_CODE_RE.test(expected), `${expected} must satisfy the shared regex`);
  }
});

/*
 * '' rather than a half-parsed guess. The caller treats '' as "not a code" and
 * blocks the save with "Employee Code is required" — a guess would post a
 * plausible-looking code the operator never typed.
 */
test('formatEmpCode refuses what cannot be a code, rather than guessing', () => {
  for (const bad of [null, undefined, '', '   ', 'abc', 0, '0', 1000000, '1234567']) {
    assert.equal(formatEmpCode(bad), '', `${JSON.stringify(bad)} must yield ''`);
  }
});

/*
 * Round-trip. The edit dialog parses a stored code down to the bare count so the
 * operator sees the number they think in, then formats it back on save. A
 * mismatch here silently REWRITES an existing user's code on an unrelated edit.
 */
test('parse ∘ format round-trips, so opening and saving cannot rewrite a code', () => {
  for (const code of ['E000001', 'E000123', 'E200244', 'E999999']) {
    assert.equal(formatEmpCode(parseEmpCodeCount(code)), code);
  }
  assert.equal(parseEmpCodeCount('E200244'), '200244', 'leading zeros are stripped for the input');
  assert.equal(parseEmpCodeCount(' e200244 '), '200244', 'trimmed and upper-cased on the way in');
  for (const bad of [null, undefined, '', 'EF200244', 'E20024', 'E2002444', '200244']) {
    assert.equal(parseEmpCodeCount(bad), '', `${JSON.stringify(bad)} is not one of ours`);
  }
});

test('sanitiseEmpCount keeps the input inside the code width as it is typed', () => {
  assert.equal(sanitiseEmpCount('20a02b44'), '200244');
  assert.equal(sanitiseEmpCount('12345678'), '123456', 'capped at the code width');
  assert.equal(sanitiseEmpCount('abc'), '');
});
