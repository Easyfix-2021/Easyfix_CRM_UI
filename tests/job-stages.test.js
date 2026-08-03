'use strict';

/*
 * job-stages — the per-user "which lifecycle stages may I touch?" model.
 *
 * WHY THIS IS WORTH TESTING. Every function here is a PERMISSION predicate, and
 * permission predicates fail in two opposite directions with very different
 * costs: too permissive shows a restricted user buttons the server will reject
 * (confusing), too restrictive hides work from someone who is supposed to do it
 * (invisible — nobody reports a tab they never knew existed).
 *
 * Three distinctions in this module are easy to collapse by accident, and each
 * one is pinned below:
 *
 *   1. mode 'all'  vs  mode 'list' with an EMPTY stages array.
 *      The first is unrestricted; the second is a real, saveable "no access"
 *      grant. A `!allowed.stages.length` shortcut would silently turn every
 *      locked-out user into an administrator.
 *   2. undefined/null allowed  →  UNRESTRICTED (fail-open), deliberately.
 *      The server row-filters authoritatively; the FE is defence-in-depth. A
 *      still-loading `me` must not blank the UI.
 *   3. transitionAllowed is SOURCE-ANCHORED. One single stage must own the
 *      source status AND permit the target. Checking the two conditions across
 *      DIFFERENT stages would let a user compose a move neither stage allows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../.test-build/job-stages.js');

const ALL = { mode: 'all', stages: [] };
const NONE = { mode: 'list', stages: [] };
const only = (...stages) => ({ mode: 'list', stages });

// ─── the pinned stage map ─────────────────────────────────────────────────

/*
 * Duplicated from the module's own header table on purpose: importing STAGES to
 * check STAGES would be vacuous. These codes are the backend's job_status
 * vocabulary, so a silent edit here is a cross-repo contract break.
 */
const EXPECTED = {
  'unconfirmed':        { visible: [9],     targets: [0, 6],           label: 'Unconfirmed Orders' },
  'pending-scheduling': { visible: [0],     targets: [1, 6, 9],        label: 'Pending for Scheduling' },
  'pending-start':      { visible: [1],     targets: [2, 20, 21, 6],   label: 'Pending to Start' },
  'pending-close':      { visible: [2, 20], targets: [3, 5, 21, 6],    label: 'Pending to Close' },
  'audit-complete':     { visible: [3, 5],  targets: [10],             label: 'Audit & Complete' },
  'pending-feedback':   { visible: [10],    targets: [],               label: 'Pending for Feedback' },
  'onhold':             { visible: [21],    targets: [1, 6],           label: 'Orders in Followup' },
  'estimate-pending':   { visible: [15],    targets: [0, 1, 6],        label: 'Estimate Pending' },
  'cancelled':          { visible: [6],     targets: [],               label: 'Cancelled' },
};

test('the stage map matches the pinned backend contract', () => {
  assert.deepEqual(Object.keys(S.STAGES).sort(), Object.keys(EXPECTED).sort());
  for (const [key, want] of Object.entries(EXPECTED)) {
    const def = S.STAGES[key];
    assert.equal(def.key, key, `${key}.key must equal its map key`);
    assert.deepEqual(def.visibleStatuses, want.visible, `${key}.visibleStatuses`);
    assert.deepEqual(def.transitionTargets, want.targets, `${key}.transitionTargets`);
    assert.equal(def.label, want.label, `${key}.label`);
  }
});

test('every status belongs to exactly one stage — no overlap, no orphan', () => {
  /*
   * Overlap would make stageVisible ambiguous and let a user reach a status
   * through a stage they were not granted. This is the invariant that makes
   * "which stage owns this job?" a well-formed question.
   */
  const owner = new Map();
  for (const [key, def] of Object.entries(S.STAGES)) {
    for (const code of def.visibleStatuses) {
      assert.equal(owner.has(code), false, `status ${code} claimed by both ${owner.get(code)} and ${key}`);
      owner.set(code, key);
    }
  }
});

test('every transition target is a status some stage can actually show', () => {
  // A target nobody owns is a one-way door: the job moves somewhere no user can
  // see it again.
  const owned = new Set(Object.values(S.STAGES).flatMap((d) => d.visibleStatuses));
  for (const [key, def] of Object.entries(S.STAGES)) {
    for (const t of def.transitionTargets) {
      assert.ok(owned.has(t), `${key} can move a job to status ${t}, which no stage displays`);
    }
  }
});

test('STAGE_KEYS and STAGE_OPTIONS stay in step with STAGES', () => {
  assert.deepEqual(S.STAGE_KEYS, Object.keys(S.STAGES));
  assert.deepEqual(
    S.STAGE_OPTIONS,
    S.STAGE_KEYS.map((k) => ({ value: k, label: S.STAGES[k].label })),
  );
});

// ─── stageVisibleStatuses ─────────────────────────────────────────────────

test('stageVisibleStatuses unions the given stages', () => {
  assert.deepEqual([...S.stageVisibleStatuses(['pending-close'])].sort((a, b) => a - b), [2, 20]);
  assert.deepEqual(
    [...S.stageVisibleStatuses(['unconfirmed', 'pending-scheduling'])].sort((a, b) => a - b),
    [0, 9],
  );
  assert.equal(S.stageVisibleStatuses([]).size, 0);
});

test('stageVisibleStatuses ignores unknown keys instead of throwing', () => {
  // Stale grants survive a stage rename; a throw here would blank the whole UI.
  assert.deepEqual([...S.stageVisibleStatuses(['nonsense', 'cancelled'])], [6]);
  assert.equal(S.stageVisibleStatuses(['nope']).size, 0);
});

// ─── stageVisible ─────────────────────────────────────────────────────────

test('stageVisible is unrestricted for mode "all" and for a missing grant', () => {
  for (const grant of [ALL, undefined, null]) {
    for (const status of [0, 1, 2, 3, 5, 6, 9, 10, 15, 20, 21, 999]) {
      assert.equal(S.stageVisible(grant, status), true, `${JSON.stringify(grant)} / ${status}`);
    }
  }
});

test('stageVisible restricts to the granted stages', () => {
  const g = only('pending-scheduling', 'pending-start');
  assert.equal(S.stageVisible(g, 0), true);
  assert.equal(S.stageVisible(g, 1), true);
  assert.equal(S.stageVisible(g, 2), false);
  assert.equal(S.stageVisible(g, 9), false);
});

test('an EMPTY list grant is no-access, NOT unrestricted', () => {
  // The distinction this whole module hinges on.
  for (const status of [0, 1, 2, 3, 5, 6, 9, 10, 15, 20, 21]) {
    assert.equal(S.stageVisible(NONE, status), false, `status ${status} must be hidden`);
  }
  assert.notEqual(S.stageVisible(NONE, 0), S.stageVisible(ALL, 0));
});

// ─── transitionAllowed ────────────────────────────────────────────────────

test('transitionAllowed is unrestricted for mode "all" and for a missing grant', () => {
  for (const grant of [ALL, undefined, null]) {
    assert.equal(S.transitionAllowed(grant, 0, 1), true);
    assert.equal(S.transitionAllowed(grant, 999, -1), true, 'nonsense too — the server is the authority');
  }
});

test('transitionAllowed needs ONE stage to own the source and permit the target', () => {
  const g = only('pending-scheduling');           // owns [0], permits [1,6,9]
  assert.equal(S.transitionAllowed(g, 0, 1), true);
  assert.equal(S.transitionAllowed(g, 0, 6), true);
  assert.equal(S.transitionAllowed(g, 0, 9), true);
  assert.equal(S.transitionAllowed(g, 0, 2), false, 'target not permitted by the owning stage');
  assert.equal(S.transitionAllowed(g, 1, 6), false, 'source not owned by any granted stage');
});

test('transitionAllowed will not COMPOSE a move across two granted stages', () => {
  /*
   * THE SOURCE-ANCHORED RULE. This grant owns status 0 (via pending-scheduling)
   * and separately permits target 3 (via pending-close). Neither stage allows
   * 0 → 3, so the composite must be refused. A naive implementation that
   * checked "is the source visible?" and "is the target reachable?" as two
   * independent questions would wave this through.
   */
  const g = only('pending-scheduling', 'pending-close');
  assert.equal(S.stageVisible(g, 0), true, 'source is visible…');
  assert.ok(S.STAGES['pending-close'].transitionTargets.includes(3), '…and 3 is reachable from the other stage');
  assert.equal(S.transitionAllowed(g, 0, 3), false, 'but 0 → 3 must still be refused');
});

test('an empty list grant permits no transition at all', () => {
  assert.equal(S.transitionAllowed(NONE, 0, 1), false);
  assert.equal(S.transitionAllowed(NONE, 2, 3), false);
});

test('a terminal stage grants no outward transition', () => {
  for (const key of ['cancelled', 'pending-feedback']) {
    const g = only(key);
    for (const target of [0, 1, 2, 3, 5, 6, 9, 10, 20, 21]) {
      const source = S.STAGES[key].visibleStatuses[0];
      assert.equal(S.transitionAllowed(g, source, target), false, `${key}: ${source} → ${target}`);
    }
  }
});

// ─── filterTabsForStages ──────────────────────────────────────────────────

const TABS = [
  { id: 'unconfirmed', status: 9 },
  { id: 'pending-sched', status: 0 },
  { id: 'pending-start', status: 1 },
  { id: 'pending-close', statuses: [2, 20] },
  { id: 'all' },                                   // aggregate — carries no status
];

test('filterTabsForStages returns every tab, unchanged, when unrestricted', () => {
  for (const grant of [ALL, undefined, null]) {
    assert.equal(S.filterTabsForStages(TABS, grant), TABS, 'same array reference — no needless re-render');
  }
});

test('filterTabsForStages keeps a tab whose status intersects the grant', () => {
  const kept = S.filterTabsForStages(TABS, only('pending-scheduling', 'pending-close')).map((t) => t.id);
  assert.deepEqual(kept, ['pending-sched', 'pending-close']);
});

test('a multi-status tab survives on a PARTIAL intersection', () => {
  // 'pending-close' covers [2,20]; a grant reaching only status 2 still needs
  // the tab, or the rows it can legitimately see become unreachable.
  const kept = S.filterTabsForStages([{ id: 'pc', statuses: [2, 20] }], only('pending-close')).map((t) => t.id);
  assert.deepEqual(kept, ['pc']);
});

test('aggregate tabs are dropped for a restricted user', () => {
  // A cross-stage view implies visibility the user does not have.
  const kept = S.filterTabsForStages(TABS, only('pending-scheduling')).map((t) => t.id);
  assert.equal(kept.includes('all'), false);
});

test('an empty list grant leaves no tabs at all', () => {
  assert.deepEqual(S.filterTabsForStages(TABS, NONE), []);
});

test('filterTabsForStages distinguishes status 0 from a missing status', () => {
  /*
   * `t.status !== undefined` matters: status 0 is a REAL code (Booked), and a
   * truthiness check would treat it as an aggregate tab and hide the entire
   * Pending-for-Scheduling queue from every restricted user.
   */
  const kept = S.filterTabsForStages([{ id: 'zero', status: 0 }], only('pending-scheduling'));
  assert.deepEqual(kept.map((t) => t.id), ['zero']);
});
