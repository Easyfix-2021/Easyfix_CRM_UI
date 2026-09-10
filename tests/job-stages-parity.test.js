/*
 * BE ↔ FE JOB-STAGE PARITY — behavioural, not transcribed.
 *
 * THE BUG THIS EXISTS TO CATCH, stated as it actually happened: the backend's
 * transitionAllowed carried
 *
 *     if (targetStage && targetStage === sourceStage) return true;
 *
 * and this repo's copy did not. Over the full population of
 * (grant, source, target) triples the two disagreed on 6,656 of 147,600 —
 * always in the same direction, BE=true / FE=false, i.e. the CLIENT HIDING A
 * CONTROL THE SERVER WOULD HAVE ALLOWED. Nothing failed. No test noticed. The
 * live case was Reassign: PATCH /admin/jobs/:id/assign is guarded with target
 * SCHEDULED(1) on a job that stays at 1, so a `pending-start` holder needs
 * (1 → 1), which pending-start's targets [2,20,21,6] does not list.
 *
 * WHY THE EXISTING TEST DID NOT CATCH IT, which is the whole point of this
 * file. tests/job-stages.test.js pins a HAND-TRANSCRIBED `EXPECTED` literal —
 * its own header admits the numbers "were READ OUT OF the backend module", at
 * authoring time. It therefore pins what someone once typed, never what the
 * backend does now. A literal transcribed from a source cannot detect that
 * source changing; it can only detect THIS repo changing. That asymmetry is
 * exactly how a one-directional divergence survives.
 *
 * So this file imports BOTH implementations and runs them against each other.
 *
 * WHY THIS TEST LIVES IN THE CRM AND NOT IN THE BACKEND. The comparison needs
 * both modules loadable in one process. The backend's lib/job-stages.js is
 * plain CommonJS, so this repo can require() it directly. The reverse is not
 * true: src/lib/job-stages.ts is TypeScript, the backend has no typescript
 * dependency (`require('typescript')` there is MODULE_NOT_FOUND), and the
 * backend's own cross-repo test says as much — "the FE is a separate repo
 * written in TypeScript, so there is nothing this process can require()".
 * Here, `npm run test:build` has already emitted .test-build/job-stages.js
 * before node --test runs, so both halves are real modules and neither side is
 * parsed from source or re-typed by hand.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FE = require('../.test-build/job-stages');

/*
 * Locate EasyFix_Backend. Same two layouts every cross-repo test here uses:
 * EASYFIX_BACKEND_DIR in CI (the workflow shallow-clones the backend into
 * RUNNER_TEMP and points this at it), siblings on a developer machine.
 */
function backendModulePath() {
  const root = process.env.EASYFIX_BACKEND_DIR
    || path.resolve(__dirname, '../../EasyFix_Backend');
  const file = path.join(root, 'lib', 'job-stages.js');
  return fs.existsSync(file) ? file : null;
}

/*
 * The status population. DERIVED from the two stage tables rather than typed
 * out, so a status added to either side is compared automatically — a
 * hardcoded list here would reintroduce the very defect this file exists to
 * catch, one level up.
 *
 * 7 (ENQUIRY) is added explicitly because it belongs to NO stage on either
 * side, which makes it the most interesting input in the set: it is the case
 * where "no stage owns the source" has to behave identically.
 */
function statusPopulation(be) {
  const codes = new Set([7]);
  for (const key of Object.keys(be.STAGES)) {
    for (const s of be.STAGES[key].visible || []) codes.add(s);
    for (const t of be.STAGES[key].targets || []) codes.add(t);
  }
  for (const key of FE.STAGE_KEYS) {
    for (const s of FE.STAGES[key].visibleStatuses) codes.add(s);
    for (const t of FE.STAGES[key].transitionTargets) codes.add(t);
  }
  return [...codes].sort((a, b) => a - b);
}

/*
 * Every grant: 'all', plus all 2^n subsets of the stage keys — INCLUDING the
 * empty one, which is the no-access grant and a genuinely different branch on
 * both sides. n is 10 today, so this is 1025 grants; the exponential is
 * deliberate and cheap, and it is what makes "they agree" a statement about
 * the whole space rather than about the cases someone thought of.
 */
function grantPopulation(keys) {
  const grants = [{ mode: 'all' }];
  for (let mask = 0; mask < (1 << keys.length); mask += 1) {
    grants.push({ mode: 'list', stages: keys.filter((_, i) => mask & (1 << i)) });
  }
  return grants;
}

test('the two stage TABLES are numerically identical', (t) => {
  const modPath = backendModulePath();
  if (!modPath) {
    // FAIL, NEVER SKIP — not conditional on CI. A stage-table divergence that
    // this file cannot see is exactly the defect it was written for.
    assert.fail('EasyFix_Backend was not found, so BE/FE stage parity was NOT verified.'
      + '\n  FIX IT ONE OF TWO WAYS:'
      + '\n    git clone --depth 1 https://github.com/Easyfix-2021/Easyfix_Backend.git ../EasyFix_Backend'
      + '\n    …or point EASYFIX_BACKEND_DIR at an existing checkout.'
      + '\n  Both repos are public, so the clone needs no token — CI does exactly this.');
    return;
  }
  const BE = require(modPath);

  assert.deepEqual(
    Object.keys(BE.STAGES), [...FE.STAGE_KEYS],
    'the stage KEYS and their order must match — the order is the picker order',
  );

  for (const key of FE.STAGE_KEYS) {
    assert.deepEqual(
      BE.STAGES[key].visible, FE.STAGES[key].visibleStatuses,
      `${key}: visible statuses differ (BE .visible vs FE .visibleStatuses)`,
    );
    assert.deepEqual(
      BE.STAGES[key].targets || [], FE.STAGES[key].transitionTargets,
      `${key}: transition targets differ (BE .targets vs FE .transitionTargets)`,
    );
  }
});

test('transitionAllowed agrees on EVERY (grant, source, target) triple', (t) => {
  const modPath = backendModulePath();
  if (!modPath) {
    // FAIL, NEVER SKIP — not conditional on CI. A stage-table divergence that
    // this file cannot see is exactly the defect it was written for.
    assert.fail('EasyFix_Backend was not found, so BE/FE stage parity was NOT verified.'
      + '\n  FIX IT ONE OF TWO WAYS:'
      + '\n    git clone --depth 1 https://github.com/Easyfix-2021/Easyfix_Backend.git ../EasyFix_Backend'
      + '\n    …or point EASYFIX_BACKEND_DIR at an existing checkout.'
      + '\n  Both repos are public, so the clone needs no token — CI does exactly this.');
    return;
  }
  const BE = require(modPath);

  const statuses = statusPopulation(BE);
  const grants = grantPopulation([...FE.STAGE_KEYS]);

  /*
   * POSITIVE CONTROL. Every assertion below is "these two agree", and two
   * functions that both threw, or both returned undefined for everything,
   * would agree perfectly. So first prove the pair can DISAGREE at all, by
   * running the same comparison against a deliberately broken FE predicate —
   * the exact defect this file was written for, the same-stage branch removed.
   * If that does not produce a disagreement, the harness is not comparing
   * anything and the green result below means nothing.
   */
  const broken = (allowed, source, target) => {
    if (!allowed || allowed.mode === 'all') return true;
    for (const k of allowed.stages || []) {
      const def = FE.STAGES[k];
      if (!def) continue;
      if (def.visibleStatuses.includes(source) && def.transitionTargets.includes(target)) return true;
    }
    return false;
  };
  let controlDiffs = 0;
  for (const g of grants) {
    for (const s of statuses) {
      for (const tg of statuses) {
        if (BE.transitionAllowed(g, s, tg) !== broken(g, s, tg)) controlDiffs += 1;
      }
    }
  }
  assert.ok(
    controlDiffs > 0,
    'positive control: the comparison found NO disagreement even against a predicate '
    + 'with the same-stage branch removed, so it cannot detect a real divergence either',
  );

  const disagreements = [];
  let compared = 0;
  for (const g of grants) {
    for (const s of statuses) {
      for (const tg of statuses) {
        compared += 1;
        const be = BE.transitionAllowed(g, s, tg);
        const fe = FE.transitionAllowed(g, s, tg);
        if (be !== fe && disagreements.length < 12) {
          disagreements.push(`grant=${g.mode === 'all' ? 'all' : `[${g.stages.join(',')}]`} `
            + `${s} → ${tg}: BE=${be} FE=${fe}`);
        }
      }
    }
  }

  // Report the DENOMINATOR beside the claim: "0 disagreements" is only
  // meaningful next to how many comparisons were actually made.
  assert.ok(compared > 100000, `expected the full triple space; compared only ${compared}`);
  assert.deepEqual(
    disagreements, [],
    `the two transitionAllowed implementations disagree (${compared} triples compared). `
    + 'A disagreement in the BE=true/FE=false direction means the CRM is HIDING a control '
    + 'the server allows; the reverse means the CRM offers one the server will 403.',
  );
});

test('stageVisible agrees on every (grant, status) pair', (t) => {
  const modPath = backendModulePath();
  if (!modPath) {
    // FAIL, NEVER SKIP — not conditional on CI. A stage-table divergence that
    // this file cannot see is exactly the defect it was written for.
    assert.fail('EasyFix_Backend was not found, so BE/FE stage parity was NOT verified.'
      + '\n  FIX IT ONE OF TWO WAYS:'
      + '\n    git clone --depth 1 https://github.com/Easyfix-2021/Easyfix_Backend.git ../EasyFix_Backend'
      + '\n    …or point EASYFIX_BACKEND_DIR at an existing checkout.'
      + '\n  Both repos are public, so the clone needs no token — CI does exactly this.');
    return;
  }
  const BE = require(modPath);
  if (typeof FE.stageVisible !== 'function' || typeof BE.stageVisible !== 'function') {
    assert.fail('stageVisible is missing on one side — the pair this test compares no longer exists');
  }

  const statuses = statusPopulation(BE);
  const grants = grantPopulation([...FE.STAGE_KEYS]);
  const bad = [];
  let compared = 0;
  for (const g of grants) {
    for (const s of statuses) {
      compared += 1;
      if (BE.stageVisible(g, s) !== FE.stageVisible(g, s) && bad.length < 12) {
        bad.push(`grant=${g.mode === 'all' ? 'all' : `[${g.stages.join(',')}]`} status=${s}`);
      }
    }
  }
  assert.ok(compared > 10000, `expected the full pair space; compared only ${compared}`);
  assert.deepEqual(bad, [], `stageVisible disagrees (${compared} pairs compared)`);
});
