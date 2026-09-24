'use strict';

/*
 * Material-brand pair helpers (2026-09-24 tx_share redesign) backing
 * AddClientMaterialsDialog's master-rows picker — a pair already on the
 * client's card (in ANY existing group, for its material_id + brand_id, or
 * the "No Brand" bucket) must never appear again in the search results.
 *
 * Runner: `node --test` against `.test-build/material-rate-pairs.js`
 * (compiled by `npm run test:build`).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pairKey, existingPairKeys, hideExistingPairs } = require('../.test-build/material-rate-pairs.js');

test('pairKey distinguishes brands and treats null as "no brand"', () => {
  assert.equal(pairKey(1, 2), '1:2');
  assert.equal(pairKey(1, null), '1:none');
  assert.notEqual(pairKey(1, 2), pairKey(2, 1));
});

test('existingPairKeys collects one key per (material_id, brand_id) across every group, and one for No Brand', () => {
  const items = [
    { material_id: 10, groups: [{ brands: [{ brand_id: 1 }] }, { brands: [{ brand_id: 2 }] }] },
    { material_id: 20, groups: [{ brands: [] }] }, // No Brand
  ];
  const keys = existingPairKeys(items);
  assert.equal(keys.size, 3);
  assert.ok(keys.has('10:1'));
  assert.ok(keys.has('10:2'));
  assert.ok(keys.has('20:none'));
});

test('hideExistingPairs removes only rows whose exact pair is already on the card', () => {
  const existing = existingPairKeys([{ material_id: 10, groups: [{ brands: [{ brand_id: 1 }] }] }]);
  const masterRows = [
    { material_id: 10, brand_id: 1, label: 'Adapter 5A - Havells' }, // already on card
    { material_id: 10, brand_id: 2, label: 'Adapter 5A - Philips' }, // same material, different brand — must stay
    { material_id: 30, brand_id: null, label: 'Screwdriver Set' },  // unrelated material — must stay
  ];
  const result = hideExistingPairs(masterRows, existing);
  assert.deepEqual(result.map((r) => r.label), ['Adapter 5A - Philips', 'Screwdriver Set']);
});

test('an empty existing set hides nothing (positive control: the filter actually ran, not a no-op that hides everything)', () => {
  const masterRows = [{ material_id: 1, brand_id: null, label: 'A' }, { material_id: 2, brand_id: 3, label: 'B' }];
  const result = hideExistingPairs(masterRows, existingPairKeys([]));
  assert.equal(result.length, 2);
});
