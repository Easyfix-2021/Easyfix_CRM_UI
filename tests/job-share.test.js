'use strict';

/*
 * Job delegation ("share") — the invariants that make the CRM half safe.
 *
 * ─── WHAT IS AT STAKE ─────────────────────────────────────────────────────
 *
 * A shared job keeps `fk_easyfixter_id` on the ORIGINAL technician. Every
 * column an operator reads keeps naming him while a different person does the
 * work and he himself is 409'd off every mutating route. Three ways the CRM
 * can go wrong, all of them silent:
 *
 *   1. the chip stops naming the DELEGATE, and the operator is back to a bare
 *      "Shared" that answers none of the questions it is there to answer;
 *   2. the chip renders on a TERMINAL share, so a finished delegation looks
 *      live and an operator releases something that already ended — or, worse,
 *      the LIVE set shrinks and a genuine lock shows no chip at all;
 *   3. the ops release loses its confirmation or its permission gate. That
 *      endpoint yanks a job out from under a technician who may be standing in
 *      the customer's hallway, and after `started` it is the ONLY way out.
 *
 * None of those breaks a type or a lint rule; each is a plain deletion that
 * compiles. That is what this file is for.
 *
 * The status/tone/label decisions live in `src/lib/job-share.ts`, which
 * `npm run test:build` compiles — so those get a real behavioural import
 * rather than a source scan. The component invariants (confirm-before-POST,
 * permission gate, the single declaration of the action key and the route)
 * live in a .tsx and are scanned, the same way resend-pin-action.test.js does.
 *
 * NOTE ON REGEXES: every pattern below is non-global, or used via `.match()`.
 * A /g regex reused with `.test()` carries `lastIndex` between calls and
 * silently returns false on the next file — a scanner that reports CLEAN
 * because it started halfway through the string.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const share = require('../.test-build/job-share.js');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/* Comments in this estate are long and name the very identifiers being
 * asserted ("the chip must name the delegate", "`await confirm`"), so every
 * source assertion runs over a comment-stripped copy. */
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

const COMPONENT = 'src/components/job/JobShareControls.tsx';
const CALL_SITES = [
  'src/app/(authed)/jobs/page.tsx',
  'src/app/(authed)/my-orders/page.tsx',
  'src/components/job/JobModal.tsx',
];

const component = read(COMPONENT);
const componentCode = strip(component);

/* A share row as the contract spells it. Helper so each test states only the
 * field it cares about. */
const mkShare = (over) => Object.assign({
  id: 7,
  jobId: 482453,
  status: 'started',
  sharedByEfrId: 11,
  sharedByName: 'Ravi Kumar',
  delegateEfrId: 22,
  delegateName: 'Imran Shaikh',
  delegateNumber: '9876543210',
  createdOn: '2026-09-10 10:00:00',
  respondedOn: null,
  startedOn: null,
  endedOn: null,
  endReason: null,
  canCancel: false,
}, over);

// ─── 1. the LIVE set is exactly the three states that hold the lock ───────

test('LIVE_SHARE_STATUSES is exactly pending|accepted|started', () => {
  assert.deepEqual(
    [...share.LIVE_SHARE_STATUSES].sort(),
    ['accepted', 'pending', 'started'],
    'the live set drifted. Every state in it holds the lock on the original '
    + 'technician; every state out of it is history. Adding a terminal state '
    + 'makes a finished delegation look live, dropping a live one hides a '
    + 'genuine lock from the operator entirely.',
  );
});

test('every terminal status produces NO chip', () => {
  const terminal = ['rejected', 'cancelled', 'expired', 'completed', 'handed_back', 'released'];
  for (const status of terminal) {
    assert.equal(share.isShareLive(mkShare({ status })), false, status + ' counted as live');
    assert.equal(share.shareChip(mkShare({ status })), null,
      'a chip rendered for terminal status ' + status + ' — the job is back with '
      + 'its owner and behaves normally, so a chip is a false alarm');
  }
});

test('a missing share is not a crash and not a chip', () => {
  for (const v of [null, undefined]) {
    assert.equal(share.isShareLive(v), false);
    assert.equal(share.shareChip(v), null);
  }
});

// ─── 2. the chip names WHO, in every live state ───────────────────────────

test('every live status yields a chip naming the delegate and the state', () => {
  for (const status of share.LIVE_SHARE_STATUSES) {
    const chip = share.shareChip(mkShare({ status }));
    assert.ok(chip, 'no chip for live status ' + status);
    assert.ok(chip.label.includes('Imran Shaikh'),
      status + ' chip does not name the delegate — "' + chip.label + '". A bare '
      + '"Shared" is not actionable for an operator; naming who has the job is '
      + 'the whole point of the chip.');
    assert.ok(chip.label.replace('Imran Shaikh', '').trim().length > 0,
      status + ' chip is the delegate name alone — it must also say the state');
    assert.ok(chip.title.includes('Imran Shaikh') && chip.title.includes('Ravi Kumar'),
      status + ' tooltip does not name both parties');
  }
});

test('the three live states are visually distinguishable, not one label', () => {
  const labels = share.LIVE_SHARE_STATUSES.map((s) => share.shareChip(mkShare({ status: s })).label);
  assert.equal(new Set(labels).size, labels.length,
    'two live states render the identical label — "not accepted yet" and '
    + '"someone is on site working it" are different operational situations');
});

test('labels are Title Case, per the estate label rule', () => {
  for (const s of share.LIVE_SHARE_STATUSES) {
    const label = share.shareChip(mkShare({ status: s })).label;
    // Only the state half; the delegate's own name is whatever the DB holds.
    const state = label.split('·')[0].trim();
    for (const word of state.split(/\s+/)) {
      assert.match(word, /^[A-Z]/, 'lower-case word "' + word + '" in chip label "' + label + '"');
    }
  }
});

test('every tone is a real StatusChip tone — no raw Tailwind, no invented name', () => {
  // Read the tone union straight out of StatusChip so this cannot pass against
  // a tone the shared component would render as `undefined` classes.
  const chipSrc = strip(read('src/components/ui/StatusChip.tsx'));
  const table = chipSrc.slice(chipSrc.indexOf('TONE_SURFACE_CLASSES'));
  const known = new Set((table.slice(0, table.indexOf('};')).match(/^\s*([a-z]+):/gm) || [])
    .map((m) => m.replace(/[\s:]/g, '')));
  assert.ok(known.size >= 6, 'could not read StatusChip tones — scanner is broken, not clean');
  for (const s of share.LIVE_SHARE_STATUSES) {
    const { tone } = share.shareChip(mkShare({ status: s }));
    assert.ok(known.has(tone), s + ' uses tone "' + tone + '", which StatusChip does not define');
  }
});

// ─── 3. the delegate falls back to the number, never to nothing ───────────

test('a technician-less share falls back to the stored contact number', () => {
  const chip = share.shareChip(mkShare({ delegateEfrId: null, delegateName: null }));
  assert.ok(chip.label.includes('9876543210'),
    'with no delegate NAME the chip must fall back to the contact number the '
    + 'share row stores — the public-link path uses exactly that shape');
});

test('a share with neither name nor number still names something', () => {
  const chip = share.shareChip(mkShare({ delegateName: null, delegateNumber: null }));
  assert.ok(chip.label.split('·')[1] && chip.label.split('·')[1].trim().length > 0,
    'the chip degraded to a bare state with an empty "who" half');
});

test('whitespace-only names do not count as a name', () => {
  const chip = share.shareChip(mkShare({ delegateName: '   ' }));
  assert.ok(chip.label.includes('9876543210'),
    'a blank-but-present delegateName shadowed the number fallback');
});

// ─── 4. the ops release asks first, and only of someone allowed to ────────

test('the release is behind an await confirm(...), not a bare click handler', () => {
  const confirmAt = componentCode.indexOf('await confirm(');
  const postAt = componentCode.indexOf('api.post');
  assert.ok(confirmAt !== -1,
    'no `await confirm(` in ' + COMPONENT + ' — releasing yanks a job out from '
    + 'under a working technician and must ask first');
  assert.ok(postAt !== -1, 'no api.post found — did the endpoint call move?');
  assert.ok(confirmAt < postAt, 'the confirm must be awaited BEFORE the POST');
  assert.match(componentCode, /if \(!ok\) return;/,
    'the confirm result is not checked — a Cancel would release anyway');
});

test('the confirmation names the delegate and the technician getting it back', () => {
  const desc = componentCode.slice(
    componentCode.indexOf('description:'),
    componentCode.indexOf('confirmLabel:'),
  );
  assert.ok(desc.length > 0, 'no description block found — scanner is broken, not clean');
  assert.ok(desc.includes('${who}'), 'confirm copy does not name the delegate');
  assert.ok(desc.includes('${owner}'), 'confirm copy does not name the original technician');
});

test('no native dialogs — estate rule (showToast + useConfirm only)', () => {
  assert.doesNotMatch(componentCode, /window\.confirm|(^|[^.\w])confirm\s*\(\s*['"`]/,
    'native window.confirm() — use useConfirm()');
  assert.doesNotMatch(componentCode, /(^|[^.\w])alert\s*\(/,
    'native alert() — use showToast()');
});

test('the release refuses to render without the permission or a live share', () => {
  assert.match(componentCode, /if \(!allowed[\s\S]{0,80}?\) return null;/,
    'ReleaseShareButton no longer short-circuits on `allowed` — the control '
    + 'would render for operators who cannot call the endpoint');
  assert.match(componentCode, /!isShareLive\(share\)/,
    'the live-share self-gate is gone — Release Share would sit on every '
    + 'ordinary job in the estate');
});

test("the server's own message survives to the toast", () => {
  assert.match(componentCode, /formatApiError\(e/,
    'the catch flattens the failure instead of surfacing the API message — a '
    + '409 "no live share" would read as a generic error');
});

// ─── 5. one declaration of the key and the route; gated at the call site ──

test('the permission key and the route are declared exactly once', () => {
  const decls = componentCode.match(/SHARE_RELEASE_ACTION\s*=/g) || [];
  assert.equal(decls.length, 1,
    'SHARE_RELEASE_ACTION must be declared once, in ' + COMPONENT);
  for (const f of CALL_SITES) {
    const src = strip(read(f));
    assert.doesNotMatch(src, /'isJobShareRelease'|"isJobShareRelease"/,
      f + ' hardcodes the action key instead of importing SHARE_RELEASE_ACTION');
    assert.doesNotMatch(src, /share\/release/,
      f + ' hardcodes the endpoint path; it belongs in ' + COMPONENT);
  }
});

test('the job modal renders the release, gated on the shared key', () => {
  const src = strip(read('src/components/job/JobModal.tsx'));
  const uses = src.match(/<ReleaseShareButton\b/g) || [];
  assert.equal(uses.length, 1, 'JobModal no longer renders exactly one ReleaseShareButton');
  const props = src.slice(src.indexOf('<ReleaseShareButton'));
  const block = props.slice(0, props.indexOf('/>'));
  assert.match(block, /allowed=\{!!footerCan\[SHARE_RELEASE_ACTION\]\}/,
    'JobModal renders ReleaseShareButton without the permission gate');
  assert.match(block, /share=\{job\.share\}/,
    'the button is not handed the share — it could not self-gate on liveness');
  // Passing the flag is inert unless the key was ASKED for: actionFlags only
  // returns keys it was given, so a missing entry reads `undefined` and the
  // button is permanently hidden.
  assert.match(src, /actionFlags\(currentMe, \[[^\]]*SHARE_RELEASE_ACTION/,
    'SHARE_RELEASE_ACTION is missing from the footer actionFlags() list — '
    + 'canJob would never contain it and Release Share could never appear');
});

test('every job-status surface that can hold a share renders the chip', () => {
  // Denominator: the surfaces wired to the share payload. Each must render the
  // SHARED component, not a hand-rolled span — a second chip grammar is what
  // this component exists to prevent.
  const SURFACES = [
    'src/app/(authed)/jobs/page.tsx',
    'src/app/(authed)/my-orders/page.tsx',
    'src/components/job/JobModal.tsx',
  ];
  for (const f of SURFACES) {
    const src = strip(read(f));
    assert.match(src, /<ShareChip\b/, f + ' no longer renders <ShareChip>');
    assert.match(src, /from '@\/components\/job\/JobShareControls'/,
      f + ' does not import from the shared control module');
    assert.match(src, /share\?: JobShare \| null;/,
      f + ' dropped `share` from its job row/detail type — the payload would '
      + 'be silently discarded by TypeScript and the chip never render');
  }
});

// ─── 6. the retired 72-hour public share link is gone ─────────────────────

test('the retired public shared-job page is removed and unreferenced', () => {
  assert.equal(fs.existsSync(path.join(root, 'src/app/public/shared-job')), false,
    'the retired public shared-job page is back — the owner replaced it with '
    + 'the delegation flow and it must not be preserved');
  assert.equal(fs.existsSync(path.join(root, 'src/lib/shared-job-types.ts')), false,
    'shared-job-types.ts is back — nothing but the retired page consumed it');
});
