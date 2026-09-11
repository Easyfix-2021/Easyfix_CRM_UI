'use strict';
/*
 * The CRM offers no Check In (2026-09-11, per ops): the technician checks in
 * from the app, as they check out (tests/no-crm-checkout.test.js).
 *
 * Enumerated by the MECHANISM, not a label. A CRM check-in had one writer,
 * CheckInWithReasonDialog's POST /admin/jobs/:id/checkin (the plain status
 * PATCH never targets 2 — tests/job-status-actions.test.js lists every one), and
 * four controls: JobModal's footer Check In, the PlayCircle row icons on Manage
 * Jobs and My Orders, and Pending to Start's PlayCircle, which opened
 * ?action=checkin. So the guard is the endpoint and the opener, wherever they
 * reappear. ?action=checkin itself stays parseable: an old link still opens the
 * job in the view workspace.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) ? [path.join(d, e.name)] : []));
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The check-in endpoint (not /checkin-sms, the Resend PIN text) or an opener of
// the check-in workspace.
const CHECKIN = /\/checkin[`'"?]|openJobAction\(\s*'checkin'/;

test('no CRM surface checks a job in', () => {
  const files = walk(SRC);
  assert.ok(files.length > 100, `expected to scan the CRM source, found ${files.length} files`);
  const hits = files.flatMap((f) => strip(fs.readFileSync(f, 'utf8')).split('\n')
    .map((line, i) => ({ f: path.relative(SRC, f), i: i + 1, line }))
    .filter(({ line }) => CHECKIN.test(line)));
  assert.deepEqual(hits.map((h) => `${h.f}:${h.i}`), [],
    'a Check In came back — technicians check in from the app');
});

test('the matcher finds the shapes the removed code used', () => {
  // Positive control on the LOCATOR: silence above only means something if
  // these exact lines (the dialog's POST, My Orders' opener) would be caught.
  for (const shape of [
    'await api.post(`/admin/jobs/${jobId}/checkin`, { reason: trimmed });',
    "function openCheckin(id: number)     { openJobAction('checkin',  id); }",
  ]) assert.ok(CHECKIN.test(shape), shape);
  assert.ok(!CHECKIN.test('await api.post(`/mobile/jobs/${jobId}/checkin-sms`);'), 'Resend PIN is not a check-in');
});
