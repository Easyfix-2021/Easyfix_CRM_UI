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

/* ─── pluralize ───────────────────────────────────────────────────────────
 *
 * Exists because the call panels interpolated a count next to a hard-coded
 * plural and rendered "1 other people on it" — on the two-leg call that is the
 * commonest shape in ops, not an edge case. n === 1 is the whole point of the
 * function, so that is what is pinned here.
 */
test('pluralize picks the singular at exactly 1', () => {
  assert.equal(F.pluralize(1, 'person', 'people'), '1 person');
  assert.equal(F.pluralize(2, 'person', 'people'), '2 people');
  assert.equal(F.pluralize(0, 'person', 'people'), '0 people');
  // The panels also pass a two-word noun for the stranded-room copy.
  assert.equal(F.pluralize(1, 'other person', 'other people'), '1 other person');
});

test('pluralize defaults the plural to a trailing s', () => {
  assert.equal(F.pluralize(1, 'leg'), '1 leg');
  assert.equal(F.pluralize(3, 'leg'), '3 legs');
});

// ─── parseIstDateTime ─────────────────────────────────────────────────────
/*
 * THE FAILURE THIS PREVENTS IS INVISIBLE ON AN IST MACHINE. MySQL DATETIMEs
 * arrive zone-less ("2026-08-25 16:56:17") and mean IST, but the plain Date
 * constructor reads them as BROWSER-LOCAL. Every developer here is in IST, so
 * the bug tests clean locally and only shows up for a user abroad — as a
 * timestamp off by the offset, or a job stamped just after midnight rendering
 * on the previous day.
 *
 * These assertions compare against a FIXED absolute instant, so they hold no
 * matter what TZ the test process runs in. Run the file under
 * `TZ=America/New_York node --test` and it must still pass; that is the whole
 * point.
 */
const IST = (iso) => new Date(iso).getTime();

test('a zone-less MySQL DATETIME is read as IST, not as browser-local time', () => {
  assert.equal(
    F.parseIstDateTime('2026-08-25 16:56:17').getTime(),
    IST('2026-08-25T16:56:17+05:30'),
  );
});

test('the T-separated form is treated identically', () => {
  assert.equal(
    F.parseIstDateTime('2026-08-25T16:56:17').getTime(),
    IST('2026-08-25T16:56:17+05:30'),
  );
});

test('a date with no time is MIDNIGHT IST, not midnight UTC', () => {
  // The default parse makes a bare date midnight UTC = 05:30 IST, which reads
  // as the right day but the wrong time — and the WRONG DAY west of Greenwich.
  assert.equal(F.parseIstDateTime('2026-08-25').getTime(), IST('2026-08-25T00:00:00+05:30'));
});

test('a value that STATES its zone is left alone', () => {
  // Re-stamping this would corrupt a correct timestamp in order to fix an
  // incorrect one.
  assert.equal(F.parseIstDateTime('2026-08-25T11:26:17Z').getTime(), IST('2026-08-25T11:26:17Z'));
  assert.equal(F.parseIstDateTime('2026-08-25T16:56:17+05:30').getTime(), IST('2026-08-25T16:56:17+05:30'));
  assert.equal(F.parseIstDateTime('2026-08-25T06:56:17-05:00').getTime(), IST('2026-08-25T06:56:17-05:00'));
});

test('a Date passes through untouched', () => {
  const d = new Date('2026-08-25T11:26:17Z');
  assert.equal(F.parseIstDateTime(d), d, 'same object — nothing to re-interpret');
});

test('fractional seconds still count as zone-less', () => {
  assert.equal(
    F.parseIstDateTime('2026-08-25T16:56:17.250').getTime(),
    IST('2026-08-25T16:56:17.250+05:30'),
  );
});

test('junk returns an Invalid Date rather than throwing — callers guard on isNaN', () => {
  assert.ok(Number.isNaN(F.parseIstDateTime('not a date').getTime()));
});

test('hasExplicitZone does not mistake the date separators for an offset', () => {
  assert.equal(F.hasExplicitZone('2026-08-25 16:56:17'), false,
    'the hyphens in the DATE must not read as a negative UTC offset');
  assert.equal(F.hasExplicitZone('2026-08-25T16:56:17-05:00'), true);
});

// ─── The COMPOUND bug, as the components actually hit it ──────────────────
/*
 * These pin the exact shape found in the CRM on 2026-08-26 and fixed in the
 * same pass: a zone-less DB datetime parsed with `new Date(...)` and then
 * RENDERED with timeZone:'Asia/Kolkata'. The two errors do not cancel — they
 * compound — and the result is the wrong time AND, near a day boundary, the
 * wrong day.
 *
 * The property that matters is not "parseIstDateTime is correct" (covered
 * above) but "the rendered STRING an operator reads is the same in Kolkata,
 * New York and London". That is what these assert, because it is what the
 * duplicated DateTimeCell in the QuickSight pages got wrong.
 *
 * Run under several zones — `TZ=America/New_York node --test tests/...`. A
 * timezone test that only runs in IST is testing nothing, and this whole class
 * of bug is invisible from India.
 */
const IST_RENDER = {
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
  timeZone: 'Asia/Kolkata',
};
const DB_VALUE = '2026-08-25 16:56:17'; // zone-less, means IST

test('rendering a zone-less DB datetime is zone-independent through parseIstDateTime', () => {
  const rendered = new Intl.DateTimeFormat('en-GB', IST_RENDER)
    .format(F.parseIstDateTime(DB_VALUE));
  // 16:56 IST is 16:56 IST wherever the browser happens to be.
  assert.match(rendered, /25 Aug 2026/, `wrong day in TZ=${process.env.TZ || 'system'}: ${rendered}`);
  assert.match(rendered, /16:56/, `wrong time in TZ=${process.env.TZ || 'system'}: ${rendered}`);
});

test('the OLD code only agreed with it when the browser was already in IST', () => {
  /*
   * Byte-identical in IST — which is why this shipped and nobody noticed — and
   * divergent outside it. If this assertion ever flips to "always equal", the
   * fix has been reverted.
   */
  const oldWay = new Intl.DateTimeFormat('en-GB', IST_RENDER)
    .format(new Date(DB_VALUE.replace(' ', 'T')));
  const newWay = new Intl.DateTimeFormat('en-GB', IST_RENDER)
    .format(F.parseIstDateTime(DB_VALUE));

  const offsetMinutes = -new Date('2026-08-25T12:00:00Z').getTimezoneOffset();
  if (offsetMinutes === 330) {
    assert.equal(oldWay, newWay, 'in IST the fix must change nothing an operator reads');
  } else {
    assert.notEqual(oldWay, newWay,
      `outside IST the old parse must differ — it did not, in TZ=${process.env.TZ || 'system'}`);
  }
});

test('a date-only value renders as that calendar date, not the day before', () => {
  // The trap for anyone west of Greenwich: midnight IST parsed as midnight UTC
  // reads as the right day in London and the WRONG day in New York.
  const rendered = new Intl.DateTimeFormat('en-GB', { ...IST_RENDER, hour: undefined, minute: undefined })
    .format(F.parseIstDateTime('2026-08-25'));
  assert.match(rendered, /25 Aug 2026/, `date-only slipped a day in TZ=${process.env.TZ || 'system'}`);
});
