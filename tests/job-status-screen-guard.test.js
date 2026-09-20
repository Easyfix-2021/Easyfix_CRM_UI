'use strict';
/*
 * WHICH SCREEN OPENS FOR WHICH job_status (ops, 2026-09-20).
 *
 * The action token lives in the URL, so it can be typed. Pasting a COMPLETED
 * job's id under `?action=schedule` opened Schedule & Assign on it — a write
 * console carrying Edit Services, on a job whose service lines are its billing
 * lines. Ops stated the rule as:
 *
 *   job_status 9  → Confirm & Schedule
 *   job_status 0  → Schedule & Assign
 *   job_status 1  → the assign / reassign console
 *   anything else → read-only View
 *
 * What could silently go wrong, and is pinned here:
 *   - a write console joins the map for a status it must never open on;
 *   - a READ action (view / checkin / audit / edit / create) gets swept into
 *     the guard and a working deep link starts re-routing itself;
 *   - the page re-routes off the PREVIOUS job's status, because useFetch keeps
 *     the last payload while the next one loads;
 *   - the re-route loses its once-per-(job, action) latch and ping-pongs;
 *   - the statuses stop matching lib/job-stages.ts, the map both repos share.
 *
 * Source-scanned, like the sibling console suites: the rules live in a TSX/TS
 * file a node test cannot import (next/navigation), so the source is the
 * subject. Comments are stripped first, so prose that merely NAMES a rule can
 * never satisfy a check.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');

const URL_SRC = 'src/lib/job-action-url.ts';
const STAGES_SRC = 'src/lib/job-stages.ts';
/*
 * BOTH list pages that can open a write console from the URL. Manage Jobs had
 * the identical hole (ops, 2026-09-20) and now shares the same hook, so this
 * list is the thing to extend when a third page grows one.
 */
const PAGES = [
  'src/app/(authed)/my-orders/page.tsx',
  'src/app/(authed)/jobs/page.tsx',
];

const url = strip(read(URL_SRC));
const guardSrc = url.slice(url.indexOf('export function useJobActionStatusGuard'));

// ─── 1. The map ops stated ───────────────────────────────────────────────

test('the status → screen map is exactly what ops asked for', () => {
  const table = url.match(/const STATUS_ACTIONS[^=]*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(table, 'positive control: STATUS_ACTIONS must be found');

  for (const [status, canonical] of [[9, 'confirm'], [0, 'schedule'], [1, 'console']]) {
    assert.match(table[1], new RegExp(`status: ${status},\\s*canonical: '${canonical}'`),
      `job_status ${status} must open '${canonical}'`);
  }
  // Exactly three statuses carry a write console; everything else is View.
  assert.equal((table[1].match(/status: \d+,/g) || []).length, 3,
    'only 9 / 0 / 1 may open a write console — every other status is read-only View');
  assert.match(url, /\?\?\s*'view';/, 'an unlisted status must fall through to read-only View');
});

test('assign belongs to status 0 and reassign to status 1 — never the other way round', () => {
  const table = url.match(/const STATUS_ACTIONS[^=]*=\s*\[([\s\S]*?)\n\];/)[1];
  const row = (s) => table.match(new RegExp(`status: ${s},[^\\n]*allowed: \\[([^\\]]*)\\]`))[1];
  assert.match(row(0), /'schedule'/);
  assert.match(row(0), /'assign'/);
  assert.doesNotMatch(row(0), /'reassign'|'console'/,
    'a job with no technician cannot open the reassign console');
  assert.match(row(1), /'console'/);
  assert.match(row(1), /'reassign'/);
  assert.doesNotMatch(row(1), /'schedule'|'assign'/,
    'a job that already has a technician cannot open Schedule & Assign');
  assert.doesNotMatch(row(9), /'schedule'|'assign'|'reassign'|'console'/,
    'an unconfirmed order only opens Confirm & Schedule');
});

// ─── 2. Only the write consoles are policed ──────────────────────────────

test('the guard covers every write console and no read action', () => {
  const guarded = url.match(/const GUARDED_ACTIONS[^=]*=[^[]*\[([^\]]*)\]/);
  assert.ok(guarded, 'positive control: GUARDED_ACTIONS must be found');
  for (const a of ['confirm', 'schedule', 'assign', 'reassign', 'console']) {
    assert.match(guarded[1], new RegExp(`'${a}'`), `${a} writes to a job and must be guarded`);
  }
  for (const a of ['view', 'checkin', 'audit', 'edit', 'create']) {
    assert.doesNotMatch(guarded[1], new RegExp(`'${a}'`),
      `${a} must stay unguarded — re-routing it would break working links`);
  }
  assert.match(url, /if \(!GUARDED_ACTIONS\.has\(action\)\) return true;/,
    'an unguarded action must short-circuit to allowed');
});

// ─── 3. The page acts on it, against the RIGHT job ───────────────────────

test('the guard probes the job and re-routes only on THIS job’s status', () => {
  assert.ok(guardSrc, 'positive control: useJobActionStatusGuard must be found');
  assert.match(guardSrc, /jobId != null && isGuardedJobAction\(action\)/,
    'the probe must only run for a guarded action on a real job id');
  /*
   * The dataKey comparison is the whole safety of this: useFetch RETAINS the
   * previous key's payload while the next loads (a key change sets `refreshing`,
   * not `loading`), so reading `.data` directly would re-route the operator to a
   * screen chosen from a DIFFERENT job's status.
   */
  assert.match(guardSrc, /probe\.dataKey === key/,
    'the status must be read only when it belongs to the job in the URL');
  assert.match(guardSrc, /if \(isActionAllowedForStatus\(action, code\)\) return;/,
    'an allowed action must not be touched');
  assert.match(guardSrc, /openJobAction\(actionForJobStatus\(code\), jobId\)/,
    'a refused action must land on the screen for that status');
  assert.match(guardSrc, /reroutedRef\.current === once/,
    'the re-route must fire once per (job, action) or two screens can ping-pong');
  assert.match(guardSrc, /showToast\(\{[\s\S]{0,200}?statusLabel\(code\)/,
    'the operator must be told why the screen changed');
});

test('every page that can open a write console mounts the SHARED guard', () => {
  for (const pg of PAGES) {
    const pageSrc = strip(read(pg));
    assert.match(pageSrc, /useJobActionStatusGuard\(\);/,
      `${pg} opens a write console from the URL and must mount the guard`);
    assert.match(pageSrc, /useJobActionStatusGuard[\s\S]{0,200}?from '@\/lib\/job-action-url'/,
      `${pg} must import the guard from lib/job-action-url — a second copy would drift`);
  }
});

// ─── 4. Differential controls ────────────────────────────────────────────

test('differential control — the guards go red when their subject is removed', () => {
  const cases = [
    ['the dataKey identity check', url,
      url.replace('probe.dataKey === key', 'true'),
      /probe\.dataKey === key/],
    ['the once-per-job latch', url,
      url.replace(/if \(reroutedRef\.current === once\) return;/, ''),
      /reroutedRef\.current === once/],
    ['schedule’s status-0 pin', url,
      url.replace("{ status: 0, canonical: 'schedule'", "{ status: 4, canonical: 'schedule'"),
      /status: 0,\s*canonical: 'schedule'/],
    ['the unguarded short-circuit', url,
      url.replace('if (!GUARDED_ACTIONS.has(action)) return true;', ''),
      /if \(!GUARDED_ACTIONS\.has\(action\)\) return true;/],
  ];
  for (const [what, original, mutated, pattern] of cases) {
    assert.notEqual(mutated, original, `the mutation for ${what} did not change the source`);
    assert.match(original, pattern, `control: ${what} matches the real source`);
    assert.doesNotMatch(mutated, pattern, `${what}: the guard still passes with its subject removed`);
  }
});

// ─── 5. The statuses agree with the stage map both repos share ───────────

test('9 / 0 / 1 are the stages this CRM says they are', () => {
  const stages = read(STAGES_SRC);
  for (const [key, status] of [['unconfirmed', 9], ['pending-scheduling', 0], ['pending-start', 1]]) {
    assert.match(stages, new RegExp(`'${key}':\\s*\\{[^}]*visibleStatuses: \\[${status}\\]`),
      `${key} must still be job_status ${status} — the guard's map is derived from it`);
  }
});
