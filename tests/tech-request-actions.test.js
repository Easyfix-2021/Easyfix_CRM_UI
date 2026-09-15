'use strict';
/*
 * Technician Requests — the Approve / Reject row actions, and the Cancel Job
 * button ops asked for inside the Reassign modal (owner, 2026-09-15).
 *
 * WHAT THE OWNER ASKED FOR, verbatim in four clauses:
 *   · "Reassign and View Job Action buttons will always be there."
 *   · "Location and Reset Pin actions will not be there in this section."
 *   · cancellation → Approve fires the cancel API, Reject "will just clear the flag".
 *   · reschedule   → Approve fires the reschedule API, Reject clears the flag.
 *   · "there should be a 'Cancel' (Red) button in Reassign Technician modal."
 *
 * Source-scanned, like pending-to-start-sections.test.js and
 * resend-pin-action.test.js: every rule below lives in a .tsx that test:build
 * does not compile, and every regression is a plain deletion that type-checks.
 * The parts that ARE compilable (the appRequestOf predicate these rows come
 * from) are behaviour-tested in tests/job-app-request.test.js; the two new
 * status-change call sites are pinned by tests/job-status-actions.test.js,
 * whose coverage assertion fails if either one is added without being described.
 *
 * Comments are stripped before every scan and a control proves the stripper
 * bites: this feature is explained at length in prose that NAMES the calls it
 * makes, so a check reading raw source would pass on the documentation alone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const ACTIONS_PATH = 'src/components/job/TechRequestActions.tsx';
const VIEW_PATH = 'src/components/job/PendingToStartView.tsx';
const ASSIGN_PATH = 'src/components/job/AssignTechnicianModal.tsx';
const PAGE_PATH = 'src/app/(authed)/my-orders/page.tsx';

const ACTIONS_RAW = read(ACTIONS_PATH);
const ACTIONS = strip(ACTIONS_RAW);
const VIEW = strip(read(VIEW_PATH));
const ASSIGN = strip(read(ASSIGN_PATH));
const PAGE = strip(read(PAGE_PATH));

test('the stripper bites — prose that NAMES a call cannot satisfy a check for it', () => {
  // The file header explains the reject endpoint in words. If the stripper ever
  // stops working, every "the code does X" assertion below degrades into "the
  // comments mention X", which is the failure mode this control exists for.
  assert.match(ACTIONS_RAW, /app-request\/reject clears the one flag/,
    'positive control: the header must still describe the endpoint in prose');
  assert.doesNotMatch(ACTIONS, /clears the one flag/,
    'the comment stripper is broken — every scan below is now reading documentation');
});

// ─── Which icons survive on a request row ───────────────────────────────

test('Location and Resend PIN are OFF a Technician Requests row', () => {
  // Both are day-to-day chasing tools for a job that is proceeding; a request
  // row is a decision. Each must be fenced behind !appRequests, and the fence
  // has to be on the control itself, not on some enclosing branch.
  assert.match(VIEW, /\{!appRequests && j\.fk_easyfixter_id != null && \(/,
    'the live-location button must be fenced off the requests section');
  assert.match(VIEW, /\{!appRequests && \(\s*<ResendPinButton/,
    'ResendPinButton must be fenced off the requests section');
});

test('View Job and Reassign are NOT fenced — they are on every section', () => {
  // The owner said both "will always be there". Read the action cell and assert
  // neither control acquired an appRequests condition.
  const cellAt = VIEW.indexOf('stick-col stick-right text-right whitespace-nowrap');
  assert.ok(cellAt > -1, 'positive control: the action cell must be locatable');
  const cell = VIEW.slice(cellAt, VIEW.indexOf('</td>', cellAt));

  const viewAt = cell.indexOf('onClick={() => onView(j.job_id)}');
  const reassignAt = cell.indexOf('onClick={() => onReassign(j.job_id)}');
  assert.ok(viewAt > -1, 'View Job must still render on this row');
  assert.ok(reassignAt > -1, 'Reassign must still render on this row');

  // The nearest preceding guard on each: Reassign keeps its permission gate
  // (canJob.isJobReassign) and View keeps none — but neither may be section-gated.
  for (const [name, at] of [['View Job', viewAt], ['Reassign', reassignAt]]) {
    const preceding = cell.slice(Math.max(0, at - 220), at);
    assert.doesNotMatch(preceding, /appRequests/,
      `${name} must not be fenced on the section — the owner said it is always there`);
  }
  assert.match(cell, /\{canJob\.isJobReassign && \(/, 'Reassign keeps its own permission gate');
});

test('the Approve / Reject pair renders from the SAME ask the Request column painted', () => {
  // Re-deriving it would let the buttons act on the reschedule flag while the
  // chip says "Cancellation Requested" (cancel outranks reschedule when a job
  // carries both).
  assert.match(VIEW, /const req = appRequests \? appRequestOf\(j\) : null;/);
  assert.match(VIEW, /\{req && \(\s*<TechRequestActions[\s\S]*?request=\{req\}/);
  assert.equal((VIEW.match(/appRequestOf\(/g) || []).length, 2,
    'appRequestOf is called exactly twice — once to filter/count, once per row; a third '
    + 'call is a second reading of the flags that can disagree with the first');
});

// ─── Approve: the existing endpoints, never a third cancel path ─────────

test('approving a CANCELLATION goes through the shared cancel dialog, not a bespoke PATCH', () => {
  assert.match(ACTIONS, /<CancelWithReasonDialog/);
  assert.match(ACTIONS, /api\.patch\(`\/admin\/jobs\/\$\{jobId\}\/status`, \{ status: ST\.CANCELLED, reasonId, comment \}\)/);
  // Seeded to Technician because that is who asked — but still a radio ops can change.
  assert.match(ACTIONS, /defaultDueTo="Technician"/);
  assert.match(strip(read('src/components/job/CancelWithReasonDialog.tsx')),
    /defaultDueTo = 'Customer'/,
    'every OTHER cancel mount must keep defaulting to Customer');
});

test('approving a RESCHEDULE pre-fills the technician\'s slot and reason', () => {
  assert.match(ACTIONS, /<RescheduleDialog/);
  assert.match(ACTIONS, /initialDateTime=\{toPickerValue\(request\.requestedFor\)\}/);
  assert.match(ACTIONS, /initialRemarks=\{`Technician requested reschedule/);
  // The dialog owns the PATCH /:id/reschedule itself — re-implementing it here
  // would skip its reason + remarks validation.
  assert.doesNotMatch(ACTIONS, /\/reschedule`/,
    'the reschedule write belongs to RescheduleDialog, not to this component');
});

test('the requested slot is string-sliced, never parsed as a date', () => {
  // reschedule_date_time_app is an IST wall-clock VARCHAR. new Date() re-reads
  // it in the browser's zone and can shift the day across the +05:30 boundary —
  // the trap project_easyfix_ist_date_rendering exists for.
  assert.match(ACTIONS, /String\(raw\)\.slice\(0, 16\)\.replace\(' ', 'T'\)/);
  assert.doesNotMatch(ACTIONS, /new Date\(/,
    'never construct a Date from an IST wall-clock literal');
});

// ─── Reject: one flag, one endpoint, one confirmation ───────────────────

test('reject PATCHes the app-request endpoint with the ask\'s own kind', () => {
  assert.match(ACTIONS, /const REJECT_PATH = \(jobId: number\) => `\/admin\/jobs\/\$\{jobId\}\/app-request\/reject`;/);
  assert.match(ACTIONS, /api\.patch\(REJECT_PATH\(jobId\), \{ kind: request\.kind \}\)/,
    'the kind must come from the ask being shown, never be hard-coded');
});

test('reject asks first, through the shared confirm — never a native dialog', () => {
  assert.match(ACTIONS, /const ok = await confirm\(\{/);
  assert.match(ACTIONS, /if \(!ok\) return;/);
  assert.doesNotMatch(ACTIONS, /window\.confirm|(^|[^.\w])confirm\s*\(\s*['"`]/);
  assert.doesNotMatch(ACTIONS, /(^|[^.\w])alert\s*\(/);
});

test('reject surfaces the server\'s own sentence — a 409 is information', () => {
  // The guarded UPDATE answers 409 APP_REQUEST_NOT_PENDING when another
  // operator got there first. Flattening that to "failed" sends ops to a
  // developer for a message the API already wrote.
  assert.match(ACTIONS, /formatApiError\(e, \{ fallback: 'Could not reject the request\.' \}\)/);
  // And the row is repainted either way: on success it left the queue, on 409
  // it was never ours to paint.
  const catchAt = ACTIONS.indexOf('} catch (e) {');
  assert.ok(catchAt > -1);
  assert.match(ACTIONS.slice(catchAt), /onActioned\(\);/);
});

test('every decision triggers the PAGE-wide reload, not the section\'s own refetch', () => {
  // An approved cancellation leaves this tab entirely and every bucket's count
  // moves with it; a section refetch would leave the other three stale.
  assert.match(VIEW, /onRequestActioned: bumpReload,/);
  assert.match(VIEW, /onActioned=\{onRequestActioned\}/);
  assert.match(VIEW, /const bumpReload = \(\) => \{[\s\S]*?invalidateFetch\(\(k\) => k\.startsWith\('\/admin\/jobs'\)\);/);
});

// ─── Permission ─────────────────────────────────────────────────────────

test('the action key is declared once and actually requested by the page', () => {
  assert.match(ACTIONS, /export const APP_REQUEST_ACTION = 'isJobAppRequestResolve';/);
  // Declared in the component and imported by the page, like RESEND_PIN_ACTION:
  // a second string literal is how a rename hides the buttons on one page only.
  assert.match(PAGE, /import \{ APP_REQUEST_ACTION \} from '@\/components\/job\/TechRequestActions';/);
  assert.match(PAGE, /^\s*APP_REQUEST_ACTION,$/m, 'the key must be in actionFlags, or canJob[…] is always false');
  assert.equal((PAGE.match(/isJobAppRequestResolve/g) || []).length, 0,
    'the page must use the exported constant, never a second copy of the literal');
});

test('the pair is hidden outright without the permission', () => {
  assert.match(ACTIONS, /if \(!allowed\) return null;/);
  assert.match(VIEW, /allowed=\{!!canJob\[APP_REQUEST_ACTION\]\}/);
});

test('the backend seeds that exact key', () => {
  // A key the FE gates on but nobody seeds is a permanently invisible button.
  const mig = read('../EasyFix_Backend/migrations/2026-09-15-seed-job-app-request-action.sql');
  assert.match(mig, /'isJobAppRequestResolve'/);
  assert.match(mig, /INSERT INTO menu_action/);
  assert.match(mig, /'Approve \/ Reject Technician Requests'/);
});

// ─── Cancel Job inside the Reassign modal ───────────────────────────────

test('Reassign carries a red Cancel Job button in its footer', () => {
  assert.match(ASSIGN, /\{canCancel && \(\s*<Button\s*variant="destructive"[\s\S]*?Cancel Job\s*<\/Button>/,
    'the owner asked for a RED cancel — variant="destructive" is that red');
});

test('Cancel Job sits before Close in the right cluster, per the footer convention', () => {
  // Add Remarks left; Cancel · lifecycle · Close right (owner, 2026-07-29).
  const footAt = ASSIGN.indexOf('<DialogFooter className="px-6 sm:justify-between">');
  assert.ok(footAt > -1, 'positive control: the footer must be locatable');
  const foot = ASSIGN.slice(footAt, ASSIGN.indexOf('</DialogFooter>', footAt));
  assert.ok(foot.indexOf('Add Remarks') < foot.indexOf('Cancel Job'), 'Add Remarks stays left');
  assert.ok(foot.indexOf('Cancel Job') < foot.indexOf('>Close<'), 'Cancel comes before Close');
});

test('Cancel Job is fenced on a status this modal was meant to be open at', () => {
  // The modal opens from a shareable ?action=reassign URL for ANY jobId, and
  // setStatus would cancel a COMPLETED job without complaint unless its
  // completion is posted. Waiting for the probe means the button cannot paint
  // on an unknown status either.
  assert.match(ASSIGN,
    /const canCancel = hasAction\(me, 'isJobCancel'\)\s*&& probe\?\.job_status != null && !wrongStatusForMode;/);
});

test('Cancel Job refreshes the caller BEFORE closing, and evicts the comment thread', () => {
  const mountAt = ASSIGN.indexOf('<CancelWithReasonDialog');
  assert.ok(mountAt > -1, 'positive control: the cancel mount must be locatable');
  const mount = ASSIGN.slice(mountAt, ASSIGN.indexOf('/>', mountAt));
  const patchAt = mount.indexOf('await api.patch(');
  const evictAt = mount.indexOf('invalidateFetch(');
  const changedAt = mount.indexOf('onChanged?.();');
  const closeAt = mount.indexOf('onClose();');
  assert.ok(patchAt > -1 && evictAt > patchAt, 'evict only once the cancel has committed');
  assert.ok(changedAt > patchAt && closeAt > changedAt,
    'refresh the list before closing, or the cancelled row flashes back');
});

test('both AssignTechnicianModal mounts pass onChanged', () => {
  // Otherwise the cancel commits and the row sits there until a manual refresh.
  // Enumerated, not spot-checked: a third mount added later must fail here.
  const files = ['src/app/(authed)/my-orders/page.tsx', 'src/app/(authed)/jobs/page.tsx'];
  const mounts = files.flatMap((f) => [...strip(read(f)).matchAll(/<AssignTechnicianModal[\s\S]*?\n\s*\/>/g)]
    .map((m) => ({ f, body: m[0] })));
  assert.equal(mounts.length, 2, `expected exactly two mounts, found ${mounts.length}`);
  for (const { f, body } of mounts) {
    assert.match(body, /onChanged=\{/, `${f}: its Reassign modal can now cancel a job — wire onChanged`);
  }
});

// ─── Vocabulary ─────────────────────────────────────────────────────────

test('every user-facing label is Title Case', () => {
  const labels = [
    'Cancel Job', 'Reject Request', 'Request Rejected', 'Job Cancelled',
    'Reject Cancellation Request?', 'Reject Reschedule Request?',
  ];
  for (const label of labels) {
    assert.ok(ACTIONS.includes(label) || ASSIGN.includes(label), `missing label: ${label}`);
    for (const word of label.replace('?', '').split(' ')) {
      assert.match(word, /^[A-Z]/, `"${label}" must be Title Case (check:brand / label-casing rule)`);
    }
  }
});

test('both buttons carry a title AND an aria-label', () => {
  // The neighbouring Reassign icon shipped without an aria-label; an
  // icon-only DESTRUCTIVE control must not repeat that.
  // Whole elements, not `<button…>`: a non-greedy match to the first `>` stops
  // inside `onClick={() =>` and sees no attributes at all.
  const buttons = [...ACTIONS.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
  assert.equal(buttons.length, 2, `expected Approve + Reject, found ${buttons.length}`);
  for (const b of buttons) {
    assert.match(b, /title=\{/, 'each icon button needs a hover title');
    assert.match(b, /aria-label=\{/, 'each icon button needs an accessible name');
  }
});
