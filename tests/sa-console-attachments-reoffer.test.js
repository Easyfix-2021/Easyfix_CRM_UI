'use strict';
/*
 * Two console defects ops reported on 2026-09-20, and the rules that fix them.
 *
 * 1. ATTACHMENTS RENDERED BROKEN. Every tile in "Photos and videos" showed a
 *    broken image while the filename under it rendered fine — the signature of
 *    a 401, not a missing row. An <img src> sends NO Authorization header, so
 *    the backend's /images/:id/file reads the JWT off the query string instead
 *    (routes/admin/jobs.js, middleware/auth.js). JobModal's Images tab has
 *    always done this; the console did not. The same card also pushed the
 *    feedback PDF that lives in tbl_job_image through <img>, which can never
 *    work — Chrome refuses it as an opaque response.
 *
 * 2. BLANK TECHNICIAN LIST AFTER A RESCHEDULE. "Proceed to re-offer" landed on
 *    an empty screen. The post-reschedule veil lifts only once it has SEEN the
 *    candidates refetch start, and a refetch answered from useFetch's 30s
 *    module cache can settle without `refreshing` ever being observed as true —
 *    so the veil never lifted. The cache is evicted first (making it a real
 *    round trip) and the veil now has a timeout it cannot outlive.
 *
 * Source-scanned: these are render/effect rules in a TSX file a node test
 * cannot import. Comments are stripped, so prose naming a rule cannot satisfy
 * a check.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');

const UPLIFTED = 'src/components/job/ScheduleAssignUplifted.tsx';
const MODAL = 'src/components/job/ScheduleAssignModal.tsx';
const up = strip(read(UPLIFTED));
const modal = strip(read(MODAL));

// ─── 1. Attachments ──────────────────────────────────────────────────────

test('every attachment URL carries the JWT the <img> tag cannot send', () => {
  assert.match(up, /localStorage\.getItem\('crm_auth_token'\)/,
    'the token must come from the same place the api wrapper stores it');
  assert.match(up, /token=\$\{encodeURIComponent\(token\)\}/,
    'the token must be URL-encoded into the query string');
  // Both file endpoints, not just images — a video tile fails the same way.
  for (const kind of ['images', 'videos']) {
    assert.match(up, new RegExp(`authed\\(\`\\$\\{apiBase\\}/admin/jobs/${kind}/`),
      `the ${kind} file URL must go through the token helper`);
  }
  assert.doesNotMatch(up, /url: `\$\{apiBase\}\/admin\/jobs\/(images|videos)\/[^`]*`,/,
    'no attachment URL may be built without the token');
});

test('the token is optional, so a signed-out render cannot crash', () => {
  assert.match(up, /token \? `\$\{u\}\$\{u\.includes\('\?'\) \? '&' : '\?'\}token=/,
    'no token must yield the bare URL rather than the string "null"');
  assert.match(up, /typeof window !== 'undefined'/,
    'localStorage must not be read during a server render');
});

test('a PDF attachment renders as a document, never through <img>', () => {
  assert.match(up, /isPdf: \/\\\.pdf\$\/i\.test\(name\)/,
    'the PDF flag must come from the stored filename');
  assert.match(up, /m\.isPdf[\s\S]{0,200}?<FileText/,
    'a PDF tile must draw a document icon');
  // The <img> must sit on the far side of the isPdf branch.
  const img = up.indexOf('<img src={m.url}');
  const pdf = up.indexOf('m.isPdf');
  assert.ok(pdf > -1 && img > -1 && pdf < img,
    'the isPdf branch must be taken before anything reaches <img>');
  assert.match(up, /isPdf: false,/, 'videos must declare the flag explicitly');
});

// ─── 1b. The original appointment ────────────────────────────────────────

test('the SDA / OTA tile states the ORIGINAL appointment, always', () => {
  /*
   * It used to explain what SDA and OTA measure, which the chips beside it
   * already say. Ops asked for the date the customer was FIRST promised
   * instead: SDA scores against it, and the Appointment tile above shows only
   * where the job is now, so without this the original is nowhere on the page.
   */
  assert.match(up, /Original appointment\{' '\}\s*\{originalAppt \? formatDate\(originalAppt\) : '—'\}/,
    'the tile must print the original appointment, with an em dash when the row pre-dates the column');
  assert.match(up, /const originalAppt = probe\?\.original_appointment_date_time \?\? null;/,
    'it must read the snapshot the backend takes at create time');
  // The explainer it replaced must be gone, not merely moved.
  assert.doesNotMatch(up, /SDA: check-in on this date/,
    'the old SDA/OTA explainer line was replaced (ops, 2026-09-20)');
  assert.doesNotMatch(up, /keeps SDA Yes/,
    'the conditional check-in hint went with it — the date is shown unconditionally now');
});

// ─── 2. The re-offer landing ─────────────────────────────────────────────

test('a reschedule evicts the candidate cache before re-ranking', () => {
  const fn = modal.match(/function onRescheduled\([\s\S]*?\n  \}/);
  assert.ok(fn, 'positive control: onRescheduled must be found');
  const invalidateAt = fn[0].indexOf('/candidates`');
  const refetchAt = fn[0].indexOf('top.refetch()');
  assert.ok(invalidateAt > -1, 'the candidate cache must be evicted');
  assert.ok(refetchAt > -1, 'the candidates must be refetched');
  assert.ok(invalidateAt < refetchAt,
    'the eviction must come FIRST — a cached refetch never flips `refreshing`, which is what strands the veil');
  // The job's own reads are re-ranked too, or the body shows the old appointment.
  assert.match(fn[0], /=== `\/admin\/jobs\/\$\{jobId\}\/header`/);
});

test('the post-reschedule veil cannot outlive the reschedule', () => {
  const eff = modal.match(/if \(!rescheduling\) return;[\s\S]*?\}, \[rescheduling[^\]]*\]\);/);
  assert.ok(eff, 'positive control: the veil effect must be found');
  assert.match(eff[0], /setTimeout\(\(\) => setRescheduling\(false\), \d+\)/,
    'a refetch that settles without being seen must still lift the veil');
  assert.match(eff[0], /clearTimeout\(t\)/, 'the fallback must be cleaned up');
  assert.match(eff[0], /rescheduleRefetchStarted\.current = true/,
    'the normal path still waits for the refetch to start and settle');
});

test('the operator is offered the technician list after every reschedule', () => {
  const fn = modal.match(/function onRescheduled\([\s\S]*?\n  \}/)[0];
  assert.match(fn, /confirmLabel: expired > 0 \? 'Proceed to re-offer' : 'Proceed to offer'/,
    'the prompt must adapt to whether live offers were actually expired');
  assert.match(fn, /if \(go\) techRef\.current\?\.scrollIntoView/,
    'confirming must take the operator to the technician list');
  // The prompt is no longer fenced on expired offers — this bucket's next step
  // is always "offer it", which is what ops asked to be carried into.
  assert.doesNotMatch(fn, /if \(expired > 0\) \{[\s\S]*?confirmAction/,
    'the prompt must not be locked behind expired offers');
  const prompt = fn.indexOf('confirmAction');
  const rerank = fn.indexOf('top.refetch()');
  assert.ok(rerank < prompt,
    're-ranking must start before the prompt, so the list is on its way in before the operator arrives');
});
