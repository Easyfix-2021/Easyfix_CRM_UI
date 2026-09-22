'use strict';

/*
 * Owner amendment 2026-09-22 to the material request flow v2 design
 * (EasyFix_Backend docs/superpowers/specs/2026-09-21-material-request-flow-
 * v2-design.md): each technician "Send for Approval" creates a separate
 * quotation; GET /admin/quotations?jobId= gains `quotation_no` (1..n, null
 * for drafts) on every row. This pins the ONE shared grouping helper
 * (src/lib/quotation-groups.ts) that both JobModal's JobQuotationsTab and
 * MaterialReviewModal use, so the two surfaces can never group differently.
 *
 * Runner: `node --test` against `.test-build/quotation-groups.js`
 * (compiled by `npm run test:build`, same convention as job-buckets.test.js).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { groupByQuotationNo } = require('../.test-build/quotation-groups.js');

test('groups ascending by quotation_no, drafts (null) last', () => {
  const rows = [
    { id: 1, quotation_no: 2 },
    { id: 2, quotation_no: null },
    { id: 3, quotation_no: 1 },
    { id: 4, quotation_no: 1 },
  ];
  const groups = groupByQuotationNo(rows);
  assert.deepEqual(groups.map((g) => g.quotationNo), [1, 2, null]);
  assert.deepEqual(groups[0].rows.map((r) => r.id), [3, 4]);
  assert.deepEqual(groups[1].rows.map((r) => r.id), [1]);
  assert.deepEqual(groups[2].rows.map((r) => r.id), [2]);
});

test('undefined quotation_no (older backend, column absent) is treated exactly like null', () => {
  const rows = [
    { id: 1, quotation_no: 1 },
    { id: 2 }, // no quotation_no key at all
    { id: 3, quotation_no: null },
  ];
  const groups = groupByQuotationNo(rows);
  // Positive control that this isn't silently a no-op: exactly one numbered
  // group plus exactly one trailing null bucket, not three separate groups.
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.quotationNo), [1, null]);
  // Both the undefined-key row and the null-key row land in the SAME bucket,
  // in the order they were passed in — never split, never dropped.
  assert.deepEqual(groups[1].rows.map((r) => r.id), [2, 3]);
});

test('stable line order within a group is preserved (insertion order, not re-sorted)', () => {
  const rows = [
    { id: 5, quotation_no: 3 },
    { id: 1, quotation_no: 3 },
    { id: 9, quotation_no: 3 },
  ];
  const groups = groupByQuotationNo(rows);
  assert.deepEqual(groups[0].rows.map((r) => r.id), [5, 1, 9]);
});

test('no draft group is emitted when every row is numbered', () => {
  const rows = [{ id: 1, quotation_no: 1 }, { id: 2, quotation_no: 2 }];
  const groups = groupByQuotationNo(rows);
  assert.deepEqual(groups.map((g) => g.quotationNo), [1, 2]);
});

test('an all-draft job produces exactly one group', () => {
  const rows = [{ id: 1, quotation_no: null }, { id: 2, quotation_no: undefined }];
  const groups = groupByQuotationNo(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].quotationNo, null);
  assert.deepEqual(groups[0].rows.map((r) => r.id), [1, 2]);
});

test('empty input never crashes', () => {
  assert.deepEqual(groupByQuotationNo([]), []);
});
