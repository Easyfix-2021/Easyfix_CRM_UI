'use strict';

/*
 * web-call-retry — the one silent retry a browser call gets (WebCallContext).
 *
 * The retry dials the customer AGAIN, so the rule that matters is when it must
 * NOT fire: a reason that reached a real person, a leg that connected, or a
 * second "Not Found" on the same operator click (which would loop).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldRetryWebCall } = require('../.test-build/web-call-retry.js');

const fresh = { attemptUsed: false, reachedInProgress: false };

test('"Not Found" on the first attempt retries — the stale-login signature', () => {
  assert.equal(shouldRetryWebCall('Not Found', fresh), true);
  assert.equal(shouldRetryWebCall('NotFound', fresh), true, 'SDK spelling variants');
  assert.equal(shouldRetryWebCall('not_found', fresh), true);
});

test('only ONCE per click — a second "Not Found" is a real failure, not a loop', () => {
  assert.equal(shouldRetryWebCall('Not Found', { ...fresh, attemptUsed: true }), false);
});

test('no retry without a recorded click (nothing to redial)', () => {
  assert.equal(shouldRetryWebCall('Not Found', { ...fresh, attemptUsed: null }), false);
});

test('never after the leg connected', () => {
  assert.equal(shouldRetryWebCall('Not Found', { ...fresh, reachedInProgress: true }), false);
});

test('never for outcomes that reached a person or the operator chose', () => {
  for (const r of ['Busy', 'No Answer', 'Declined', 'Cancelled', 'Failed', '']) {
    assert.equal(shouldRetryWebCall(r, fresh), false, r);
  }
});
