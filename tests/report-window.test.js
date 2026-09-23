'use strict';

/*
 * report-window — the date arithmetic behind every QuickSight report's window
 * (src/lib/report-window.ts), shared by the Employee Performance and MTD tabs
 * and by the Date Range picker they both render.
 *
 * Why a test and not a look: two of these rules are only wrong on dates nobody
 * types while building a screen.
 *
 *   widestWindow's SHORT-MONTH WALK. The cap it serves ("at most N calendar
 *   months") caps the day at the target month's length, so the naive `to` less
 *   N months plus a day is a day too early whenever the month it lands in is
 *   shorter: a window ending 28 Feb must start 1 Dec, not 29 Nov, or the very
 *   window the picker offers is the one the server refuses. The walk exists
 *   for that, and only February and a 31-day month can show it.
 *
 *   The INCLUSIVE ends. dayCount counts both ends, monthWindow's last day is
 *   capped at today, and Month To Date ends today — so a "366 day" cap is
 *   today less 365, and an off-by-one here is a 400 from the backend rather
 *   than a visible mistake on screen.
 *
 * Everything here is pure calendar arithmetic: no Date is built from a local
 * clock, and no assertion depends on the machine's timezone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dayCount, fmtDay, fmtDayRange, lastAllowedTo, monthToDate, monthWindow, recentMonths, shiftYmd, widestWindow,
} = require('../.test-build/report-window.js');

test('shiftYmd crosses months, years and a leap day without a timezone moving it', () => {
  assert.equal(shiftYmd('2026-09-22', 1), '2026-09-23');
  assert.equal(shiftYmd('2026-09-01', -1), '2026-08-31');
  assert.equal(shiftYmd('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftYmd('2027-01-01', -1), '2026-12-31');
  // 2028 is a leap year: the 29th exists and must be counted.
  assert.equal(shiftYmd('2028-02-28', 1), '2028-02-29');
  assert.equal(shiftYmd('2028-03-01', -1), '2028-02-29');
  assert.equal(shiftYmd('2026-09-22', 0), '2026-09-22');
});

test('dayCount counts BOTH ends — one day is 1, not 0', () => {
  assert.equal(dayCount('2026-09-22', '2026-09-22'), 1);
  assert.equal(dayCount('2026-09-01', '2026-09-30'), 30);
  assert.equal(dayCount('2026-01-01', '2026-12-31'), 365);
  assert.equal(dayCount('2028-01-01', '2028-12-31'), 366, 'a leap year is 366 days');
});

test('Month To Date is the 1st .. today, and is what an empty window resolves to', () => {
  assert.deepEqual(monthToDate('2026-09-22'), { from: '2026-09-01', to: '2026-09-22' });
  assert.deepEqual(monthToDate('2026-09-01'), { from: '2026-09-01', to: '2026-09-01' });
  assert.deepEqual(monthToDate('2026-12-31'), { from: '2026-12-01', to: '2026-12-31' });
});

test('monthWindow gives a whole past month, and never a day that has not happened', () => {
  assert.deepEqual(monthWindow('2026-08', '2026-09-22'), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(monthWindow('2026-02', '2026-09-22'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthWindow('2028-02', '2028-09-22'), { from: '2028-02-01', to: '2028-02-29' });
  // The CURRENT month is capped at today: the picker must not offer the future.
  assert.deepEqual(monthWindow('2026-09', '2026-09-22'), { from: '2026-09-01', to: '2026-09-22' });
});

test('lastAllowedTo is the cap the backend applies, inclusive of its last day', () => {
  // 3 months from 1 Jun ends 31 Aug, not 1 Sep.
  assert.equal(lastAllowedTo('2026-06-01', 3), '2026-08-31');
  // The short-month case: 3 months from 30 Nov lands on 28 Feb (the day is
  // capped at February's length) and then steps back a day.
  assert.equal(lastAllowedTo('2026-11-30', 3), '2027-02-27');
  assert.equal(lastAllowedTo('2026-09-22', 1), '2026-10-21');
});

test('widestWindow never offers a range its own cap would refuse — including the short-month case', () => {
  // The case the walk exists for: ending 28 Feb, the naive start is 29 Nov,
  // which lastAllowedTo caps at 27 Feb. The answer has to be 1 Dec.
  assert.deepEqual(widestWindow('2027-02-28', 3), { from: '2026-12-01', to: '2027-02-28' });
  // A plain month: 22 Sep back three months is 23 Jun.
  assert.deepEqual(widestWindow('2026-09-22', 3), { from: '2026-06-23', to: '2026-09-22' });

  // The invariant itself, over a year of end dates and every cap the reports
  // use: the widest window offered is always one the cap accepts.
  for (const months of [1, 3, 12]) {
    let to = '2026-01-01';
    for (let i = 0; i < 400; i++) {
      const w = widestWindow(to, months);
      assert.ok(w.from <= w.to, `widestWindow(${to}, ${months}) runs backwards`);
      assert.ok(
        lastAllowedTo(w.from, months) >= w.to,
        `widestWindow(${to}, ${months}) = ${w.from}..${w.to} is beyond its own cap`,
      );
      to = shiftYmd(to, 1);
    }
  }
});

test('MTD\'s day-shaped cap: 366 days inclusive is today less 365', () => {
  // The tab computes its All Dates window this way (quicksight/mtd/api.ts).
  const to = '2026-09-22';
  const from = shiftYmd(to, -365);
  assert.equal(from, '2025-09-22');
  assert.equal(dayCount(from, to), 366, 'one more day would be the backend’s 400');
});

test('recentMonths walks back from today’s month, newest first', () => {
  assert.deepEqual(recentMonths('2026-09-22', 2), ['2026-09', '2026-08']);
  assert.deepEqual(recentMonths('2026-01-15', 3), ['2026-01', '2025-12', '2025-11']);
});

test('fmtDay prints the calendar date it was given, and never a Date’s idea of it', () => {
  assert.equal(fmtDay('2026-09-01'), '01 Sep 2026');
  assert.equal(fmtDay('2026-12-31'), '31 Dec 2026');
  assert.equal(fmtDay(''), '—');
  assert.equal(fmtDay(null), '—');
  assert.equal(fmtDayRange('2026-09-01', '2026-09-22'), '01 Sep 2026 – 22 Sep 2026');
  assert.equal(fmtDayRange('2026-09-22', '2026-09-22'), '22 Sep 2026', 'one day reads as one date');
  assert.equal(fmtDayRange('', '2026-09-22'), 'none');
});
