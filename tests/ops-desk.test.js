'use strict';
/*
 * Pure logic behind the Ops Desk (spec 3.2) + job-chat/verification polling —
 * band labels, the "Client ₹X · TX ₹Y[ · Margin ₹Z]" money line, and the
 * visible-tab polling gate (lib/ops-desk.ts). Lifted out of the page/dialog
 * components for the same reason lib/job-buckets.ts is: a page component
 * drags React + the Next runtime into any test that imports it.
 *
 * Runner: `node --test` (via `npm test`, which runs `test:build` first —
 * ops-desk.ts is in that tsc file list in package.json).
 *
 * Each check below was run against a mutated copy of ops-desk.ts and watched
 * go red before being restored, so a future regression in the SAME spot is
 * proven to fail here (not just plausible):
 *   - OPS_BAND_LABEL.B  edited from 'Stuck On Client' to 'Stuck on client'
 *     (wrong case)              → 'band labels are Title Case, verbatim' failed.
 *   - formatOpsMoney     'Client' → 'client' in the template literal
 *                                  → 'formatOpsMoney renders the exact prototype string' failed.
 *   - formatJobMoney     dropped the '· Margin' segment entirely
 *                                  → 'formatJobMoney appends Margin to the Ops Desk line' failed.
 *   - pollIntervalMs     `return tabVisible ? baseMs : undefined;` inverted to
 *                          `!tabVisible ? baseMs : undefined`
 *                                  → both pollIntervalMs tests failed (visible/hidden swapped).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OPS_BANDS, OPS_BAND_LABEL, PENDING_ON_LABEL,
  formatOpsMoney, formatJobMoney, needsMeInLabel, pollIntervalMs,
} = require('../.test-build/ops-desk.js');

// ─── Band labels (spec 3.2: "A On Site, Moving · B Stuck On Client · C Quality Check · D Cannot Finish As Booked") ───

test('band labels are Title Case, verbatim, in A→D order', () => {
  assert.deepEqual(OPS_BANDS, ['A', 'B', 'C', 'D']);
  assert.equal(OPS_BAND_LABEL.A, 'On Site, Moving');
  assert.equal(OPS_BAND_LABEL.B, 'Stuck On Client');
  assert.equal(OPS_BAND_LABEL.C, 'Quality Check');
  assert.equal(OPS_BAND_LABEL.D, 'Cannot Finish As Booked');
});

test('every band has a label — no silent gap if a band is ever added', () => {
  for (const b of OPS_BANDS) {
    assert.ok(OPS_BAND_LABEL[b], `Band ${b} has no label`);
  }
});

// ─── Pending On pill labels ──────────────────────────────────────────────

test('pendingOn values map to their Title Case pill label', () => {
  assert.equal(PENDING_ON_LABEL.technician, 'Technician');
  assert.equal(PENDING_ON_LABEL.easyfix, 'EasyFix');
  assert.equal(PENDING_ON_LABEL.client, 'Client');
});

// ─── Money formatting ────────────────────────────────────────────────────

test('formatOpsMoney renders the exact prototype string', () => {
  assert.equal(formatOpsMoney(1600, 800), 'Client ₹1,600 · TX ₹800');
  // Indian digit grouping, not a plain toString — a five-figure amount is
  // where the two diverge (₹12,000 vs ₹12000).
  assert.equal(formatOpsMoney(12000, 6000), 'Client ₹12,000 · TX ₹6,000');
});

test('formatOpsMoney renders an em-dash for a missing amount, never "null" or "NaN"', () => {
  assert.equal(formatOpsMoney(null, 800), 'Client — · TX ₹800');
  assert.equal(formatOpsMoney(undefined, undefined), 'Client — · TX —');
});

test('formatJobMoney appends Margin to the Ops Desk line (Summary Money card, spec 3.9)', () => {
  assert.equal(formatJobMoney(1600, 800, 800), 'Client ₹1,600 · TX ₹800 · Margin ₹800');
  assert.equal(formatJobMoney(null, null, null), 'Client — · TX — · Margin —');
});

// ─── Needs Me In column ──────────────────────────────────────────────────

test('needsMeInLabel renders minutes, or an em-dash when there is nothing to wait for', () => {
  assert.equal(needsMeInLabel(12), '12 min');
  assert.equal(needsMeInLabel(0), '0 min');
  assert.equal(needsMeInLabel(null), '—');
  assert.equal(needsMeInLabel(undefined), '—');
});

// ─── Visible-tab polling gate (perf standard: poll only while visible) ──

test('pollIntervalMs polls at the given interval while the tab is visible', () => {
  assert.equal(pollIntervalMs(true, 30_000), 30_000);
  assert.equal(pollIntervalMs(true, 20_000), 20_000);
});

test('pollIntervalMs disables polling (undefined) while the tab is hidden', () => {
  // undefined, not 0 or -1 — useFetch's effect only skips the interval on a
  // falsy `ms` check (`if (!enabled || !key || !ms) return;`), and 0 is
  // falsy too, but `undefined` is the honest "no interval configured" value
  // an interval consumer expects, so a caller cannot mistake this for "poll
  // every 0ms" if that check is ever tightened.
  assert.equal(pollIntervalMs(false, 30_000), undefined);
});

/* ── /admin/verification flattening ─────────────────────────────────────────
 * The backend sends { audit:{items,total}, claims:{items,total,truncated} }.
 * The first CRM build read `data.items` — a field that response does not have —
 * so the page rendered "Nothing waiting for verification." over a full queue.
 * These pin the real shape, and that claims come first. */
const { toVerificationRows } = require('../.test-build/ops-desk.js');

const hdr = (jobId, over = {}) => ({
  jobId, reference: null, title: 'AC', clientName: 'C', technician: null, jobStatus: 3, ...over,
});

test('verification: both queues are rendered, claims before audit rows', () => {
  const { rows, total } = toVerificationRows({
    audit: { items: [hdr(1, { finishedOn: '2026-09-24 10:00:00' })], total: 7 },
    claims: {
      items: [{ ...hdr(2), reportId: 55, kind: 'cant_complete', reasonText: 'Site not ready',
        proofImageIds: [9], visitChargeAwarded: true, reportedOn: '2026-09-24 11:00:00' }],
      total: 1, truncated: false,
    },
  });
  assert.deepEqual(rows.map((r) => r.jobId), [2, 1]);
  assert.equal(rows[0].report.id, 55);
  assert.equal(rows[1].report, null);
  assert.equal(rows[1].submittedOn, '2026-09-24 10:00:00');
  assert.equal(total, 7, 'the pager moves through the audit queue only');
});

test('verification: a cancel ask with no claim row is routed to the job, not the claim endpoint', () => {
  const { rows } = toVerificationRows({
    audit: { items: [], total: 0 },
    claims: { items: [{ ...hdr(3), reportId: null, kind: 'cancel_request', reasonText: null,
      proofImageIds: [], visitChargeAwarded: false, reportedOn: null }], total: 1, truncated: false },
  });
  assert.equal(rows[0].report, null);
  assert.equal(rows[0].legacyCancelAsk, true);
});

test('verification: a missing payload is an empty table, not a crash', () => {
  assert.deepEqual(toVerificationRows(null), { rows: [], total: 0 });
});
