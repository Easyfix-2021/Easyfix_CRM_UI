'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * HRMS → Certificates: the preview must not disagree with the download.
 *
 * WHAT THIS GUARDS
 *
 * The page draws a live preview of a document that something else renders —
 * EasyFix_Backend `utils/pdf-certificate.js` produces the PDF, PNG and JPG the
 * operator actually receives. The preview is therefore a SECOND implementation
 * of one layout, and the failure mode is silent: it looks right, it downloads,
 * and the file differs from what was on screen. Nothing in typecheck, lint or
 * the brand check can see that, because both halves are individually valid.
 *
 * So the invariants below are the seams where the two could drift apart:
 * the rectangles come from the shared Brand Kit artefact rather than from
 * numbers typed into the page, every region the artefact declares is actually
 * placed, one values object feeds both the preview and the request body, and
 * the fit constants still match the renderer's.
 *
 * Source-level, because tests/ here is node:test over pure logic with no DOM.
 */

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'src', 'app', '(authed)', 'hrms', 'certificates', 'page.tsx');
const LAYOUT = path.join(ROOT, 'src', 'brand', 'certificate-layout.json');
const URL_MAP = path.join(ROOT, 'src', 'lib', 'legacy-url-map.ts');

const src = fs.readFileSync(PAGE, 'utf8');

/*
 * Comments are stripped before every structural scan. A previous guard in this
 * repo failed because its own explanatory docblock mentioned the identifier it
 * was asserting the ABSENCE of — the prose read as the thing. This page is
 * heavily commented and several scans below are absence checks, so the
 * stripping is doing real work here rather than being ceremony.
 */
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const codeOnly = strip(src);

test('the rectangles come from the vendored Brand Kit layout, not from this page', () => {
  /*
   * The one rule that makes the preview trustworthy. If the page ever carries
   * its own copy of the geometry, the backend can be re-synced from a new kit
   * and the preview will keep confidently drawing the old positions.
   */
  assert.match(
    codeOnly,
    /import certificateLayout from '@\/brand\/certificate-layout\.json'/,
    'the page must read the vendored layout artefact',
  );
  assert.match(
    codeOnly,
    /certificateLayout\.regions\[name\]/,
    'runs must be placed by region NAME out of the layout, not from local coordinates',
  );
  // And the canvas size is read from the artefact too, never restated.
  assert.match(codeOnly, /CANVAS_W = certificateLayout\.canvas\.width/);
  assert.match(codeOnly, /CANVAS_H = certificateLayout\.canvas\.height/);
});

test('every region the layout declares is actually placed', () => {
  /*
   * ENUMERATE AND JOIN, rather than grep for the ones that are present. A scan
   * that greps the page for region names it already knows about can only ever
   * confirm the regions somebody remembered; it structurally cannot see the one
   * the Brand Kit added and the page ignores. So the population comes from the
   * artefact and the page is joined against it — which also means this test
   * needs no copy of the region list to fall out of date.
   */
  const regions = Object.keys(JSON.parse(fs.readFileSync(LAYOUT, 'utf8')).regions);
  assert.ok(regions.length >= 10, `expected the layout to declare regions, got ${regions.length}`);

  const wanted = codeOnly.match(/const wanted: \[RegionName, string \| undefined\]\[\] = \[[\s\S]*?\n  \];/);
  assert.ok(wanted, 'the run plan must exist');
  for (const name of regions) {
    assert.ok(
      wanted[0].includes(`'${name}'`),
      `region '${name}' is declared by the layout but never placed by the page`,
    );
    assert.ok(
      new RegExp(`\\b${name}:`).test(codeOnly),
      `region '${name}' has no entry in the STYLE table`,
    );
  }
});

test('one values object feeds BOTH the preview and the request body', () => {
  /*
   * The anti-drift seam. Two independent derivations — one for what is drawn,
   * one for what is sent — is exactly how a preview starts lying: a field
   * trimmed in one place and not the other is invisible until someone compares
   * a screen with a downloaded file.
   */
  assert.match(codeOnly, /const values = certificateValues\(form\);/);
  assert.match(
    codeOnly,
    /<CertificatePreview values=\{values\}/,
    'the preview must render from the same values object',
  );
  assert.match(
    codeOnly,
    /body: \{ \.\.\.values, format \}/,
    'the request body must be that same object plus the format',
  );
  // Exactly one place converts the form, so there is no second set of rules.
  assert.equal(
    (codeOnly.match(/function certificateValues\(/g) || []).length, 1,
    'certificateValues must be the only form→wire conversion',
  );
});

test('the fit still matches the renderer it is previewing', () => {
  /*
   * Transcribed from EasyFix_Backend utils/pdf-certificate.js `fitRun`. If the
   * renderer changes its floor, its step or its height cap, the preview keeps
   * shrinking text to a different size and nothing else notices.
   */
  assert.match(codeOnly, /MIN_SIZE = 6 \* SCALE/, 'the 6pt floor');
  assert.match(codeOnly, /STEP = 0\.5 \* SCALE/, 'the half-point shrink step');
  assert.match(codeOnly, /Math\.min\(st\.size, run\.rect\.h \/ 1\.25\)/, 'the height cap');
  assert.match(codeOnly, /Math\.max\(MIN_SIZE, cap - steps \* STEP\)/, 'snapped onto the same grid');
  // Shrink, never wrap: a fitted run is one line by construction.
  assert.ok(
    !/textLength=/.test(codeOnly),
    'text must be shrunk by font-size, never squeezed with textLength',
  );
});

test('a bare calendar date is never given a timezone', () => {
  /*
   * `new Date('2026-08-13')` parses as UTC midnight and renders as the previous
   * day west of Greenwich — the naive-parse shift this codebase has hit
   * repeatedly, and on a printed certificate it is not recoverable. The only
   * admissible `new Date(` here is the epoch arithmetic that derives today in
   * IST, which takes a NUMBER and so cannot misparse a string.
   */
  const constructions = codeOnly.match(/new Date\([^)]*\)/g) || [];
  assert.equal(constructions.length, 1, `expected exactly one Date construction, got ${constructions.join(', ')}`);
  assert.match(constructions[0], /Date\.now\(\)/, 'the only Date must be built from the epoch, not parsed from a string');
  // The operator's own date is read character-wise out of the input value.
  assert.match(codeOnly, /\/\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)\$\//);
});

test('the page is gated on isCertificateIssue and downloads as bytes', () => {
  assert.match(codeOnly, /actionFlags\(me, \['isCertificateIssue'\]\)/);
  assert.match(codeOnly, /if \(!can\.isCertificateIssue\)/, 'and it must actually branch on the flag');
  assert.match(codeOnly, /Access Denied/);

  /*
   * api.post parses the response as JSON, which corrupts a byte stream — the
   * PDF/PNG/JPG would arrive as a mangled string. downloadXlsx is the shared
   * authed-fetch → blob → anchor helper every other download uses.
   */
  assert.match(codeOnly, /await downloadXlsx\(\{/);
  assert.ok(!/api\.(post|get)\(/.test(codeOnly), 'the render endpoint must not be called through api.*');

  // All three formats the endpoint accepts are offered.
  assert.match(codeOnly, /\(\['pdf', 'png', 'jpg'\] as const\)/);
});

test('the URL map resolves the new page and has dropped the retired one', () => {
  const map = strip(fs.readFileSync(URL_MAP, 'utf8'));
  assert.match(map, /'hrmsCertificates':\s*'\/hrms\/certificates'/);
  assert.ok(
    !/lmsCertificates/.test(map),
    'the retired LMS certificates leaf must be gone, or the sidebar keeps offering it',
  );
});

test('positive control — the comment stripper actually removes prose', () => {
  /*
   * Several scans above are ABSENCE checks (no textLength, no api.post, no
   * lmsCertificates), and every one of them runs against `codeOnly`. A stripper
   * that silently stopped stripping would start matching this file's own
   * explanations and report a violation that is only a sentence — or, worse,
   * pass an absence check because the identifier it sought had been commented
   * out rather than removed. Proven on a synthetic sample rather than on the
   * page, so the control cannot be satisfied by whatever the page happens to
   * contain today.
   */
  const sample = [
    "/* mentions textLength= and api.post( and lmsCertificates in prose */",
    "const kept = 1;",
    "// lmsCertificates",
  ].join('\n');

  const stripped = strip(sample);
  assert.ok(!stripped.includes('textLength='), 'block comments must go');
  assert.ok(!stripped.includes('lmsCertificates'), 'line comments must go too');
  assert.ok(!stripped.includes('api.post('), 'a quoted identifier inside prose must go');
  assert.ok(stripped.includes('const kept = 1;'), 'and the code must survive');

  // And the page really does carry prose for it to have removed.
  assert.ok(codeOnly.length < src.length, 'the page must contain comments the scans excluded');
});
