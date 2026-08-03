'use strict';

/*
 * job-slots — unit tests against the REAL production time_slot census.
 *
 * ─── WHY THESE TESTS EXIST ────────────────────────────────────────────────
 *
 * tbl_job.time_slot is free text written by four different pickers over a
 * decade. Every reader of it is therefore a guess about spelling, and two bugs
 * shipped from exactly that:
 *
 *   1. '3pm to 7pm' (job #482491) compared unequal to '3PM to 7PM', so
 *      slotChoicesFor appended it as a FIFTH chip — one booking window offered
 *      twice, side by side, with nothing to tell them apart.
 *   2. The same job stores 05:30, which is 'After Hours'. The stale stored label
 *      won on load, so the chip row and the time beside it disagreed.
 *
 * Neither is catchable by a type-checker: both are value-level facts about data
 * that lives in a database this repo cannot see. So the census below is pinned
 * here as test input. If a future edit to the folding rule re-splits a band or
 * starts folding a value it shouldn't, this fails instead of shipping.
 *
 * ─── WHY IT COMPILES FIRST ────────────────────────────────────────────────
 *
 * This is a Next.js app with no test runner and no test-time transpiler. Rather
 * than add jest/vitest and their dependency trees for one pure module,
 * `npm test` runs `tsc` over src/lib/job-slots.ts into .test-build/ and this
 * file requires the emitted CommonJS. Same node:test + node:assert convention as
 * EasyFix_Backend's suite, so the two repos' tests read alike.
 *
 * ⚠ That single-file compile bypasses tsconfig.json, so it cannot resolve the
 * '@/…' path alias. job-slots.ts is deliberately dependency-free — keep it that
 * way, or switch the build step to a real tsconfig project.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../.test-build/job-slots.js');

/*
 * THE FOUR CANONICAL BANDS, spelled exactly as the backend spells them
 * (services/time-slot.js: BAND_MORNING…BAND_AFTER_HOURS). Duplicated here on
 * purpose: importing them from the module under test would make the assertion
 * vacuous. These strings are the wire format between two repos and a decade of
 * rows — if a "tidy-up" ever reflows them, this is the alarm.
 */
const MORNING = '9AM to 12PM';
const AFTERNOON = '12PM to 3PM';
const EVENING = '3PM to 7PM';
const AFTER_HOURS = 'After Hours';

/*
 * ─── THE PRODUCTION CENSUS ────────────────────────────────────────────────
 *
 * Every distinct value verified on prod 2026-07-31 (counts from the backend's
 * services/time-slot.js header), plus the two customer-facing spellings and the
 * cosmetic variant from job #482491.
 *
 *   canonical  what canonicalSlot() must return
 *   extraChip  true when the value must still earn its OWN chip beside the four
 *              bands — i.e. it is a genuinely different string, not a cosmetic
 *              restatement of one of them
 *
 * The rule being pinned: fold CASE and SPACING, nothing else. A value that
 * differs by anything more is a different vocabulary, and choosing a band for it
 * is a writer-side decision the backend makes at save time — never a silent
 * display rule.
 */
const CENSUS = [
  // ── the four canonical bands (identity) ────────────────────────────────
  { stored: MORNING,                canonical: MORNING,     extraChip: false, note: '39,997 rows' },
  { stored: AFTERNOON,              canonical: AFTERNOON,   extraChip: false, note: '14,665 rows' },
  { stored: EVENING,                canonical: EVENING,     extraChip: false, note: '2,204 rows' },
  { stored: AFTER_HOURS,            canonical: AFTER_HOURS, extraChip: false },

  // ── cosmetic variants: SAME band, different case/spacing. Must fold. ────
  { stored: '3pm to 7pm',           canonical: EVENING,     extraChip: false, note: 'job #482491' },
  { stored: '9 am to 12 pm',        canonical: MORNING,     extraChip: false, note: 'live on prod' },
  { stored: '9 AM to 12 PM',        canonical: MORNING,     extraChip: false },
  { stored: '  3PM to 7PM  ',       canonical: EVENING,     extraChip: false, note: 'stray padding' },
  { stored: 'AFTER HOURS',          canonical: AFTER_HOURS, extraChip: false },

  // ── genuinely different strings. Must NOT fold — each keeps its own chip. ─
  { stored: 'Morning 9 to 2',       canonical: 'Morning 9 to 2',       extraChip: true, note: '79,364 rows — the largest bucket' },
  { stored: 'Evening 2 to 7',       canonical: 'Evening 2 to 7',       extraChip: true, note: '18,763 rows' },
  { stored: 'Morning 9 to 12',      canonical: 'Morning 9 to 12',      extraChip: true, note: '3,193 rows' },
  { stored: 'Afternoon 12 to 5',    canonical: 'Afternoon 12 to 5',    extraChip: true },
  { stored: 'Afternoon 12 to 2',    canonical: 'Afternoon 12 to 2',    extraChip: true },
  { stored: 'After Hours - 19:00',  canonical: 'After Hours - 19:00',  extraChip: true, note: 'NOT the After Hours band — carries an hour' },
  { stored: 'morning 9 to night 8', canonical: 'morning 9 to night 8', extraChip: true },
  { stored: 'After 7PM',            canonical: 'After 7PM',            extraChip: true },
  { stored: '9-12',                 canonical: '9-12',                 extraChip: true },
  { stored: '3 PM–4 PM',            canonical: '3 PM–4 PM',            extraChip: true, note: 'WhatsApp 1-hour frame (en-dash)' },
  { stored: '9 AM – 12 PM',         canonical: '9 AM – 12 PM',         extraChip: true, note: 'customer form spelling (spaced en-dash)' },
];

// ─── canonicalSlot ────────────────────────────────────────────────────────

test('canonicalSlot resolves every production value as documented', () => {
  for (const row of CENSUS) {
    assert.equal(
      S.canonicalSlot(row.stored),
      row.canonical,
      `${JSON.stringify(row.stored)}${row.note ? ` (${row.note})` : ''}`,
    );
  }
});

test('canonicalSlot treats absent values as empty, never as a band', () => {
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(S.canonicalSlot(empty), '', JSON.stringify(empty));
  }
});

test('canonicalSlot is idempotent — folding an already-folded value is a no-op', () => {
  for (const row of CENSUS) {
    assert.equal(S.canonicalSlot(S.canonicalSlot(row.stored)), row.canonical, row.stored);
  }
});

// ─── slotChoicesFor ───────────────────────────────────────────────────────

test('slotChoicesFor always offers the four bands, in order, first', () => {
  const inputs = [...CENSUS.map((r) => r.stored), '', null, undefined];
  for (const stored of inputs) {
    const values = S.slotChoicesFor(stored).map((c) => c.value);
    assert.deepEqual(
      values.slice(0, 4),
      [MORNING, AFTERNOON, EVENING, AFTER_HOURS],
      `four bands missing or reordered for ${JSON.stringify(stored)}`,
    );
  }
});

test('slotChoicesFor appends a chip only for a genuinely different value', () => {
  for (const row of CENSUS) {
    const choices = S.slotChoicesFor(row.stored);
    assert.equal(
      choices.length,
      row.extraChip ? 5 : 4,
      `${JSON.stringify(row.stored)} should render ${row.extraChip ? 5 : 4} chips`,
    );
    if (row.extraChip) {
      // Verbatim — a legacy value must display exactly what the job holds.
      assert.equal(choices[4].value, String(row.stored).trim());
      assert.equal(choices[4].label, String(row.stored).trim());
      // fromH -1: no derivable window, so picking it must never nudge the time.
      assert.equal(choices[4].fromH, -1);
      assert.equal(choices[4].toH, -1);
    }
  }
});

/*
 * THE INVARIANT THE '3pm to 7pm' BUG BROKE. Whatever a job holds, the picker
 * must end up with EXACTLY ONE option matching it: zero means the control reads
 * as "nothing selected" and invites the operator to overwrite a confirmed
 * window; two means the same window is offered twice.
 */
test('every stored value selects exactly one chip — never zero, never two', () => {
  for (const row of CENSUS) {
    const selected = S.canonicalSlot(row.stored);
    const hits = S.slotChoicesFor(row.stored).filter((c) => c.value === selected);
    assert.equal(hits.length, 1, `${JSON.stringify(row.stored)} matched ${hits.length} chips`);
  }
});

test('an empty slot selects nothing, and adds no chip', () => {
  const choices = S.slotChoicesFor('');
  assert.equal(choices.length, 4);
  assert.equal(S.canonicalSlot(''), '');
});

// ─── isKnownBand ──────────────────────────────────────────────────────────

test('isKnownBand agrees with canonicalSlot on every census value', () => {
  for (const row of CENSUS) {
    assert.equal(
      S.isKnownBand(row.stored),
      !row.extraChip,
      `${JSON.stringify(row.stored)} — a cosmetic variant IS a known band; the legacy "already stored on this job" warning must not fire on it`,
    );
  }
});

// ─── bandForHour / bandForTime ────────────────────────────────────────────

test('bandForHour maps every hour of the day, boundaries included', () => {
  const expected = {
    0: AFTER_HOURS, 5: AFTER_HOURS, 8: AFTER_HOURS,       // before the working day
    9: MORNING, 10: MORNING, 11: MORNING,                 // 9 ≤ h < 12
    12: AFTERNOON, 13: AFTERNOON, 14: AFTERNOON,          // 12 ≤ h < 15
    15: EVENING, 16: EVENING, 17: EVENING, 18: EVENING,   // 15 ≤ h < 19
    19: AFTER_HOURS, 22: AFTER_HOURS, 23: AFTER_HOURS,    // 19 is EXCLUSIVE
  };
  for (const [h, band] of Object.entries(expected)) {
    assert.equal(S.bandForHour(Number(h)), band, `hour ${h}`);
  }
});

test('bandForHour refuses a non-hour rather than guessing a band', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(S.bandForHour(bad), '', String(bad));
  }
});

test("job #482491's 05:30 is After Hours — the fact its stored label contradicted", () => {
  assert.equal(S.bandForTime('05:30'), AFTER_HOURS);
  assert.equal(S.inferSlotFromTime('2026-07-31T05:30'), AFTER_HOURS);
  // …while the label it shipped with resolves to the evening band. The two
  // disagree, which is exactly why the appointment instant has to win on load.
  assert.equal(S.canonicalSlot('3pm to 7pm'), EVENING);
  assert.notEqual(S.canonicalSlot('3pm to 7pm'), S.inferSlotFromTime('2026-07-31T05:30'));
});

test('AFTER_HOURS_START bands back to After Hours', () => {
  // The public form stamps this hour when a customer picks the band directly.
  // If it ever drifted inside 15:00-19:00 the chip would flip under them.
  assert.equal(S.bandForTime(S.AFTER_HOURS_START), AFTER_HOURS);
});

// ─── inferSlotFromTime + hasTimeOfDay ─────────────────────────────────────

test('inferSlotFromTime returns null when there is no time to band', () => {
  for (const empty of ['', '2026-07-31', null, undefined, 'garbage']) {
    assert.equal(S.inferSlotFromTime(empty), null, JSON.stringify(empty));
  }
});

/*
 * BOTH datetime spellings must work. The pickers emit 'YYYY-MM-DDTHH:mm'; the
 * API returns 'YYYY-MM-DD HH:mm:ss' because the pool runs `dateStrings: true`.
 * A 'T'-anchored regex accepts the first and silently rejects the second, which
 * turned the derivation into a permanent no-op on every read-only surface —
 * no error, just a band that never updated.
 */
test('the wall-clock parse accepts both the T and the space separator', () => {
  assert.equal(S.inferSlotFromTime('2026-07-31T15:00'), EVENING, 'datetime-local');
  assert.equal(S.inferSlotFromTime('2026-07-31 15:00:00'), EVENING, 'API wall clock');
  assert.equal(S.hasTimeOfDay('2026-07-31T05:30'), true);
  assert.equal(S.hasTimeOfDay('2026-07-31 05:30:00'), true);
  assert.equal(S.hasTimeOfDay('2026-07-31 00:00:00'), false, 'sentinel, space form');
});

/*
 * A ZONED value is an instant, not a wall clock. '2026-07-31T09:30:00.000Z' is
 * 3 PM IST, so reading hour 09 out of it bands the job '9AM to 12PM' — wrong by
 * five and a half hours, and undetectable because the answer is still a
 * perfectly valid-looking band. Refusing it turns a silent wrong answer into a
 * null that every caller's "leave the stored slot alone" guard handles.
 */
test('a zoned instant is REFUSED rather than read as a wall clock', () => {
  const zoned = [
    '2026-07-31T09:30:00.000Z',
    '2026-07-31T09:30:00Z',
    '2026-07-31T09:30:00+05:30',
    '2026-07-31T09:30:00-0800',
  ];
  for (const v of zoned) {
    assert.equal(S.inferSlotFromTime(v), null, v);
    assert.equal(S.hasTimeOfDay(v), false, v);
  }
  // …and the unzoned forms of the same string are still read normally, so the
  // rejection is about the zone designator and nothing else.
  assert.equal(S.inferSlotFromTime('2026-07-31T09:30:00'), MORNING);
});

/*
 * THE MIDNIGHT SENTINEL. 00:00 means "no time was ever captured", not midnight.
 * inferSlotFromTime answers a different question ("which band holds hour 0?")
 * and correctly says After Hours — so any caller about to OVERWRITE a stored
 * band must gate on hasTimeOfDay first, or every date-only job silently loses
 * its label on page load. This test pins the trap, not just the functions.
 */
test('hasTimeOfDay rejects the midnight sentinel that inferSlotFromTime happily bands', () => {
  assert.equal(S.hasTimeOfDay('2026-07-31T00:00'), false, 'the sentinel');
  assert.equal(S.hasTimeOfDay('2026-07-31T00:00:00'), false, 'with seconds');
  assert.equal(S.inferSlotFromTime('2026-07-31T00:00'), AFTER_HOURS, 'the trap');

  assert.equal(S.hasTimeOfDay('2026-07-31T00:01'), true, 'one minute past is a real time');
  assert.equal(S.hasTimeOfDay('2026-07-31T05:30'), true);
  assert.equal(S.hasTimeOfDay('2026-07-31T19:00'), true);
});

test('hasTimeOfDay rejects values carrying no time part at all', () => {
  for (const empty of ['', '2026-07-31', null, undefined]) {
    assert.equal(S.hasTimeOfDay(empty), false, JSON.stringify(empty));
  }
});

// ─── displaySlot — the band the display surfaces may show ────────────────

/*
 * displaySlot composes the two guards above into the ONE precedence every
 * read-only surface must use. It exists because four of them (the Schedule &
 * Assign context panel, the transaction view, the Unconfirmed table, My Orders)
 * each rendered `job.time_slot` raw and so each published a band the job's own
 * appointment contradicted.
 *
 * ⚠ WHAT IT MUST NOT DO: replace the band with the exact minute. The promise to
 * the customer is a WINDOW — "the technician will reach in this slot", not
 * "at 5:30". So the output is always one of the four bands (or a legacy label);
 * the fix is only ever WHICH band. A change that starts returning clock times
 * from here breaks a product commitment, not just a format.
 */
test('displaySlot: a real appointment time OVERRIDES a contradicting stored band', () => {
  // Job #482491 — the recorded case. 05:30 is After Hours; the row says otherwise.
  assert.equal(S.displaySlot('2026-08-05 05:30:00', '3pm to 7pm'), AFTER_HOURS);
  assert.equal(S.displaySlot('2026-08-05T05:30', '3PM to 7PM'), AFTER_HOURS);
  // …and it overrides a legacy vocabulary just as readily.
  assert.equal(S.displaySlot('2026-08-05 10:00:00', 'Morning 9 to 2'), MORNING);
  assert.equal(S.displaySlot('2026-08-05 15:00:00', '9AM to 12PM'), EVENING);
});

test('displaySlot: it agrees with the stored band when the two already agree', () => {
  for (const b of S.BOOKING_BANDS) {
    if (b.fromH < 0) continue; // After Hours has no window to sample
    assert.equal(S.displaySlot(`2026-08-05T${b.start}`, b.value), b.value, b.value);
  }
});

test('displaySlot: it ALWAYS returns a band, never a clock time', () => {
  for (const dt of ['2026-08-05 05:30:00', '2026-08-05 10:15:00', '2026-08-05 18:45:00']) {
    const out = S.displaySlot(dt, '');
    assert.ok(S.isKnownBand(out), `${dt} → ${JSON.stringify(out)} must be one of the four bands`);
    assert.doesNotMatch(out, /:\d\d/, 'a minute must never leak into the band');
  }
});

/*
 * THE MIDNIGHT SENTINEL, from the display side. 00:00 means "no time was ever
 * captured", so there is nothing to derive from and the stored label is the
 * only signal on file. Deriving anyway would band every date-only job as
 * 'After Hours' and silently destroy the label it actually holds.
 */
test('displaySlot: a date-only job keeps its stored label, canonicalised', () => {
  assert.equal(S.displaySlot('2026-08-05 00:00:00', '3pm to 7pm'), EVENING, 'canonically spelled');
  assert.equal(S.displaySlot('2026-08-05', '9 am to 12 pm'), MORNING);
  assert.equal(S.displaySlot(null, '12PM to 3PM'), AFTERNOON);
  // A genuinely different legacy value is NOT re-labelled — we refuse to invent
  // an hour nobody wrote down.
  assert.equal(S.displaySlot('2026-08-05 00:00:00', 'Morning 9 to 2'), 'Morning 9 to 2');
  assert.equal(S.displaySlot('2026-08-05 00:00:00', '9-12'), '9-12');
});

test('displaySlot: nothing on file yields "" so the caller renders its own dash', () => {
  for (const dt of [null, undefined, '', '2026-08-05', '2026-08-05 00:00:00']) {
    assert.equal(S.displaySlot(dt, null), '', JSON.stringify(dt));
    assert.equal(S.displaySlot(dt, ''), '', JSON.stringify(dt));
  }
});

/*
 * A zoned instant is not a wall clock: reading 09 out of '…T09:30:00.000Z'
 * would band an IST 3 PM appointment as morning — off by five and a half hours
 * and completely invisible, because the answer still looks like a real band.
 * hasTimeOfDay refuses it, so displaySlot falls through to the stored label.
 */
test('displaySlot: a zoned instant falls back to the stored band, never mis-bands', () => {
  assert.equal(S.displaySlot('2026-08-05T09:30:00.000Z', '3PM to 7PM'), EVENING);
  assert.equal(S.displaySlot('2026-08-05T09:30:00+05:30', '3pm to 7pm'), EVENING);
});

// ─── cross-repo drift guard ───────────────────────────────────────────────

/*
 * These four strings are what actually crosses the wire to tbl_job.time_slot and
 * must stay byte-identical to the backend's BAND_* constants. Spelling is
 * deliberate: no spaces around the hour tokens, the word "to" as the separator,
 * NOT an en-dash. Do not "tidy" them — a reflow here silently splits every band
 * in two across the two repos.
 */
test('BOOKING_BANDS matches the backend vocabulary byte for byte', () => {
  assert.deepEqual(
    S.BOOKING_BANDS.map((b) => b.value),
    [MORNING, AFTERNOON, EVENING, AFTER_HOURS],
  );
  // value === label so the operator reads exactly what the database stores.
  for (const b of S.BOOKING_BANDS) assert.equal(b.value, b.label, b.value);
  assert.equal(S.AFTER_HOURS_SLOT, AFTER_HOURS);
});

test('band windows are contiguous and half-open across the working day', () => {
  const windowed = S.BOOKING_BANDS.filter((b) => b.fromH >= 0);
  assert.equal(windowed.length, 3, 'only After Hours may lack a window');
  for (let i = 1; i < windowed.length; i++) {
    assert.equal(
      windowed[i].fromH,
      windowed[i - 1].toH,
      `gap or overlap between ${windowed[i - 1].value} and ${windowed[i].value}`,
    );
  }
  // Each band's own start hour must land back inside it — the chip row nudges
  // the time picker to exactly this hour when a band is clicked.
  for (const b of windowed) assert.equal(S.bandForTime(b.start), b.value, b.value);
});
