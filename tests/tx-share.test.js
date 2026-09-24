'use strict';

/*
 * Tx Share (2026-09-24 contract, owner-approved) — the ONE pure helper the
 * whole feature turns on: Tx Share defaults to 20% of price, rounded to 2dp,
 * and resets EVERY time the price it's attached to changes but is otherwise
 * freely editable. Client rate-card groups/state-overrides, quotation lines'
 * Approved amount, and AddQuotationLineDialog's suggested Approved Amount
 * all go through src/lib/tx-share.ts rather than re-deriving "20%" each.
 *
 * Runner: `node --test` against `.test-build/tx-share.js` (compiled by
 * `npm run test:build`).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { defaultTxShare, applyPriceChange, computeApprovedTotal, applyQuotedChange } = require('../.test-build/tx-share.js');

test('defaultTxShare is 20% of price, rounded to 2dp', () => {
  assert.equal(defaultTxShare(100), 20);
  assert.equal(defaultTxShare(33.33), 6.67); // 6.666 -> rounds to 6.67
  assert.equal(defaultTxShare(10.005), 2);
  // Mutation to try: change the 20% multiplier (e.g. 0.25) — this assertion
  // catches it immediately (defaultTxShare(100) would become 25, not 20).
});

test('defaultTxShare treats null/undefined/NaN price as 0', () => {
  assert.equal(defaultTxShare(null), 0);
  assert.equal(defaultTxShare(undefined), 0);
  assert.equal(defaultTxShare(Number('not a number')), 0);
  assert.equal(defaultTxShare(0), 0);
});

test('a price change resets Tx Share to 20%, but a manual Tx Share edit is kept until the NEXT price change', () => {
  // Row born from a master price of 100 — Tx Share defaults to 20.
  let row = applyPriceChange({}, 100);
  assert.deepEqual(row, { price: 100, txShare: 20 });

  // Operator manually overrides Tx Share — a plain field patch, exactly what
  // the UI's Tx Share input does (never calls applyPriceChange).
  row = { ...row, txShare: 55 };
  assert.equal(row.txShare, 55, 'the manual edit must stick immediately');

  // Price has NOT changed yet — nothing in the flow re-derives Tx Share on
  // its own, so the manual 55 survives.
  assert.equal(row.txShare, 55);

  // NOW the price changes — Tx Share must reset to 20% of the NEW price,
  // discarding the manual 55. Mutation to try: have applyPriceChange spread
  // txShare from the input row instead of recomputing it — this assertion
  // (expecting 40, not the stale 55) catches that regression.
  row = applyPriceChange(row, 200);
  assert.equal(row.txShare, 40);
  assert.equal(row.price, 200);
});

test('computeApprovedTotal = (quoted unit price + Tx Share per unit) × qty, rounded to 2dp', () => {
  assert.equal(computeApprovedTotal(100, 20, 3), 360);
  assert.equal(computeApprovedTotal(33, 6.6, 3), 118.8);
  assert.equal(computeApprovedTotal(0, 0, 5), 0);
});

test('applyQuotedChange recomputes Approved (LINE total) on every Quoted change; a manual Approved edit is kept until the NEXT Quoted change', () => {
  let line = applyQuotedChange({}, 100, 20, 2); // (100+20)*2 = 240
  assert.deepEqual(line, { quotedUnitPrice: 100, approvedAmount: 240 });

  // Operator manually overrides the Approved total.
  line = { ...line, approvedAmount: 500 };
  assert.equal(line.approvedAmount, 500);

  // Quoted changes — Approved must be recomputed from scratch, discarding
  // the manual 500. (100 -> 150, tx share unchanged at 20, qty 2): 340.
  line = applyQuotedChange(line, 150, 20, 2);
  assert.equal(line.approvedAmount, 340);
  assert.equal(line.quotedUnitPrice, 150);
});
