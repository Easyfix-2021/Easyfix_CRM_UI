/*
 * PENDING TO START — status + appointment-timing rule (lib/pending-start-status.ts).
 *
 * WHAT IS AT RISK. The My Orders row, the tab it sits in and the job console
 * all read this one rule, and the failures are quiet: a chip that says
 * On-track for a visit that started ten minutes ago, or a row whose status
 * disagrees with its tab. So the edges are pinned exactly:
 *   - Running late starts AT the appointment minute (no grace — ops' call);
 *   - Close loop is 2 hours or less to go, inclusive of exactly 120 minutes;
 *   - status priority is cancel → reschedule → missed → today → future, the
 *     order the server partitions the tabs by.
 *
 * Times are IST wall clocks, the backend's format; `now` is passed in, so the
 * test never depends on the machine's clock or timezone.
 *
 * Runner: `node --test` (see npm test). Loads the test:build output.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../.test-build/pending-start-status.js');

/* An IST wall-clock string → epoch ms, the way the rule itself reads one. */
const ist = (s) => new Date(`${s.replace(' ', 'T')}+05:30`).getTime();

test('Running late starts at the appointment minute, not after a grace period', () => {
  const at = '2026-09-17 18:00:00';
  assert.equal(S.appointmentTiming(at, ist('2026-09-17 18:00:00')).kind, 'close_loop', 'exactly at the time is not yet late');
  const late = S.appointmentTiming(at, ist('2026-09-17 18:00:30'));
  assert.equal(late.kind, 'late', 'any time after it is late');
  assert.equal(late.label, 'Running late · 0m');
  assert.equal(S.appointmentTiming(at, ist('2026-09-17 20:10:00')).label, 'Running late · 2h 10m');
  assert.equal(S.appointmentTiming(at, ist('2026-09-20 22:00:00')).label, 'Running late · 3d 4h');
});

test('Close loop is 2 hours or less to go, and On-track beyond that', () => {
  const at = '2026-09-17 18:00:00';
  assert.equal(S.appointmentTiming(at, ist('2026-09-17 16:00:00')).kind, 'close_loop', 'exactly 120 minutes is close loop');
  assert.equal(S.appointmentTiming(at, ist('2026-09-17 16:00:00')).label, 'Close loop · 2h left');
  assert.equal(S.appointmentTiming(at, ist('2026-09-17 17:15:00')).label, 'Close loop · 45m left');
  const onTrack = S.appointmentTiming(at, ist('2026-09-17 15:59:00'));
  assert.equal(onTrack.kind, 'on_track', '121 minutes is on track');
  assert.equal(onTrack.label, 'On-track · in 2h 1m');
  assert.equal(S.appointmentTiming(at, ist('2026-09-15 14:00:00')).label, 'On-track · in 2d 4h');
});

test('no appointment gives no timing (the row shows "No appointment time")', () => {
  assert.equal(S.appointmentTiming(null, ist('2026-09-17 12:00:00')), null);
  assert.equal(S.appointmentTiming('', ist('2026-09-17 12:00:00')), null);
});

test('each timing kind carries its tone', () => {
  const at = '2026-09-17 18:00:00';
  assert.equal(S.appointmentTiming(at, ist('2026-09-17 19:00:00')).tone, 'urgent');
  assert.equal(S.appointmentTiming(at, ist('2026-09-17 17:00:00')).tone, 'warning');
  assert.equal(S.appointmentTiming(at, ist('2026-09-16 17:00:00')).tone, 'success');
});

test('status follows the tab priority: cancel, reschedule, missed, today, future', () => {
  const today = '2026-09-17';
  // job_status 1: a technician's request only counts on a Pending to Start job
  // (appRequestOf's own gate), and every row in this bucket is status 1.
  const base = { job_status: 1, requested_date_time: '2026-09-17 18:00:00' };
  assert.equal(S.ptsStateOf({ ...base, is_cancelled_by_app: 1, is_rescheduled_by_app: 1 }, today), 'cancel', 'a cancel ask outranks a reschedule ask');
  assert.equal(S.ptsStateOf({ ...base, is_rescheduled_by_app: 1 }, today), 'reschedule');
  assert.equal(S.ptsStateOf({ job_status: 1, requested_date_time: '2026-09-16 23:30:00' }, today), 'missed', 'an earlier day is a missed slot');
  assert.equal(S.ptsStateOf({ job_status: 1, requested_date_time: null }, today), 'missed', 'no appointment sits in missed, as the server puts it');
  assert.equal(S.ptsStateOf(base, today), 'today');
  assert.equal(S.ptsStateOf({ job_status: 1, requested_date_time: '2026-09-18 09:00:00' }, today), 'future');
});

test('the status labels are the ones ops agreed', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(S.PTS_STATUS).map(([k, v]) => [k, v.label])),
    {
      cancel: 'Cancel requested',
      reschedule: 'Reschedule requested',
      missed: 'Slot missed',
      today: 'Due today',
      future: 'Upcoming',
    },
  );
});

test('formatSpan reads in the units a person would say', () => {
  assert.equal(S.formatSpan(45), '45m');
  assert.equal(S.formatSpan(60), '1h');
  assert.equal(S.formatSpan(130), '2h 10m');
  assert.equal(S.formatSpan(2880), '2d');
  assert.equal(S.formatSpan(3130), '2d 4h');
  assert.equal(S.formatSpan(-5), '0m', 'never negative');
});
