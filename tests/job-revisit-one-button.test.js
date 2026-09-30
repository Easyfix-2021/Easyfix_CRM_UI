/*
 * STATUS 10: EXACTLY ONE FOOTER ACTION (2026-09-30, owner).
 *
 * Status 10 is both Revisit and Under Audit. Schedule Visit 2 (10 → 1) belongs
 * to a revisit, Audit & Checkout (10 → 3) to a finished job; showing both let
 * ops complete unfinished work (a payout for it) or send a technician back to a
 * finished site. Both gates now read the one predicate, on opposite sides.
 *
 * Runner: `node --test` (see npm test).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/components/job/JobModal.tsx'), 'utf8')
  .replace(/\s+/g, ' ');

test('Schedule Visit 2 shows only on a revisit, Audit & Checkout only on a non-revisit', () => {
  assert.match(src, /const isRevisitPending = \(job: Record<string, unknown>\) =>/, 'the predicate exists');
  assert.ok(src.includes('{can[APP_REQUEST_ACTION] && isRevisitPending(job) && ( <Button size="sm" onClick={() => setVisitTwoOpen(true)}>Schedule Visit 2</Button>'),
    'Schedule Visit 2 must be gated on isRevisitPending(job)');
  assert.ok(src.includes('const canAuditCheckout = s === ST.REVISIT && !isRevisitPending(job) &&'),
    'Audit & Checkout must be gated on !isRevisitPending(job)');
  assert.doesNotMatch(src, /APP_REQUEST_ACTION\] && s === ST\.REVISIT/, 'the old status-only gate is gone');
});
