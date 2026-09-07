'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * My Orders — the ops Check-In action, and the Audit entry point.
 *
 * WHAT WENT WRONG (2026-09-08)
 *
 * 1. Pending to Start's PlayCircle "Check-In" opened ?action=checkin, which
 *    JobModal folds into the read-only view workspace — and NOTHING inside that
 *    workspace performed a check-in. The button had been removed on 2026-07-28
 *    ("check-in is done by the technician from the app"), a decision the owner
 *    has since overridden. Meanwhile the one-click check-in that did work went
 *    through PATCH /admin/jobs/:id/status, which writes job_status and none of
 *    the check-in columns — checkin_date_time, the TAT anchor, stayed null.
 *
 * 2. Closing that modal never refreshed the three appointment buckets, because
 *    PendingToStartView's refetch set listed reassign / assign / view and not
 *    the one action that actually moves a row OUT of Pending to Start.
 *
 * 3. Audit & Complete (statuses 3 / 5) fell through to the generic table and
 *    offered a lone Eye — no way into the audit actions, which live on the
 *    JobModal workspace's Billing & Charges tab.
 *
 * Registering a JobModal action costs FIVE hand-synced edits across four files
 * (the JobAction union, KNOWN_ACTIONS, JOBMODAL_ACTIONS, JobModalMode +
 * effectiveMode fold + guardedClose's read-only skip, and the page's `modal`
 * memo). Every one of them is silent when missed — the action degrades to an
 * empty modal rather than erroring — so each is pinned below.
 *
 * Source-level, because tests/ here is node:test over pure logic with no DOM.
 */

const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/*
 * Comments are stripped before every structural scan. A guard in this repo has
 * already failed because its own explanatory docblock mentioned the identifier
 * it asserted the ABSENCE of — the prose read as the thing.
 */
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const modalSrc = read('components', 'job', 'JobModal.tsx');
const pendingSrc = read('components', 'job', 'PendingToStartView.tsx');
const urlSrc = read('lib', 'job-action-url.ts');
const hostSrc = read('components', 'job', 'JobModalHost.tsx');
const pageSrc = read('app', '(authed)', 'my-orders', 'page.tsx');

const modal = strip(modalSrc);
const pending = strip(pendingSrc);
const url = strip(urlSrc);
const host = strip(hostSrc);
const page = strip(pageSrc);

// ── A. The ops Check-In action ──────────────────────────────────────

/*
 * The gate on the button. Written as ONE regex over the whole conjunction
 * rather than three independent substring checks: the failure being guarded
 * against is a button that renders on the wrong status or without a permission,
 * and three separate matches would pass on a file where the three fragments
 * exist in unrelated places.
 */
const CHECKIN_BUTTON =
  /\{canCheckIn\(s\) && can\.isJobStatusChange && transitionAllowed\(me\?\.allowedStages, s, ST\.IN_PROGRESS\) && \(\s*<Button[^>]*onClick=\{\(\) => setCheckinOpen\(true\)\}>Check In<\/Button>/;

test('the job workspace carries a Check In action for a SCHEDULED job', () => {
  assert.match(
    modal,
    /const canCheckIn\s*=\s*\(s: number\) => s === ST\.SCHEDULED;/,
    'check-in must be predicated on job_status 1 (SCHEDULED), like every other lifecycle predicate here',
  );
  assert.match(
    modal,
    CHECKIN_BUTTON,
    'ActionBar must render a Check In button gated on the status predicate AND isJobStatusChange AND the 1 → 2 stage transition',
  );
});

test('Check In posts to the check-in endpoint, never the status PATCH', () => {
  /*
   * This is the whole point of the change. PATCH /admin/jobs/:id/status writes
   * job_status alone; the check-in columns (checkin_date_time — the TAT anchor)
   * are written only by the dedicated endpoint. A "fix" that reused doStatus()
   * would look identical in the UI and leave the anchor null.
   */
  const dialog = modal.match(/function CheckInWithReasonDialog\([\s\S]*?\n\}\n/);
  assert.ok(dialog, 'CheckInWithReasonDialog must exist');
  assert.match(
    dialog[0],
    /api\.post\(`\/admin\/jobs\/\$\{jobId\}\/checkin`, \{ reason: trimmed \}\)/,
    'it must POST /admin/jobs/:id/checkin with the reason',
  );
  assert.ok(
    !/\/status`/.test(dialog[0]),
    'it must not fall back to the status PATCH, which writes no check-in columns',
  );
});

test('the reason is mandatory and capped at the wire limit', () => {
  const dialog = modal.match(/function CheckInWithReasonDialog\([\s\S]*?\n\}\n/)[0];
  assert.match(dialog, /maxLength=\{500\}/, 'the textarea must cap at the backend max');
  assert.match(
    dialog,
    /disabled=\{loading \|\| !trimmed\}/,
    'submit must be disabled until a non-blank reason is typed',
  );
  assert.match(
    dialog,
    /if \(!trimmed\) \{ setErr\('A reason is required\.'\); return; \}/,
    'and the handler must refuse a blank reason even if the disabled state is bypassed',
  );
});

test('the check-in dialog uses the shared dirty guard, not an inline onOpenChange', () => {
  const dialog = modal.match(/function CheckInWithReasonDialog\([\s\S]*?\n\}\n/)[0];
  assert.match(dialog, /useFormDirtyGuard\(onClose, \{/, 'house rule: Esc / X / overlay close routes through useFormDirtyGuard');
  assert.match(dialog, /<Dialog open=\{open\} onOpenChange=\{guardedOpenChange\}>/);
  assert.ok(
    !/onOpenChange=\{\(o\) =>/.test(dialog),
    'no inline onOpenChange arrow — that is the pattern the guard replaces',
  );
});

test('the retired "ops never check in" comment no longer contradicts the code', () => {
  /*
   * Scanned against the RAW source on purpose — the claim being retired IS a
   * comment, so the stripped copy cannot see it.
   *
   * Matched on the tail of the sentence ("not by ops on the web") rather than
   * on "Start button removed": the replacement comment quotes the old decision
   * by name while recording that it was overridden, so a check keyed on the
   * name would fail against the very edit that fixed it.
   */
  assert.ok(
    !modalSrc.includes('not by ops on the web'),
    'JobModal must not still assert that ops cannot check in on the web',
  );
  assert.ok(
    !modalSrc.includes('canStart removed'),
    'the canStart tombstone must be replaced by the live canCheckIn predicate',
  );
});

// ── B. Pending to Start refetches when the check-in workspace closes ──

test("'checkin' is in the set of actions whose close refetches the buckets", () => {
  const guard = pending.match(/prevAction\.current === 'reassign'[\s\S]{0,260}?\) &&/);
  assert.ok(guard, 'the prevAction comparison must be found');
  for (const action of ['reassign', 'assign', 'checkin', 'view']) {
    assert.ok(
      guard[0].includes(`prevAction.current === '${action}'`),
      `'${action}' must be in the refetch set — its close can move a row out of this bucket`,
    );
  }
});

test('the PlayCircle row action still opens the check-in workspace', () => {
  assert.match(
    pending,
    /onClick=\{\(\) => onCheckin\(j\.job_id\)\}/,
    'the Check-In icon must survive — it is the only entry to the ops check-in',
  );
  assert.match(pending, /canJob\.isJobStatusChange && \(/, 'and stay permission-gated');
  assert.match(page, /function openCheckin\(id: number\)\s*\{ openJobAction\('checkin',\s*id\); \}/);
});

// ── C. The four+one registration points for the `audit` action ───────

test('point 1 — job-action-url registers audit in BOTH the union and the set', () => {
  const union = url.match(/export type JobAction = [^;]+;/);
  assert.ok(union, 'the JobAction union must be found');
  assert.match(union[0], /'audit'/, "the union must carry 'audit'");

  const known = url.match(/const KNOWN_ACTIONS: ReadonlySet<JobAction> = new Set<JobAction>\(\[[\s\S]*?\]\);/);
  assert.ok(known, 'KNOWN_ACTIONS must be found');
  assert.match(known[0], /'audit'/, "KNOWN_ACTIONS must carry 'audit' — the union alone does not parse the URL");
});

test('point 2 — JobModalHost routes audit to JobModal', () => {
  const set = host.match(/const JOBMODAL_ACTIONS = new Set<JobAction>\(\[[^\]]*\]\)/);
  assert.ok(set, 'JOBMODAL_ACTIONS must be found');
  assert.match(set[0], /'audit'/);
  assert.match(set[0], /'checkin'/, 'and must not have lost checkin while audit was added');
});

test('point 3 — the page memo passes audit through instead of excluding it', () => {
  const memo = page.match(/const modal = useMemo<\{ open: boolean; mode: JobModalMode; id\?: number \}>\(\(\) => \{[\s\S]*?\}, \[urlAction, urlJobId\]\);/);
  assert.ok(memo, "the my-orders `modal` memo must be found");
  const earlyReturn = memo[0].match(/if \(!urlAction \|\|[^)]*\) \{/);
  assert.ok(earlyReturn, 'the exclusion list must be found');
  assert.ok(
    !earlyReturn[0].includes("'audit'"),
    'audit must NOT be excluded — exclusion is what routes an action away from JobModal',
  );
  assert.ok(
    !earlyReturn[0].includes("'checkin'"),
    'checkin must stay unexcluded too',
  );
});

test('point 4 — JobModal folds audit into the view workspace and titles it', () => {
  const modeUnion = modal.match(/export type JobModalMode = [^;]+;/);
  assert.ok(modeUnion, 'JobModalMode must be found');
  assert.match(modeUnion[0], /'audit'/, "JobModalMode must carry 'audit' or the page memo's cast lands on an unhandled mode");

  assert.match(
    modal,
    /const effectiveMode = \(mode === 'checkin' \|\| mode === 'audit'\) \? 'view'/,
    'audit must fold to view exactly as checkin does — that is what renders the workspace',
  );
  assert.match(
    modal,
    /mode === 'audit'\s*\? `Audit · Job #\$\{jobId\}`/,
    'and the title must name the entry point',
  );
});

test('point 5 — audit skips the discard prompt, like every other read-only fold', () => {
  /*
   * The fifth point, and the one the brief did not name. guardedClose short-
   * circuits for pure-read modes; a mode that folds to view but is missing here
   * fires a phantom "Discard Unsaved Changes?" on close, from child components
   * that commit an initial value on mount.
   */
  assert.match(
    modal,
    /if \(mode === 'view' \|\| mode === 'checkin' \|\| mode === 'audit'\) \{/,
    'every mode folding to view must be listed in guardedClose',
  );
});

// ── D. The Audit entry point on the Audit & Complete rows ────────────

test('the audit entry point opens the workspace on Billing & Charges', () => {
  assert.match(
    page,
    /function openAudit\(id: number\)\s*\{ openJobAction\('audit',\s*id, \{ tab: 'billing' \}\); \}/,
    "openAudit must deep-link the billing tab through the existing { tab } sub-state",
  );
  // The nav helper is what turns { tab } into the ?viewTab= key the modal reads.
  assert.match(
    strip(urlSrc),
    /extras: opts\?\.tab \? \{ viewTab: opts\.tab \} : undefined/,
    'the { tab } sub-state must still be written as viewTab',
  );
});

test('the audit row action is gated on the status AND on canManageJobCharges', () => {
  // Anchored on the closing </button> — a lazy window would stop at the first
  // `)}` inside the JSX (the onClick arrow) and never reach the icon.
  const button = page.match(/\{\(j\.job_status === 3 \|\| j\.job_status === 5\) && canAudit && \([\s\S]{0,900}?<\/button>/);
  assert.ok(button, 'the audit row action must be gated on statuses 3 / 5 and canAudit');
  assert.match(button[0], /onClick=\{\(\) => openAudit\(j\.job_id\)\}/);
  assert.match(button[0], /<ClipboardCheck /, 'it must be its own icon, distinguishable from the Eye');

  /*
   * canManageJobCharges is a STANDALONE boolean on /auth/me, not an actionFlags
   * key. Reading it through actionFlags would silently return undefined and
   * fail closed forever, which looks exactly like "the owner has no access".
   */
  assert.match(
    page,
    /const canAudit = me\?\.canManageJobCharges === true;/,
    'canAudit must read the standalone flag directly, fail-closed',
  );
  assert.ok(
    !/actionFlags\([^)]*canManageJobCharges/.test(page),
    'canManageJobCharges must never be requested through actionFlags',
  );
});

test('the Billing & Charges tab is still gated by the same flag it is entered on', () => {
  /*
   * The entry point hides itself when the tab would be absent. That contract
   * breaks silently if the tab's own gate ever moves to a different flag — the
   * icon would then appear for people with no billing tab, opening a duplicate
   * of the Eye beside it.
   */
  assert.match(modal, /const canManageJobCharges = me\?\.canManageJobCharges === true;/);
  assert.match(modal, /\{canManageJobCharges && <TabsTrigger value="billing">/);
  assert.match(
    modal,
    /\.\.\.\(canManageJobCharges \? \['billing'\] : \[\]\)/,
    'and a ?viewTab=billing deep link must still fall back to Summary without the flag',
  );
});

// ── E. Controls ─────────────────────────────────────────────────────

test('positive control — the comment stripper actually removes prose', () => {
  /*
   * Every scan above runs against a stripped copy, and a stripper that silently
   * stopped working would start matching the explanations instead of the code.
   * Proven on a synthetic sample so the control cannot be satisfied by whatever
   * these files happen to contain today.
   */
  const sample = [
    "/* mode === 'audit' and canCheckIn(s), described in prose */",
    'const kept = 1;',
    "// setCheckinOpen(true)",
  ].join('\n');
  const stripped = strip(sample);
  assert.ok(!stripped.includes('audit'), 'block comments must go');
  assert.ok(!stripped.includes('setCheckinOpen'), 'line comments must go');
  assert.ok(stripped.includes('const kept = 1;'), 'and the code must survive');

  for (const [name, raw, code] of [
    ['JobModal', modalSrc, modal],
    ['PendingToStartView', pendingSrc, pending],
    ['my-orders/page', pageSrc, page],
  ]) {
    assert.ok(code.length < raw.length, `${name} must contain comments the scans excluded`);
  }
});

test('differential control — each guard fails on a source with its subject deleted', () => {
  /*
   * The assertions above are only worth their runtime if they would go RED when
   * the thing they describe is removed. Proving a regex matches today does not
   * prove it discriminates: a pattern loose enough to match some neighbouring
   * code stays green through the exact regression it was written for. So each
   * subject is deleted from a copy of the real source and the same pattern is
   * re-run — every one must now miss.
   */
  const cases = [
    [
      'the Check In button',
      modal.replace(CHECKIN_BUTTON, ''),
      CHECKIN_BUTTON,
      modal,
    ],
    [
      'the audit fold in effectiveMode',
      modal.replace(/\(mode === 'checkin' \|\| mode === 'audit'\)/, "mode === 'checkin'"),
      /const effectiveMode = \(mode === 'checkin' \|\| mode === 'audit'\) \? 'view'/,
      modal,
    ],
    [
      "'audit' in KNOWN_ACTIONS",
      url.replace(/'checkin', 'audit',/, "'checkin',"),
      /const KNOWN_ACTIONS: ReadonlySet<JobAction> = new Set<JobAction>\(\[[\s\S]*?'audit'[\s\S]*?\]\);/,
      url,
    ],
    [
      "'audit' in JOBMODAL_ACTIONS",
      host.replace(/'checkin', 'audit',/, "'checkin',"),
      /const JOBMODAL_ACTIONS = new Set<JobAction>\(\[[^\]]*'audit'[^\]]*\]\)/,
      host,
    ],
    [
      'the audit row action',
      page.replace(/\(j\.job_status === 3 \|\| j\.job_status === 5\) && canAudit/, 'false'),
      /\(j\.job_status === 3 \|\| j\.job_status === 5\) && canAudit/,
      page,
    ],
  ];

  for (const [what, mutated, pattern, original] of cases) {
    /*
     * The mutation must have LANDED. A `.replace()` whose pattern no longer
     * matches returns the input unchanged, and every assertion below would then
     * be run against pristine source — a differential that silently tests
     * nothing, which is the failure mode it exists to prevent elsewhere.
     */
    assert.notEqual(mutated, original, `the mutation for ${what} did not change the source`);
    assert.ok(
      pattern.test(original),
      `${what} must match the real source before the differential means anything`,
    );
    assert.ok(
      !pattern.test(mutated),
      `deleting ${what} must break its guard — the pattern is too loose to discriminate`,
    );
  }

  /*
   * The refetch set is checked by membership rather than by one regex, so its
   * differential is a membership test on a mutated copy.
   */
  const withoutCheckin = pending.replace("|| prevAction.current === 'checkin'", '');
  const guard = withoutCheckin.match(/prevAction\.current === 'reassign'[\s\S]{0,260}?\) &&/);
  assert.ok(guard, 'the mutated guard must still parse');
  assert.ok(
    !guard[0].includes("prevAction.current === 'checkin'"),
    "dropping 'checkin' from the refetch set must be visible to the membership check",
  );
});
