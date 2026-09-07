'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * The Manage Easyfixers counts strip carries a "Status Drift" alarm.
 *
 * WHAT WENT WRONG (2026-09-07)
 *
 * tbl_easyfixer holds TWO status columns and two CRMs read different ones: the
 * legacy Java CRM reads `efr_status`, this one renders the `lifecycle_status`
 * chip. The backend writes both together, so a disagreement can only come from
 * an outside write — and the legacy CRM, still live, flips efr_status alone.
 *
 * Reported for efr 4980: Active in the legacy CRM, Inactive here. Filtering
 * this page by Status=Active RETURNED the row (the filter reads efr_status)
 * while its chip still said Inactive (the chip reads lifecycle_status) — the
 * contradiction visible in one screenshot.
 *
 * It is not cosmetic: work eligibility ANDs both columns, so a drifted
 * technician receives no job offers at all while ops reads Active.
 *
 * Source-level, because tests/ here is node:test over pure logic with no DOM.
 */

const PAGE = path.join(__dirname, '..', 'src', 'app', '(authed)', 'easyfixers', 'page.tsx');
const src = fs.readFileSync(PAGE, 'utf8');

/*
 * Comments are stripped before every structural scan. A previous guard in this
 * repo failed because its own explanatory docblock mentioned the identifier it
 * was asserting the ABSENCE of — the prose read as the thing.
 */
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('the strip carries a Status Drift entry driving its own filter dimension', () => {
  const entry = codeOnly.match(/\{[^{}]*key: 'status_drift'[^{}]*\}/);
  assert.ok(entry, 'a status_drift entry must exist in the counts strip');
  assert.match(entry[0], /statusDrift: '1'/, 'it must switch the drift filter on');
  assert.match(entry[0], /hideAtZero: true/, 'it must hide itself at zero');
  assert.match(entry[0], /label: 'Status Drift'/);
});

test('drift is the ONLY entry that hides at zero', () => {
  /*
   * The six legacy buckets are worth reading at zero — zero is a fact about the
   * roster. Zero drift is the ABSENCE of a defect, and a permanent zero for an
   * impossible state trains the eye to skip the one number that must be noticed
   * the day it moves. If a second entry ever adopts hideAtZero, that reasoning
   * has to be re-argued rather than inherited.
   */
  const hidden = (codeOnly.match(/hideAtZero: true/g) || []).length;
  assert.equal(hidden, 1, 'exactly one strip entry may hide at zero');
  assert.match(
    codeOnly,
    /allItems\.filter\(\(it\) => !it\.hideAtZero \|\| Number\(counts\[it\.key\]\) > 0\)/,
    'the strip must actually apply hideAtZero — the flag alone renders nothing',
  );
});

test('picking any status control clears the other two dimensions', () => {
  /*
   * status / lifecycleStatus / statusDrift are three faces of ONE dimension and
   * the backend ANDs them, so leaving a stale one on filters the list by
   * something no visible control reports. Each entry carries all three fields
   * with the unused ones blank, which is what makes the exclusion structural
   * rather than something each call site has to remember.
   */
  const entries = codeOnly.match(/\{\s*key: '(?:active|inactive|idle|not_eligible|not_suitable|reg_in_progress|training_pending|status_drift)'[^{}]*\}/g) || [];
  assert.equal(entries.length, 8, 'all eight strip entries must be found');
  for (const entry of entries) {
    assert.match(entry, /status: '/, `entry missing the bucket field: ${entry}`);
    assert.match(entry, /lifecycleStatus: '/, `entry missing the lifecycle field: ${entry}`);
    assert.match(entry, /statusDrift: '/, `entry missing the drift field: ${entry}`);
  }

  // The Status dropdown owns the same dimension, so it clears the drift too.
  assert.match(
    codeOnly,
    /lifecycleStatus: v,[\s\S]{0,200}?statusDrift: '',/,
    'the Status dropdown must clear statusDrift alongside the legacy bucket',
  );
});

test('the drift filter reaches the backend, and an id lookup suppresses it', () => {
  /*
   * An id search is an identity lookup, so no status dimension may narrow it —
   * the same rule the bucket and the lifecycle filter already follow. Reported
   * for efr 9501, which read as "no results" for a record that plainly exists.
   */
  assert.match(
    codeOnly,
    /if \(!idLookup && f\.statusDrift\) q\.statusDrift = 'true';/,
    'statusDrift must be sent, and suppressed for an id lookup',
  );
  assert.match(codeOnly, /statusDrift: '',\s*$/m, 'DEFAULT_FILTERS must define statusDrift');
});

test('positive control — the comment stripper actually removes prose', () => {
  /*
   * Every scan above runs against `codeOnly`, and a scan that silently stopped
   * stripping would start matching the explanations instead of the code. A
   * previous guard in this repo failed exactly that way. Proven on a synthetic
   * sample rather than on the page, so the control cannot be satisfied by
   * whatever the page happens to contain today.
   */
  const strip = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const sample = [
    "/* key: 'status_drift' with hideAtZero: true, described in prose */",
    "const kept = 1;",
    "// hideAtZero: true",
  ].join('\n');

  const stripped = strip(sample);
  assert.ok(!stripped.includes('hideAtZero'), 'block and line comments must both go');
  assert.ok(!stripped.includes('status_drift'), 'a quoted identifier inside prose must go too');
  assert.ok(stripped.includes('const kept = 1;'), 'and the code must survive');

  // And the page really does carry prose for it to have removed.
  assert.ok(codeOnly.length < src.length, 'the page must contain comments the scans excluded');
});
