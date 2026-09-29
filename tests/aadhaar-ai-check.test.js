'use strict';

/*
 * aadhaar-ai-check — the one mapping from the backend's recorded AI Aadhaar
 * verdict to what the verification page and the Registered queue show.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('../.test-build/aadhaar-ai-check.js');

test('each verdict renders its own badge; no check on record renders none', () => {
  assert.deepEqual(A.aadhaarAiBadge('verified'), { label: 'AI Verified ✓', tone: 'success' });
  assert.deepEqual(A.aadhaarAiBadge('mismatch'), { label: 'AI: Mismatch ⚠', tone: 'warning' });
  assert.deepEqual(A.aadhaarAiBadge('not_run'), { label: 'AI: Not Run', tone: 'neutral' });
  assert.equal(A.aadhaarAiBadge(null), null);
  assert.equal(A.aadhaarAiBadge(undefined), null);
  assert.equal(A.aadhaarAiBadge('something-new'), null, 'an unknown verdict is not guessed at');
});

test('a mismatch lists what differed, field by field, masked as recorded', () => {
  const rows = A.aadhaarAiDifferences({
    discrepancies: [
      { field: 'name', expected: 'Ramesh Kumar', found: 'Suresh Rao' },
      { field: 'aadhaarNumber', expected: 'XXXX XXXX 0123', found: 'XXXX XXXX 1098' },
      { field: 'dob', expected: '1990-04-17', found: null },
    ],
  });
  assert.deepEqual(rows, [
    { label: 'Name', entered: 'Ramesh Kumar', onCard: 'Suresh Rao' },
    { label: 'Aadhaar Number', entered: 'XXXX XXXX 0123', onCard: 'XXXX XXXX 1098' },
    { label: 'Date Of Birth', entered: '1990-04-17', onCard: '—' },
  ]);
  for (const r of rows) assert.doesNotMatch(`${r.entered}${r.onCard}`, /\d{12}/);
  assert.deepEqual(A.aadhaarAiDifferences(null), []);
});

test('a not-run check always says why', () => {
  assert.match(A.aadhaarAiReason('not_configured'), /switched off/);
  assert.match(A.aadhaarAiReason('unreadable'), /could not read/);
  assert.match(A.aadhaarAiReason('name_not_compared'), /no name was compared/);
  assert.match(A.aadhaarAiReason(null), /verify the Aadhaar photos manually/);
});
