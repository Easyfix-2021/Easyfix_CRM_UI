'use strict';
/*
 * Manage Jobs · Tx name cell for an offered / accepted job (ops issue #13).
 *
 * A job whose Bucket Status read "Offered To Tx" printed "unassigned" in the Tx
 * name column: an offer does not set fk_easyfixter_id until a technician
 * accepts. Ops asked for the offerees' names there — the full list on hover
 * when it is long — and, once accepted, only that technician's name and ID.
 *
 * Source-shape guard (the suite mounts nothing). Each assertion names the
 * regression it blocks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'src/app/(authed)/jobs/page.tsx'), 'utf8');
const flat = PAGE.replace(/\s+/g, ' ');
const cell = (flat.match(/function UnassignedTx\(\{ row \}: \{ row: JobRow \}\) \{[\s\S]*?\n?\}\s*type Resp =/) || [''])[0];

test('an unassigned row renders the offer-aware cell, not a bare "unassigned"', () => {
  assert.match(flat, /\) : <UnassignedTx row=\{j\} \/>\}/);
  assert.match(flat, /offer_efrs\?: OfferEfr\[\] \| null;/);
});

test('accepted wins: the accepter shows as ID + name only, before any offer list', () => {
  assert.ok(cell, 'UnassignedTx must exist');
  const acceptedAt = cell.indexOf('offerEfrsWith(row, OFFER_ACCEPTED)');
  const offeredAt = cell.indexOf('offerEfrsWith(row, OFFER_OFFERED)');
  assert.ok(acceptedAt > -1 && offeredAt > -1 && acceptedAt < offeredAt,
    'the accepted check must run before the offered list, so a leftover OFFERED row cannot turn the accepter back into a list');
  assert.doesNotMatch(PAGE, /AcceptedTag/, 'ops asked for only the name and ID once accepted — no extra tag');
});

test('offered: a few names in the cell, the full list in the hover card', () => {
  assert.match(flat, /const OFFERED_NAMES_SHOWN = 3;/);
  assert.match(cell, /<OfferHoverCard jobId=\{row\.job_id\} enabled>/, 'the full list opens in the shared OfferHoverCard');
  assert.match(cell, /offered\.slice\(0, OFFERED_NAMES_SHOWN\)/);
  assert.match(cell, /\+\{hiddenCount\} more — hover to see all/);
  assert.doesNotMatch(cell, /title=\{hidden/, 'the long list must not fall back to a native title tooltip');
});

test('no offers and no accepter keeps the old "unassigned"', () => {
  assert.match(cell, /if \(offered\.length === 0\) return <span className="text-muted-foreground">unassigned<\/span>;/);
});
