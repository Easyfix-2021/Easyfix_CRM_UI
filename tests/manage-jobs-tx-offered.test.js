'use strict';
/*
 * Manage Jobs · Tx name cell for an offered / accepted job (ops issue #13).
 *
 * A job whose Bucket Status read "Offered To Tx" printed "unassigned" in the Tx
 * name column: an offer does not set fk_easyfixter_id until a technician
 * accepts. Ops asked for the same treatment Pending for Scheduling (My Orders)
 * already gives: only an "Offered to N Tx" chip in the row, the names on hover —
 * and, once accepted, only that technician's name and ID (the assigned branch,
 * since accepting sets fk_easyfixter_id).
 *
 * Source-shape guard (the suite mounts nothing). Each assertion names the
 * regression it blocks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PAGE = read('src/app/(authed)/jobs/page.tsx');
const flat = PAGE.replace(/\s+/g, ' ');
const cell = (flat.match(/function UnassignedTx\(\{ row \}: \{ row: JobRow \}\) \{[\s\S]*?type Resp =/) || [''])[0];

test('an unassigned row renders the offer-aware cell, not a bare "unassigned"', () => {
  assert.match(flat, /\) : <UnassignedTx row=\{j\} \/>\}/);
  assert.match(flat, /offer_efrs\?: OfferEfr\[\] \| null;/);
});

test('an ACCEPTED offer row is never read by the unassigned cell (it is always stale there)', () => {
  // acceptOffer sets fk_easyfixter_id in the same transaction, so an accepted
  // job shows its technician through the assigned branch. On a job with NO
  // technician an ACCEPTED row is a leftover from a reassign (release +
  // re-offer): reading it named a technician who no longer held the job and hid
  // the live "Offered to Tx" chip (pre-Production review, 2026-09-15).
  assert.ok(cell, 'UnassignedTx must exist');
  assert.match(cell, /const offered = offerEfrsWith\(row, OFFER_OFFERED\);/);
  assert.doesNotMatch(cell, /OFFER_ACCEPTED|offer_status === 1/, 'the cell must not pick up ACCEPTED rows');
  assert.doesNotMatch(PAGE, /const OFFER_ACCEPTED/);
  assert.doesNotMatch(PAGE, /AcceptedTag/, 'ops asked for only the name and ID once accepted — no extra tag');
});

test('offered: only the chip in the row — names appear on hover, never in the cell', () => {
  assert.match(cell, /<OfferHoverCard jobId=\{row\.job_id\} enabled> <StatusChip tone="orange"/,
    'the chip sits inside the shared OfferHoverCard, which shows the names');
  assert.match(cell, /\{offered\.length > 1 \? `Offered to \$\{offered\.length\} Tx` : 'Offered to Tx'\}/);
  assert.doesNotMatch(cell, /offered\.slice\(|offered\.map\(/, 'offered names must not be listed in the row');
  assert.doesNotMatch(PAGE, /OFFERED_NAMES_SHOWN|hover to see all/);
});

test('the chip reads exactly like Pending for Scheduling on My Orders', () => {
  const myOrders = read('src/app/(authed)/my-orders/page.tsx').replace(/\s+/g, ' ');
  assert.match(myOrders, /<StatusChip tone="orange"/);
  assert.match(myOrders, /`Offered to \$\{j\.offered_count\} Tx` : 'Offered to Tx'/);
});

test('no offers and no accepter keeps the old "unassigned"', () => {
  assert.match(cell, /if \(offered\.length === 0\) return <span className="text-muted-foreground">unassigned<\/span>;/);
});
