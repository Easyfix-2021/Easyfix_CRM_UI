'use strict';
/*
 * Manage Jobs · Tx name cell for an offered / accepted job (ops issue #13).
 *
 * A job whose Bucket Status read "Offered To Tx" printed "unassigned" in the Tx
 * name column: an offer does not set fk_easyfixter_id until a technician
 * accepts. Ops asked for the same treatment Pending for Scheduling (My Orders)
 * already gives: only an "Offered to N Tx" chip in the row, the names on hover —
 * and, once accepted, only that technician's name and ID.
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

test('accepted wins: the accepter shows as ID + name only, before the offered chip', () => {
  assert.ok(cell, 'UnassignedTx must exist');
  const acceptedAt = cell.indexOf('offerEfrsWith(row, OFFER_ACCEPTED)');
  const offeredAt = cell.indexOf('offerEfrsWith(row, OFFER_OFFERED)');
  assert.ok(acceptedAt > -1 && offeredAt > -1 && acceptedAt < offeredAt,
    'the accepted check must run before the offered chip, so a leftover OFFERED row cannot hide the accepter');
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
