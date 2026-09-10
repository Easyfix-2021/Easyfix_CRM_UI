'use strict';
/*
 * Assign / Reassign reads the server's ASSIGNABILITY — never the offer flag.
 *
 * ─── THE TRAP THIS PINS (2026-09-10) ───────────────────────────────────────
 *
 * Schedule & Assign was migrated onto a server-computed `offerable` flag, and
 * the obvious follow-up was "do the same for AssignTechnicianModal". That would
 * have broken REASSIGN outright.
 *
 * /offer and /assign refuse different sets. Offering requires BOOKED;
 * assign() refuses only the closed states (completed / completed-alt /
 * cancelled) and will happily move a SCHEDULED job to another technician. Every
 * reassign operates on a SCHEDULED job, for which `offerable` is FALSE — so
 * reading the offer flag here would have greyed out the commit button on every
 * single reassign while the server was perfectly willing to do it.
 *
 * Hence two predicates on the backend (job.jobOfferability, job.jobAssignability)
 * and two fields on the one /candidates payload.
 *
 * ─── WHAT IS AND IS NOT THE SERVER'S TO ANSWER ─────────────────────────────
 *
 * The modal ALSO narrows to exactly BOOKED (assign) or exactly SCHEDULED
 * (reassign). That is stricter than the server and deliberately so — it is a
 * product decision about which entry point applies, plus deep-link hardening
 * for a shareable ?action=assign URL. It stays local. What it must not do is
 * stand in for the server's own refusal, which is the gap `assignable` fills:
 * before this, a completed job was reported as "isn't in the required status".
 *
 * Source-shape guards, because the suite mounts nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODAL = path.join(ROOT, 'src/components/job/AssignTechnicianModal.tsx');

const read = (p) => fs.readFileSync(p, 'utf8');

test('it reads ASSIGNABILITY, and never the offer flag', () => {
  const src = read(MODAL);
  assert.match(src, /const serverAssignable = topData\?\.assignable \?\? true;/,
    'the server verdict must come from `assignable`');
  assert.doesNotMatch(src, /topData\?\.offerable/,
    'reading `offerable` here refuses every reassign — a SCHEDULED job is assignable but never '
    + 'offerable, which is the whole reason there are two predicates');
});

test('the server refusal and the local mode rule are SEPARATE, and both gate the commit', () => {
  /*
   * Collapsing them either way loses something. Drop `serverAssignable` and a
   * completed job is described as the wrong status. Drop `wrongStatusForMode`
   * and the modal silently widens to every status /assign tolerates —
   * IN_PROGRESS included — which is a product change nobody asked for.
   */
  const src = read(MODAL);
  assert.match(src, /const commitBlocked = wrongStatusForMode \|\| !serverAssignable;/,
    'both must gate the commit');
  assert.match(src, /const allowedStatus = mode === 'reassign' \? 1 : 0;/,
    'the mode rule stays local — it is stricter than the server on purpose');
  assert.match(src, /const canCommit = \(mode === 'reassign'[\s\S]{0,140}\) && !commitBlocked;/,
    'canCommit is the permission AND the combined block');
});

test('FAIL-OPEN on absence, never on presence', () => {
  // A `=== true` shape would grey the button out on the first paint of every
  // open, before the candidates payload lands. A present `false` must still win.
  const src = read(MODAL);
  assert.match(src, /topData\?\.assignable \?\? true/);
  assert.doesNotMatch(src, /topData\?\.assignable === true/,
    'a === true test turns "not loaded yet" into "refused"');
});

test('the banner distinguishes the two refusals', () => {
  /*
   * One sentence used to cover both. "This order isn't in the required status
   * for reassignment" is simply wrong for a cancelled job, and the operator has
   * no way to tell which of the two happened.
   */
  const src = read(MODAL);
  assert.match(src, /assignBlockReason === 'job_closed'/,
    'the closed-job case must render its own copy, off the server reason code');
  assert.match(src, /completed or cancelled/,
    'and say so in words');
  assert.match(src, /isn’t in the required status for/,
    'while the local mode rule keeps its own, still-accurate sentence');
  assert.match(src, /\{commitBlocked && \(/,
    'the banner shows for either refusal');
});

test('the job-detail probe is IDENTITY-GUARDED before anything reads it', () => {
  /*
   * Same defect the sibling modal had. useFetch retains the previous key's
   * payload and this modal never unmounts, so an unguarded read answers about
   * the PREVIOUS job for the whole of the next one's request — and this probe
   * is the full getById, the slowest read on the page.
   */
  const src = read(MODAL);
  const decl = src.match(/const probe = statusGate\.data && Number\(statusGate\.data\.job_id\) === Number\(jobId\)\n\s*\? statusGate\.data\n\s*: null;/);
  assert.ok(decl, 'the probe payload must be checked against the CURRENT jobId');
  assert.doesNotMatch(src.replace(decl[0], ''), /statusGate\.data/,
    'a read of statusGate.data outside the guard — it can answer about the previous job');
});

test('the server verdict is declared AFTER the payload it reads', () => {
  // Plain temporal-dead-zone hygiene: canCommit moved down from the probe block
  // because topData is declared ~70 lines further on.
  const src = read(MODAL);
  const at = (re) => src.search(re);
  const topDataAt = at(/const topData = top\.data &&/);
  const serverAt = at(/const serverAssignable = topData\?\.assignable/);
  const canCommitAt = at(/const canCommit = \(mode === 'reassign'/);
  assert.ok(topDataAt > -1 && serverAt > -1 && canCommitAt > -1, 'all three must exist');
  assert.ok(topDataAt < serverAt, 'topData before serverAssignable reads it');
  assert.ok(serverAt < canCommitAt, 'serverAssignable before canCommit');
});
