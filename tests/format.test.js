'use strict';

/*
 * format — the shared display formatters.
 *
 * The one with real consequences is maskMobile: it is the last line of a
 * PRIVACY control. The backend's response middleware masks mobiles before they
 * cross the wire, so this function mostly re-masks values that are already
 * masked — which is exactly why its idempotence guard matters more than its
 * masking does. Without the guard, the digit-strip erases the bullets and the
 * "shorter than `visible`" branch truncates '9310••••••' back to '9310': a
 * masked number silently becomes a shorter masked number, and nothing looks
 * wrong on screen.
 *
 * The rest are ordinary formatters, tested for the boundaries that produce
 * user-visible nonsense — NaN, negative durations, empty strings rendering as
 * '0' instead of a dash.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const F = require('../.test-build/format.js');

// ─── isValidIndianMobile ──────────────────────────────────────────────────

test('isValidIndianMobile accepts the four Indian carrier ranges', () => {
  for (const first of ['6', '7', '8', '9']) {
    assert.equal(F.isValidIndianMobile(`${first}310000000`), true, first);
  }
});

test('isValidIndianMobile rejects everything that is not exactly ten bare digits', () => {
  const bad = [
    '5310000000',      // out-of-range first digit
    '0310000000',      // leading zero
    '931000000',       // 9 digits
    '93100000000',     // 11 digits
    '09310000000',     // leading 0 + 10 digits
    '+919310000000',   // country code
    '93100 00000',     // space
    '9310-000000',     // punctuation
    'abcdefghij',
  ];
  for (const v of bad) assert.equal(F.isValidIndianMobile(v), false, v);
});

test('isValidIndianMobile treats empty as OPTIONAL unless required is passed', () => {
  // Most call sites have an optional phone field; the flag flips that.
  assert.equal(F.isValidIndianMobile(''), true);
  assert.equal(F.isValidIndianMobile('', { required: true }), false);
});

test('isValidIndianMobile treats null/undefined as empty, not as invalid', () => {
  /*
   * Deliberate and load-bearing: an uninitialised form field arrives as
   * undefined, and flagging it invalid would light up a red border before the
   * operator has typed anything. Requiredness is the `required` flag's job.
   */
  for (const v of [null, undefined]) {
    assert.equal(F.isValidIndianMobile(v), true, String(v));
    assert.equal(F.isValidIndianMobile(v, { required: true }), false, `${String(v)} + required`);
  }
});

test('isValidIndianMobile coerces a numeric value', () => {
  // JSON payloads sometimes carry the mobile as a number.
  assert.equal(F.isValidIndianMobile(9310000000), true);
  assert.equal(F.isValidIndianMobile(310000000), false);
});

test('INDIAN_MOBILE_REGEX is anchored at both ends', () => {
  // Unanchored, 'abc9310000000xyz' would pass and a pasted vCard string would
  // sail through validation.
  assert.equal(F.INDIAN_MOBILE_REGEX.test('abc9310000000'), false);
  assert.equal(F.INDIAN_MOBILE_REGEX.test('9310000000xyz'), false);
  assert.equal(F.INDIAN_MOBILE_REGEX.global, false, 'a /g/ regex would carry lastIndex between calls');
});

// ─── maskMobile ───────────────────────────────────────────────────────────

test('maskMobile keeps the first four digits and bullets the rest', () => {
  assert.equal(F.maskMobile('9310000000'), '9310••••••');
  assert.equal(F.maskMobile('8968712921'), '8968••••••');
});

test('maskMobile honours a custom visible count', () => {
  assert.equal(F.maskMobile('9310000000', 0), '••••••••••');
  assert.equal(F.maskMobile('9310000000', 2), '93••••••••');
  assert.equal(F.maskMobile('9310000000', 10), '9310000000');
});

test('maskMobile is IDEMPOTENT — re-masking must not shorten the number', () => {
  /*
   * THE BUG THE BULLET SENTINEL EXISTS FOR. Values arriving from /api/admin/*
   * are already masked by the backend middleware. Without the short-circuit the
   * digit-strip leaves '9310', which is 4 chars — not longer than `visible` —
   * so the function returns a bare '9310' and six digits of context vanish with
   * no error anywhere.
   */
  const once = F.maskMobile('9310000000');
  assert.equal(F.maskMobile(once), once);
  assert.equal(F.maskMobile(F.maskMobile(once)), once);
  assert.equal(F.maskMobile('9310••••••'), '9310••••••');
});

test('maskMobile renders an em-dash when there is nothing to show', () => {
  for (const v of [null, undefined, '', 'abc', '---', {}]) {
    assert.equal(F.maskMobile(v), '—', JSON.stringify(v));
  }
});

test('maskMobile returns a short number unmasked rather than padding it', () => {
  assert.equal(F.maskMobile('931'), '931');
  assert.equal(F.maskMobile('9310'), '9310');
});

test('maskMobile strips separators before masking', () => {
  assert.equal(F.maskMobile('93100-00000'), '9310••••••');
  assert.equal(F.maskMobile('93100 00000'), '9310••••••');
});

test('maskMobile never leaks more digits than it was asked to show', () => {
  // The invariant that actually matters for privacy, checked over a range of
  // shapes rather than one example.
  for (const raw of ['9310000000', '8968712921', '+919310000000', '93100 00000']) {
    for (const visible of [0, 2, 4, 6]) {
      const out = F.maskMobile(raw, visible);
      const shown = out.replace(/[^0-9]/g, '');
      assert.ok(shown.length <= Math.max(visible, 0) || out === raw.replace(/\D/g, ''),
        `${raw} @${visible} → ${out} exposed ${shown.length} digits`);
    }
  }
});

// ─── fmtDuration ──────────────────────────────────────────────────────────

test('fmtDuration renders m:ss with unpadded minutes and padded seconds', () => {
  assert.equal(F.fmtDuration(0), '0:00');
  assert.equal(F.fmtDuration(5), '0:05');
  assert.equal(F.fmtDuration(75), '1:15');
  assert.equal(F.fmtDuration(605), '10:05');
  assert.equal(F.fmtDuration(59), '0:59');
  assert.equal(F.fmtDuration(60), '1:00');
});

test('fmtDuration keeps counting in minutes past an hour — it is a call timer, not a clock', () => {
  assert.equal(F.fmtDuration(3600), '60:00');
  assert.equal(F.fmtDuration(3665), '61:05');
});

test('fmtDuration renders 0:00 for anything unusable instead of NaN:NaN', () => {
  for (const v of [null, undefined, -1, -3600, NaN, Infinity, -Infinity]) {
    assert.equal(F.fmtDuration(v), '0:00', String(v));
  }
});

test('fmtDuration floors fractional seconds', () => {
  assert.equal(F.fmtDuration(75.9), '1:15');
});

// ─── titleCaseLabel ───────────────────────────────────────────────────────

test('titleCaseLabel normalises DB keys into Title Case labels', () => {
  assert.equal(F.titleCaseLabel('store_name'), 'Store Name');
  assert.equal(F.titleCaseLabel('store name'), 'Store Name');
  assert.equal(F.titleCaseLabel('STORE_NAME'), 'STORE NAME', 'all-caps tokens are read as acronyms');
});

test('titleCaseLabel is idempotent on already-formatted labels', () => {
  for (const s of ['Pin Code', 'Store Name', 'Ask Property and Building Name']) {
    assert.equal(F.titleCaseLabel(s), s, s);
  }
});

test('titleCaseLabel lowercases small words mid-phrase but never the first', () => {
  assert.equal(F.titleCaseLabel('ask property and building name'), 'Ask Property and Building Name');
  assert.equal(F.titleCaseLabel('date of birth'), 'Date of Birth');
  assert.equal(F.titleCaseLabel('the store'), 'The Store', 'first word is always capitalised');
  assert.equal(F.titleCaseLabel('and then'), 'And Then');
});

test('titleCaseLabel preserves acronyms that arrive already uppercase', () => {
  assert.equal(F.titleCaseLabel('GSTIN/UIN'), 'GSTIN/UIN');
  assert.equal(F.titleCaseLabel('SKU code'), 'SKU Code');
  assert.equal(F.titleCaseLabel('issue panel QR code'), 'Issue Panel QR Code');
});

test('titleCaseLabel CANNOT recover an acronym typed in lowercase', () => {
  /*
   * Documented limitation, pinned so nobody "fixes" it by hard-coding a list of
   * known acronyms — the source casing is the only signal available, and
   * guessing would mangle ordinary words. Fix the DB label, not this function.
   */
  assert.equal(F.titleCaseLabel('issue panel qr code'), 'Issue Panel Qr Code');
});

test('titleCaseLabel capitalises across in-word hyphens without splitting them', () => {
  assert.equal(F.titleCaseLabel('magic-link'), 'Magic-Link');
  assert.equal(F.titleCaseLabel('pre-paid order'), 'Pre-Paid Order');
});

test('titleCaseLabel collapses runs of separators', () => {
  assert.equal(F.titleCaseLabel('store___name'), 'Store Name');
  assert.equal(F.titleCaseLabel('  store   name  '), 'Store Name');
});

test('titleCaseLabel returns an empty string for nothing, never "null"', () => {
  for (const v of [null, undefined, '', '   ']) {
    assert.equal(F.titleCaseLabel(v), '', JSON.stringify(v));
  }
});

// ─── formatServiceAddress ─────────────────────────────────────────────────

test('formatServiceAddress returns the address column and nothing else', () => {
  /*
   * `building` is REPURPOSED to hold Google-Map search text and is explicitly
   * NOT part of the service address. An earlier revision composed
   * building · address · landmark · city · pincode; ops retired it. This test
   * pins the retirement so the composite cannot creep back.
   */
  const row = {
    address: '10, Sector 44 Rd, Gurugram',
    building: 'Kanhai Colony Sector 44 Gurgaon',   // map-search text — must not appear
    landmark: 'Near the park',
    city: 'Gurugram',
    pin_code: '122003',
  };
  assert.equal(F.formatServiceAddress(row), '10, Sector 44 Rd, Gurugram');
});

test('formatServiceAddress trims and falls back to an em-dash', () => {
  assert.equal(F.formatServiceAddress({ address: '  10, Sector 44  ' }), '10, Sector 44');
  for (const v of [{}, { address: '' }, { address: '   ' }, { address: null }, null, undefined, 'nonsense']) {
    assert.equal(F.formatServiceAddress(v), '—', JSON.stringify(v));
  }
});

test('formatServiceAddress honours a custom fallback', () => {
  assert.equal(F.formatServiceAddress({}, { fallback: 'No address on file' }), 'No address on file');
  assert.equal(F.formatServiceAddress({ address: 'x' }, { fallback: 'unused' }), 'x');
});
