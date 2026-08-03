'use strict';

/*
 * FE↔BE wire-contract parity — the CRM_UI half.
 *
 * ─── THE PROBLEM ───────────────────────────────────────────────────────────
 *
 * A handful of STRING LITERALS have to be byte-identical in this repo and in
 * EasyFix_Backend, because they either land in a shared database column or are
 * matched against a server-side allow-list. TypeScript cannot see across a repo
 * boundary, so every one of them is a silent failure waiting to happen, and both
 * have already happened:
 *
 *   · the booking bands — '3PM to 7PM' spelled any other way stops matching
 *   · the job sort key  — shipped as 'ageSecs' instead of 'age', and Joi
 *     rejected it, 400-ing the ENTIRE jobs list rather than ignoring it
 *
 * shared/wire-contract.json holds the agreed values and is duplicated byte for
 * byte into both repos. This file asserts THIS repo's constants against THIS
 * repo's copy; EasyFix_Backend/tests/wire-contract.test.js does the mirror.
 *
 * ─── WHAT IT GUARANTEES, HONESTLY ──────────────────────────────────────────
 *
 * In CI a repo can only see itself, so these assertions catch the COMMON
 * failure — someone edits a constant in code and does not update the fixture.
 * They cannot catch a self-consistent edit to one repo alone (fixture + code
 * changed together, other repo untouched); nothing running inside one checkout
 * can. That case is caught by the cross-repo test at the bottom, which runs
 * whenever the sibling repo is checked out beside this one — the normal dev
 * layout, and the moment the edit is actually being made.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_PATH = path.resolve(__dirname, '../shared/wire-contract.json');
const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

const slots = require('../.test-build/job-slots.js');
const age = require('../.test-build/job-age.js');

// ─── booking bands ────────────────────────────────────────────────────────

test('BOOKING_BANDS matches the wire contract exactly, in order', () => {
  const want = contract.bookingBands.values;
  assert.equal(slots.BOOKING_BANDS.length, want.length, 'band COUNT differs');
  slots.BOOKING_BANDS.forEach((band, i) => {
    assert.equal(band.value, want[i].value, `band ${i} value`);
    // The module encodes "no window" as -1; the contract uses null, because
    // JSON has no natural sentinel and -1 would read as a real hour.
    assert.equal(band.fromH, want[i].fromHour ?? -1, `${want[i].value} fromH`);
    assert.equal(band.toH, want[i].toHour ?? -1, `${want[i].value} toH`);
    assert.equal(band.start, want[i].start, `${want[i].value} start`);
  });
});

test('AFTER_HOURS_SLOT and AFTER_HOURS_START come from the contract', () => {
  const afterHours = contract.bookingBands.values.find((b) => b.fromHour === null);
  assert.ok(afterHours, 'the contract must define exactly one window-less band');
  assert.equal(slots.AFTER_HOURS_SLOT, afterHours.value);
  assert.equal(slots.AFTER_HOURS_START, afterHours.start);
});

test('bandForHour agrees with the contract windows at every hour', () => {
  /*
   * Not just the constants — the DERIVATION. Matching band strings while
   * bucketing hours differently from the backend would put a 3 PM job in one
   * band on the server and another in the browser, with both spelling it
   * identically. Checked across all 24 hours, so an off-by-one at an inclusive
   * or exclusive edge cannot hide.
   */
  const windowed = contract.bookingBands.values.filter((b) => b.fromHour !== null);
  const afterHours = contract.bookingBands.values.find((b) => b.fromHour === null).value;
  for (let h = 0; h < 24; h++) {
    const want = windowed.find((b) => h >= b.fromHour && h < b.toHour)?.value ?? afterHours;
    assert.equal(slots.bandForHour(h), want, `hour ${h}`);
  }
});

// ─── job sort keys ────────────────────────────────────────────────────────

test('JOB_AGE_SORT_KEY matches the contract', () => {
  assert.equal(age.JOB_AGE_SORT_KEY, contract.jobSortKeys.jobAge);
});

// ─── cross-repo identity ──────────────────────────────────────────────────

/*
 * Locate EasyFix_Backend. The dev layout is both repos side by side under
 * ~/Documents/GitHub; EASYFIX_BACKEND_DIR overrides for anything else.
 */
function siblingContract() {
  const root = process.env.EASYFIX_BACKEND_DIR
    || path.resolve(__dirname, '../../EasyFix_Backend');
  const file = path.join(root, 'shared', 'wire-contract.json');
  return fs.existsSync(file) ? file : null;
}

test('the backend copy of the contract is byte-identical', (t) => {
  const sibling = siblingContract();
  if (!sibling) {
    /*
     * SKIPPED, NOT PASSED. In CI only one repo is checked out, so this cannot
     * run there — say so out loud rather than letting a green tick imply a
     * check that never happened. Set EASYFIX_BACKEND_DIR to enable it.
     */
    t.skip('EasyFix_Backend not found beside this repo — cross-repo parity NOT verified');
    return;
  }
  const mine = fs.readFileSync(CONTRACT_PATH);
  const theirs = fs.readFileSync(sibling);
  assert.equal(
    theirs.equals(mine),
    true,
    `shared/wire-contract.json differs between the repos.\n  this repo: ${CONTRACT_PATH}\n  backend:   ${sibling}\nEdit BOTH copies in the same change.`,
  );
});
