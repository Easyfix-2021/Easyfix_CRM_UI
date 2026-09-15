'use strict';
/*
 * Schedule & Assign refreshes its OWN data every 15 minutes while it stays open.
 *
 * ─── WHAT WENT WRONG (2026-09-15) ──────────────────────────────────────────
 *
 * Ops leave this modal open while chasing technicians. Job 540158 was accepted
 * on the app while the modal sat open, and the modal kept showing the moment it
 * opened — the job still looked offerable and the Offered-To rows never moved,
 * so the only way to see the acceptance was to close and reopen, or reload the
 * whole page.
 *
 * A background refresh changes data under an operator who may be mid-task, so
 * an adversarial review of the first cut found it could:
 *   • wipe an unsaved Job Description when someone else edited Additional
 *     Comments (the editor re-seeded BOTH fields from the refreshed job);
 *   • unmount the details editor, and the typed text with it, when the refresh
 *     found the job no longer offerable (a technician accepted);
 *   • replace the whole technician table with "Something Went Wrong" for 15
 *     minutes after one failed refresh, hiding the ticks while Offer stayed on;
 *   • leave a ticked technician the refreshed Top 10 dropped invisibly selected
 *     and still sent; leave several radios "checked" when offering was switched
 *     off; and run the ranker all night in a forgotten background tab.
 *
 * ─── WHY A SOURCE-SHAPE GUARD ──────────────────────────────────────────────
 *
 * The suite mounts nothing (same constraint as schedule-assign-server-gate).
 * Each assertion names the regression it blocks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const flat = (rel) => read(rel).replace(/\s+/g, ' ');
const MODAL = 'src/components/job/ScheduleAssignModal.tsx';
const PANEL = 'src/components/job/JobContextPanel.tsx';
const REMARKS = 'src/components/job/JobRemarksView.tsx';
const HOOKS = 'src/lib/hooks.ts';

test('the modal refresh interval is 15 minutes and pauses in hidden tabs', () => {
  assert.match(read(MODAL), /const MODAL_REFRESH_MS = 15 \* 60 \* 1000;/);
  assert.match(read(MODAL), /const MODAL_POLL = \{ refetchInterval: MODAL_REFRESH_MS, pauseWhenHidden: true \} as const;/);
});

test('every read the modal owns polls on that interval', () => {
  const src = flat(MODAL);
  const reads = [
    ['status probe', /`\/admin\/jobs\/\$\{jobId\}` : null, MODAL_POLL\)/],
    ['Top-10 ranking', /useFetch<CandidatesResponse>\(topKey, \{ enabled: !!topKey, \.\.\.MODAL_POLL \}\)/],
    ['typed search', /useFetch<SearchResponse>\(searchKey, \{ enabled: !!searchKey, \.\.\.MODAL_POLL \}\)/],
    ['Offered-To list', /useFetch<JobOffersResponse>\(offersKey, \{ enabled: !!offersKey, \.\.\.MODAL_POLL \}\)/],
    ['Remarks thread', /<JobContextPanel[^>]*remarksRefetchInterval=\{MODAL_REFRESH_MS\}/],
  ];
  for (const [name, re] of reads) assert.match(src, re, `${name} must refresh every MODAL_REFRESH_MS`);
});

test('the Remarks thread refreshes in place, not by remount', () => {
  // A key bump would remount JobRemarksView and collapse the thread ops had opened.
  assert.match(flat(PANEL), /<JobRemarksView key=\{remarksReloadKey\} [^>]*refetchInterval=\{remarksRefetchInterval\}/);
  assert.equal((flat(REMARKS).match(/\{ enabled: !!jobId, refetchInterval, pauseWhenHidden: true \}/g) || []).length, 2,
    'both the comments and the customer-requests reads must poll');
});

test('other hosts of the panel and the view do not start polling', () => {
  // The interval is opt-in, with NO default: a default would make every host poll.
  assert.match(read(REMARKS), /^\s*refetchInterval,$/m, 'JobRemarksView must not default refetchInterval');
  assert.match(read(PANEL), /^\s*remarksRefetchInterval,$/m, 'JobContextPanel must not default remarksRefetchInterval');
  for (const rel of ['src/components/job/AssignTechnicianModal.tsx', 'src/components/job/JobModal.tsx']) {
    assert.doesNotMatch(read(rel), /remarksRefetchInterval|refetchInterval=\{/, `${rel} must not opt into polling`);
  }
});

test('useFetch polls repeatedly, keeps rows on failure, and stops when the key goes null', () => {
  const hooks = read(HOOKS);
  assert.match(hooks, /if \(!enabled \|\| !key \|\| !ms\) return;/, 'no key (closed modal) ⇒ no interval');
  assert.match(hooks, /const fire = \(\) => \{\s*last = Date\.now\(\);\s*cache\.delete\(key\);\s*inflight\.delete\(key\);\s*setTick\(\(t\) => t \+ 1\);\s*\};/,
    'each tick must bust the cache and refetch');
  assert.match(hooks, /const id = setInterval\(\(\) => \{\s*if \(pause && document\.hidden\) return;\s*fire\(\);\s*\}, ms\);/,
    'a repeating interval that skips only hidden-tab ticks when opted in');
  assert.match(hooks, /\{ \.\.\.s, loading: false, refreshing: true, error: null \}/, 'a refresh with data present must not raise loading');
  assert.match(hooks, /data: s\.data, dataKey: s\.dataKey, loading: false, refreshing: false,/, 'a failed poll keeps the rows already shown');
  assert.match(hooks, /setState\(\{ data, dataKey: key,/, 'a success records which key the data belongs to');
});

test('a refresh keeps an unsaved details draft instead of re-seeding it', () => {
  const panel = flat(PANEL);
  assert.match(panel, /if \(jobSwapped \|\| d === s\.desc\) setDesc\(storedDesc\);/, 'Job Description re-seeds only when clean or the job changed');
  assert.match(panel, /if \(jobSwapped \|\| n === s\.notes\) setNotes\(storedNotes\);/, 'Additional Comments re-seeds only when clean or the job changed');
  assert.doesNotMatch(panel, /setSaved\(\{ desc: storedDesc, notes: storedNotes \}\); setDesc\(storedDesc\); setNotes\(storedNotes\);/,
    'the all-or-nothing re-seed that wiped a draft must not come back');
});

test('the details editor stays mounted, locked, while it holds unsaved text', () => {
  const panel = flat(PANEL);
  assert.match(panel, /const showDetailsEditor = canEditDetails \|\| detailsDirty;/);
  assert.match(panel, /<EditableJobDetails job=\{job\} onSave=\{canEditDetails \? onSaveDetails : undefined\} onDirtyChange=\{setDetailsDirty\} \/>/);
  assert.match(panel, /readOnly=\{locked\}/, 'locked text stays selectable to copy (readOnly, not disabled)');
  assert.match(panel, /disabled=\{saving \|\| locked\} onClick=\{save\}/, 'Save is refused while locked');
  // The address save keeps the refresh it was opened with.
  assert.match(panel, /addressSavedRef\.current = onAddressSaved; setAddressOpen\(true\);/);
  assert.match(panel, /onSaved=\{\(\) => \{ setAddressOpen\(false\); addressSavedRef\.current\?\.\(\); \}\}/);
});

test('a failed background refresh keeps the list and offers Retry', () => {
  const modal = flat(MODAL);
  assert.match(modal, /const listRefreshFailed = !!activeRes\.error && !!listData && activeRes\.dataKey === activeKey;/);
  assert.match(modal, /const listError = listRefreshFailed \? null : activeRes\.error;/);
  assert.match(modal, /\{listRefreshFailed && \( <p [^>]*>[^<]*Couldn’t refresh this list/);
});

test('selection stays honest across a refresh', () => {
  const modal = flat(MODAL);
  assert.match(modal, /\.filter\(\(\[id, source\]\) => source === 'top10' && !present\.has\(id\)\)/,
    'Top-10 ticks the refreshed Top 10 dropped are unticked (Search picks are not)');
  assert.match(modal, /no longer in the refreshed Top 10/);
  assert.match(modal, /if \(offerMode \|\| selected\.size <= 1\) return; setSelected\(new Map\(\)\);/,
    'several picks are cleared when offering is switched off');
  assert.match(modal, /<li>• Offered to <b>\{techNames\}<\/b><\/li>/, 'the offer confirm names the technicians');
});
