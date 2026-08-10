'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lifecycle = require('../src/lib/easyfixer-lifecycle.ts');
const contract = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../shared/wire-contract.json'),
  'utf8',
));

test('CRM lifecycle statuses match the shared wire contract', () => {
  assert.deepEqual(
    [...lifecycle.EASYFIXER_LIFECYCLE_STATUSES],
    contract.technicianLifecycle.statuses,
  );
});

test('normalizes nested snapshots and list-row aliases', () => {
  assert.equal(lifecycle.lifecycleStatusFrom({ lifecycle_status: 'under-master' }), 'UNDER_MASTER');
  assert.equal(lifecycle.lifecycleStatusFrom({ lifecycle: { status: 'paused' } }), 'PAUSED');

  assert.deepEqual(
    lifecycle.normalizeLifecycleSnapshot({
      lifecycle: {
        status: 'SUSPENDED',
        reasonCode: 'OPS_REVIEW',
        reason: 'Investigation',
        changedAt: '2026-08-10T10:00:00.000Z',
        until: '2026-08-12',
        version: 7,
        pauseCount: 2,
        jobsAllowed: false,
        canReapply: false,
        canClaimEarnings: true,
        source: 'CRM',
        capabilities: {
          receiveNewJobs: false,
          continueAssignedJobs: true,
          mutateAssignedJobs: true,
          markAttendance: false,
          editRegistration: false,
          claimMoney: true,
          reapply: false,
          readOnlyApp: false,
        },
      },
    }),
    {
      status: 'SUSPENDED',
      reasonCode: 'OPS_REVIEW',
      reason: 'Investigation',
      changedAt: '2026-08-10T10:00:00.000Z',
      until: '2026-08-12',
      version: 7,
      pauseCount: 2,
      jobsAllowed: false,
      canReapply: false,
      canClaimEarnings: true,
      source: 'CRM',
      capabilities: {
        receiveNewJobs: false,
        continueAssignedJobs: true,
        mutateAssignedJobs: true,
        markAttendance: false,
        editRegistration: false,
        claimMoney: true,
        reapply: false,
        readOnlyApp: false,
      },
      allowedTransitions: [],
      allowedTransitionsProvided: false,
    },
  );
});

test('validates audited and timed transitions', () => {
  const base = {
    currentStatus: 'ACTIVE',
    targetStatus: 'SUSPENDED',
    reason: 'Compliance review',
    until: '2026-08-12',
    today: '2026-08-10',
  };
  assert.equal(lifecycle.validateLifecycleTransition(base), null);
  assert.match(
    lifecycle.validateLifecycleTransition({ ...base, reason: '' }),
    /reason is required/i,
  );
  assert.match(
    lifecycle.validateLifecycleTransition({ ...base, until: '' }),
    /requires an end date/i,
  );
  assert.match(
    lifecycle.validateLifecycleTransition({ ...base, until: '2026-08-10' }),
    /future/i,
  );
  assert.equal(
    lifecycle.validateLifecycleTransition({ ...base, targetStatus: 'PAUSED', until: '' }),
    null,
  );
});

test('blacklisted is terminal and history aliases are normalized', () => {
  const blacklisted = lifecycle.normalizeLifecycleSnapshot({ status: 'BLACKLISTED' });
  assert.ok(blacklisted);
  assert.deepEqual(lifecycle.lifecycleTargets(blacklisted), []);

  const history = lifecycle.normalizeLifecycleHistory({
    items: [{
      id: 12,
      from_status: 'ACTIVE',
      to_status: 'PAUSED',
      actor_user_id: '42',
      metadata: { actorName: 'Ops Manager' },
      created_at: '2026-08-10T10:00:00.000Z',
      version: 3,
    }],
    total: 1,
    limit: 10,
    offset: 0,
  });
  assert.equal(history.items[0].fromStatus, 'ACTIVE');
  assert.equal(history.items[0].toStatus, 'PAUSED');
  assert.equal(history.items[0].actorUserId, 42);
  assert.equal(history.items[0].actorName, 'Ops Manager');
});

test('operational technicians cannot be sent back into onboarding', () => {
  const active = lifecycle.normalizeLifecycleSnapshot({ status: 'ACTIVE' });
  assert.ok(active);
  const targets = lifecycle.lifecycleTargets(active);
  assert.equal(targets.includes('REAPPLIED'), false);
  assert.equal(targets.includes('UNDER_VERIFICATION'), false);
  assert.equal(targets.includes('PAUSED'), true);
  assert.equal(targets.includes('SUSPENDED'), true);
});

test('onboarding transitions stay in onboarding and activation stays in Verify', () => {
  const reapplied = lifecycle.normalizeLifecycleSnapshot({ status: 'REAPPLIED' });
  assert.ok(reapplied);
  const targets = lifecycle.lifecycleTargets(reapplied);
  assert.equal(targets.includes('ACTIVE'), false);
  assert.equal(targets.includes('UNDER_MASTER'), false);
  assert.deepEqual(targets, ['REGISTRATION_INCOMPLETE', 'APPLICATION_REJECTED']);
  assert.equal(targets.includes('APPLICATION_REJECTED'), true);
});

test('inactive and dormant cannot bypass App reapply and second verification', () => {
  for (const status of ['INACTIVE', 'DORMANT']) {
    const snapshot = lifecycle.normalizeLifecycleSnapshot({ status });
    assert.ok(snapshot);
    assert.deepEqual(lifecycle.lifecycleTargets(snapshot), ['BLACKLISTED']);
  }
});

test('server-provided allowedTransitions override the conservative fallback', () => {
  const reapplied = lifecycle.normalizeLifecycleSnapshot({
    status: 'REAPPLIED',
    allowedTransitions: ['REAPPLIED', 'INACTIVE', 'BLACKLISTED'],
  });
  assert.ok(reapplied);
  assert.deepEqual(lifecycle.lifecycleTargets(reapplied), ['INACTIVE', 'BLACKLISTED']);
});

test('an authoritative empty server transition graph stays empty', () => {
  const inactive = lifecycle.normalizeLifecycleSnapshot({
    status: 'INACTIVE',
    allowedTransitions: [],
  });
  assert.ok(inactive);
  assert.deepEqual(lifecycle.lifecycleTargets(inactive), []);
});

test('reads registered re-application fields supplied by the backend', () => {
  assert.deepEqual(
    lifecycle.reapplicationSummary({
      lifecycle: { status: 'REAPPLIED' },
      previous_efr_id: 91,
      previous_performance_grade: 'A',
      previous_completed_jobs: 84,
    }),
    {
      isReapplication: true,
      previousTxId: 91,
      previousPerformanceGrade: 'A',
      lifetimeJobs: 84,
      lifetimeEarnings: null,
    },
  );
});

test('candidate offer eligibility gives explicit server fields precedence', () => {
  assert.deepEqual(
    lifecycle.candidateJobOfferEligibility({
      lifecycle_status: 'ACTIVE',
      lifecycle_reason: 'Temporarily blocked by the ranking service',
      can_offer: false,
    }),
    {
      canOffer: false,
      authoritative: true,
      status: 'ACTIVE',
      reason: 'Temporarily blocked by the ranking service',
      explanation: 'Temporarily blocked by the ranking service',
    },
  );
});

test('candidate offer eligibility falls back safely across rolling deployments', () => {
  const dormant = lifecycle.candidateJobOfferEligibility({ lifecycle_status: 'DORMANT' });
  assert.equal(dormant.canOffer, false);
  assert.equal(dormant.authoritative, true);
  assert.match(dormant.explanation, /Dormant technicians cannot receive new job offers/i);

  const capabilityBlocked = lifecycle.candidateJobOfferEligibility({
    lifecycle: {
      status: 'ACTIVE',
      capabilities: { receiveNewJobs: false },
    },
  });
  assert.equal(capabilityBlocked.canOffer, false);
  assert.equal(capabilityBlocked.authoritative, true);

  const malformedAuthoritativeField = lifecycle.candidateJobOfferEligibility({
    lifecycle_status: 'ACTIVE',
    can_offer: 'not-a-boolean',
  });
  assert.equal(malformedAuthoritativeField.canOffer, false);
  assert.equal(malformedAuthoritativeField.authoritative, true);

  assert.deepEqual(
    lifecycle.candidateJobOfferEligibility({ efr_id: 42 }),
    {
      canOffer: true,
      authoritative: false,
      status: null,
      reason: null,
      explanation: 'Eligible to receive new job offers.',
    },
  );
});

test('the visible candidate surface wins when SWR retains an overlapping stale row', () => {
  const eligible = { efr_id: 42, can_offer: true, lifecycle_status: 'ACTIVE' };
  const blocked = { efr_id: 42, can_offer: false, lifecycle_status: 'PAUSED' };

  const topVisible = lifecycle.mergeCandidatesByActiveSurface([eligible], [blocked], false);
  assert.equal(topVisible.get(42), eligible, 'hidden stale Search must not override Top 10');

  const searchVisible = lifecycle.mergeCandidatesByActiveSurface([eligible], [blocked], true);
  assert.equal(searchVisible.get(42), blocked, 'visible Search must control its own guard');
});

test('ranked surface keeps a restricted incumbent only as current context', () => {
  assert.equal(lifecycle.candidateVisibleOnRankedSurface({
    efr_id: 7,
    lifecycle_status: 'PAUSED',
    can_offer: false,
    is_current: true,
  }), true);
  assert.equal(lifecycle.candidateVisibleOnRankedSurface({
    efr_id: 8,
    lifecycle_status: 'PAUSED',
    can_offer: false,
  }), false);
  assert.equal(lifecycle.candidateVisibleOnRankedSurface({
    efr_id: 9,
    lifecycle_status: 'ACTIVE',
    can_offer: true,
  }), true);
});
