'use strict';
/*
 * The CRM offers no Check Out on Pending to Close on App jobs (2026-09-11).
 *
 * Pending to Close on App is job_status 2/20 — the technician is on site and
 * closes the job from the app. The CRM had three ways to push such a job to
 * 10 (Under Audit) itself: JobModal's footer "Check Out" and the ✓ row actions
 * on Manage Jobs and My Orders. Ops asked for all of them gone.
 *
 * Enumerated by the TRANSITION, not by a label: the row actions were icon-only
 * (CheckCircle2), so a search for the words "Check Out" found one of the three
 * and missed the two the operator was actually looking at.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) ? [path.join(d, e.name)] : []));
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Any client code that SENDS status 10 — the only thing a Check Out does.
// Tab/option definitions also say `status: 10`, but always beside a `label:`.
const SENDS_TEN = /quickStatusChange\([^)]*,\s*10\s*[,)]|doStatus\([^)]*ST\.REVISIT|status:\s*(?:10|ST\.REVISIT)\b/;
const isTransition = (line) => SENDS_TEN.test(line) && !/\blabel:/.test(line);

test('no CRM surface sends a job to 10 (Under Audit) from Pending to Close', () => {
  const files = walk(SRC);
  assert.ok(files.length > 100, `expected to scan the CRM source, found ${files.length} files`);
  const hits = files.flatMap((f) => strip(fs.readFileSync(f, 'utf8')).split('\n')
    .map((line, i) => ({ f: path.relative(SRC, f), i: i + 1, line }))
    .filter(({ line }) => isTransition(line)));
  assert.deepEqual(hits.map((h) => `${h.f}:${h.i}`), [],
    'a Check Out came back — Pending to Close on App jobs are closed from the technician app');
});

test('the matcher finds the shapes the three removed buttons used', () => {
  // Positive control on the LOCATOR: silence above only means something if
  // these exact shapes would have been caught.
  for (const shape of [
    "onClick={() => quickStatusChange(j.job_id, 10, 'Check out')}",
    "onClick={() => doStatus('complete', ST.REVISIT)}",
    'await api.patch(url, { status: 10 })',
  ]) assert.ok(isTransition(shape), shape);
  assert.ok(!isTransition("{ value: 'audit-complete', label: 'Under Audit', status: 10 },"), 'a tab definition is not a transition');
});
