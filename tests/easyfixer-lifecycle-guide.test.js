'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const guide = require('../src/lib/easyfixer-lifecycle-guide.ts');
const lifecycle = require('../src/lib/easyfixer-lifecycle.ts');

/*
 * The CRM transition contract for a VERIFIED, UNMAPPED technician — exactly the
 * output of backend allowedCrmTransitions(status, verified=true, managerId=0)
 * with the self status removed (see
 * EasyFix_Backend/services/easyfixer-lifecycle.service.js). The guide's
 * crmTransitionTargets() is a hand-port of that function; this table pins the
 * two together so a backend rule change that is not mirrored in the guide fails
 * loudly here instead of silently misinforming Ops.
 *
 * Kept byte-for-byte in sync with the mirror in
 * EasyFix_Backend/tests/easyfixer-lifecycle-crm-transition-contract.test.js.
 */
const EXPECTED = {
  NEW: ['REGISTRATION_INCOMPLETE', 'TRAINING_PENDING', 'ASSESSMENT_FAILED', 'UNDER_VERIFICATION', 'VERIFICATION_REJECTED', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  REGISTRATION_INCOMPLETE: ['NEW', 'TRAINING_PENDING', 'ASSESSMENT_FAILED', 'UNDER_VERIFICATION', 'VERIFICATION_REJECTED', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  TRAINING_PENDING: ['NEW', 'REGISTRATION_INCOMPLETE', 'ASSESSMENT_FAILED', 'UNDER_VERIFICATION', 'VERIFICATION_REJECTED', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  ASSESSMENT_FAILED: ['NEW', 'REGISTRATION_INCOMPLETE', 'TRAINING_PENDING', 'UNDER_VERIFICATION', 'VERIFICATION_REJECTED', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  UNDER_VERIFICATION: ['NEW', 'REGISTRATION_INCOMPLETE', 'TRAINING_PENDING', 'ASSESSMENT_FAILED', 'VERIFICATION_REJECTED', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  VERIFICATION_REJECTED: ['NEW', 'REGISTRATION_INCOMPLETE', 'TRAINING_PENDING', 'ASSESSMENT_FAILED', 'UNDER_VERIFICATION', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  ACTIVE: ['PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'OFFLINE', 'ON_BENCH', 'SUSPENDED'],
  PAUSED: ['ACTIVE', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'OFFLINE', 'ON_BENCH', 'SUSPENDED'],
  INACTIVE: ['DORMANT', 'BLACKLISTED'],
  REAPPLIED: ['REGISTRATION_INCOMPLETE', 'APPLICATION_REJECTED'],
  APPLICATION_REJECTED: ['NEW', 'REGISTRATION_INCOMPLETE', 'TRAINING_PENDING', 'ASSESSMENT_FAILED', 'UNDER_VERIFICATION', 'VERIFICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  BLACKLISTED: ['ACTIVE', 'PAUSED', 'INACTIVE', 'DORMANT', 'OFFLINE', 'ON_BENCH', 'SUSPENDED'],
  DORMANT: ['INACTIVE', 'BLACKLISTED'],
  UNDER_MASTER: ['ACTIVE', 'PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'OFFLINE', 'ON_BENCH', 'SUSPENDED'],
  OFFLINE: ['ACTIVE', 'PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'ON_BENCH', 'SUSPENDED'],
  ON_BENCH: ['ACTIVE', 'PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'OFFLINE', 'SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'OFFLINE', 'ON_BENCH'],
};

test('crmTransitionTargets matches the backend CRM transition contract for every status', () => {
  for (const status of lifecycle.EASYFIXER_LIFECYCLE_STATUSES) {
    assert.deepEqual(
      guide.crmTransitionTargets(status),
      EXPECTED[status],
      `crmTransitionTargets(${status})`,
    );
  }
});

test('the contract covers exactly the canonical lifecycle statuses', () => {
  assert.deepEqual(
    Object.keys(EXPECTED).sort(),
    [...lifecycle.EASYFIXER_LIFECYCLE_STATUSES].sort(),
  );
});

test('every lifecycle status is documented in the guide exactly once', () => {
  const documented = guide.LIFECYCLE_GUIDE_GROUPS.flatMap((group) => group.entries.map((entry) => entry.status));
  assert.equal(documented.length, lifecycle.EASYFIXER_LIFECYCLE_STATUSES.length, 'no duplicates / omissions');
  assert.deepEqual([...documented].sort(), [...lifecycle.EASYFIXER_LIFECYCLE_STATUSES].sort());
});

test('the guide never lists a status as a target of itself', () => {
  for (const status of lifecycle.EASYFIXER_LIFECYCLE_STATUSES) {
    assert.equal(
      guide.crmTransitionTargets(status).includes(status),
      false,
      `${status} must not list itself as a target`,
    );
  }
});
