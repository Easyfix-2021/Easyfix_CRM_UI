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
const CERT_DIR = path.join(ROOT, 'src', 'app', '(authed)', 'hrms', 'certificates');
const PAGE = path.join(CERT_DIR, 'page.tsx');
const FACES = path.join(CERT_DIR, 'certificate-faces.ts');
const LAYOUT = path.join(ROOT, 'src', 'brand', 'certificate-layout.json');
const PALETTE = path.join(ROOT, 'src', 'brand', 'palette.ts');
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
  /*
   * ONE documented exception, listed here rather than skipped silently.
   *
   * certificateIdLine is declared by the layout and drawn by the RENDERER, but
   * cannot be drawn by the preview: the number is issued by the server when the
   * document is created, so at preview time it does not exist. Placing a
   * placeholder would be the lie this whole file guards against.
   *
   * It stays an explicit entry so the join above keeps its value — a region the
   * Brand Kit adds tomorrow and the page ignores still fails this test.
   */
  const NOT_PREVIEWED = new Set(['certificateIdLine']);

  const regions = Object.keys(JSON.parse(fs.readFileSync(LAYOUT, 'utf8')).regions);
  assert.ok(regions.length >= 10, `expected the layout to declare regions, got ${regions.length}`);
  for (const name of NOT_PREVIEWED) {
    assert.ok(regions.includes(name), `${name} is exempted but the layout no longer declares it`);
  }

  const wanted = codeOnly.match(/const wanted: \[RegionName, string \| undefined\]\[\] = \[[\s\S]*?\n  \];/);
  assert.ok(wanted, 'the run plan must exist');
  for (const name of regions) {
    if (NOT_PREVIEWED.has(name)) continue;
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
  /*
   * The body is `values` plus exactly two NON-DOCUMENT keys: `format`, which
   * chooses the encoding, and `issueKey`, which identifies the act of issuing.
   * Neither describes the certificate, which is why neither may come from
   * certificateValues() — and the enumeration is closed on purpose, so a
   * document field added to the body but not to `values` still fails here.
   */
  const body = codeOnly.match(/body: \{ \.\.\.values,([^}]*)\}/);
  assert.ok(body, 'the request body must spread the same values object');
  const extras = body[1].split(',').map((k) => k.trim()).filter(Boolean);
  assert.deepEqual(
    extras.sort(),
    ['format', 'issueKey'],
    `only format and issueKey may be added to the body, found: ${extras.join(', ')}`,
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

  /*
   * Case is applied BEFORE the first measurement. Caps are ~12% wider, so
   * uppercasing after the fit sizes a string nobody draws — the renderer's own
   * comment says as much, and its `upper` flag lives in STYLE for that reason.
   */
  const fit = /function fitRun\([\s\S]*?\n\}/.exec(codeOnly);
  assert.ok(fit, 'fitRun must exist');
  const body = fit[0];
  /*
   * PRESENCE FIRST, THEN ORDER. `indexOf` returns -1 for a string that is not
   * there, and -1 is less than every real index — so an ordering assertion
   * written as `indexOf(a) < indexOf(b)` is SATISFIED by deleting `a`
   * altogether, which is the worse regression of the two. Caught by the
   * control: removing the uppercasing outright left this test green.
   */
  const upperAt = body.indexOf('.toUpperCase()');
  const measureAt = body.indexOf('const natural = measure(');
  assert.ok(upperAt !== -1, 'fitRun must apply STYLE.upper — the flag is read nowhere else');
  assert.ok(measureAt !== -1, 'fitRun must take a first width measurement');
  assert.ok(
    upperAt < measureAt,
    'the run must be uppercased before it is measured, not after it is fitted',
  );

  /*
   * The truncation loop, transcribed. The renderer measures `out + '…'` and
   * appends the ellipsis once the loop ends; a loop that breaks with the
   * ellipsis already written keeps one character more than the renderer does.
   */
  assert.match(body, /while \(out\.length > 1 && measure\(`\$\{out\}…`\) > maxW\) out = out\.slice\(0, -1\);/);
  assert.match(body, /out \+= '…';/);

  /*
   * Centring is the PLAN's decision, made once from the width the fitter
   * measured — not re-derived at draw time. `text-anchor: middle` would
   * re-centre from the browser's own width, which counts a trailing
   * letter-spacing unit that pdfkit's does not.
   */
  assert.match(body, /el\.setAttribute\('x', String\(run\.rect\.x \+ Math\.max\(0, \(maxW - width\) \/ 2\)\)\)/);
  assert.ok(!/textAnchor/.test(codeOnly), 'x must be computed, never delegated to text-anchor');
  assert.match(codeOnly, /function trailingSpacingUnits\(/,
    'the trailing letter-spacing unit must be measured from the engine, not assumed');
  assert.match(body, /const trail = trailing \* st\.tracking;/);

  // The baseline uses THIS face's metrics, not one set shared by all four.
  assert.match(body, /run\.rect\.h - face\.lineHeight \* size/);
  assert.match(body, /top \+ face\.ascender \* size/);
});

/*
 * ─── THE STYLE TABLE ────────────────────────────────────────────────────────
 *
 * The renderer's `STYLE` is the certificate's typography: one face, size,
 * colour, tracking and case per region. It was rewritten (grey sans heading →
 * red serif; the recipient name uppercased; a script signatory) and the preview
 * did not follow, so an operator previewed one document and downloaded another.
 *
 * The expectations below are the renderer's table, restated once. That IS a
 * second copy — unavoidable, because the two live in different repos and node
 * cannot import across them — but a copy in a test fails loudly on the next
 * divergence, whereas the copy in the page fails silently. The point of pinning
 * it here is that changing the page alone can no longer be enough.
 */
const RENDERER_STYLE = {
  //                    face          pt   colour     tracking  upper
  heading: ['serifBold', 30, 'brandRed', 8, false],
  eyebrowPresentedTo: ['sans', 9, 'muted', 3, false],
  recipientName: ['sansBold', 31, 'ink', 0, true],
  eyebrowFor: ['sans', 9, 'muted', 3, false],
  title: ['sansBold', 25, 'deepRed', 0, false],
  dateValue: ['sans', 12, 'ink', 0, false],
  dateLabel: ['sans', 8, 'muted', 2, false],
  signatoryName: ['script', 20, 'ink', 0, false],
  signatoryTitle: ['sans', 8, 'muted', 2, true],
  certificateIdLine: ['sans', 8, 'muted', 0.5, false],
};

/*
 * Returns the reasons `source` disagrees with the renderer's table — empty when
 * it agrees. A function rather than a loop of bare asserts so the SAME scan can
 * be pointed at deliberately-wrong input in the control below: a scan that has
 * never been shown to reject anything is not evidence that the page is right.
 */
function styleDrift(source) {
  const bad = [];
  for (const [region, [face, size, ink, tracking, upper]] of Object.entries(RENDERER_STYLE)) {
    const row = new RegExp(`^\\s*${region}:\\s*\\{(.*)\\},?$`, 'm').exec(source);
    if (!row) { bad.push(`${region} — no row in the STYLE table`); continue; }
    const decl = row[1];
    const want = (re, why) => { if (!re.test(decl)) bad.push(`${region} — ${why}`); };

    want(new RegExp(`face:\\s*'${face}'`), `must be set in the '${face}' face`);
    want(new RegExp(`size:\\s*${String(size).replace('.', '\\.')}\\s*\\*\\s*SCALE\\b`),
      `must be ${size}pt, converted onto the canvas by SCALE`);
    want(new RegExp(`color:\\s*certificateInk\\.${ink}\\b`), `must be drawn in certificateInk.${ink}`);
    want(new RegExp(`tracking:\\s*${String(tracking).replace('.', '\\.')}(\\s*\\*\\s*SCALE)?\\b`),
      `must track ${tracking}`);
    if (/\bupper:\s*true/.test(decl) !== upper) {
      bad.push(`${region} — ${upper ? 'must be UPPERCASED' : 'must not be uppercased'}; case is measured, so it changes the fit`);
    }
  }
  return bad;
}

test('every run is set in the face, size, colour, tracking and case the renderer uses', () => {
  assert.deepEqual(styleDrift(codeOnly), [], 'the preview\'s type must be the renderer\'s type');
});

test('positive control — the style scan rejects each kind of drift', () => {
  /*
   * One mutation per axis, each the actual regression this page shipped with:
   * the heading in grey sans instead of red serif, the recipient name left in
   * the case the operator typed, the title in the old navy, the tracked eyebrow
   * untracked, and a size that no longer matches the renderer's point value.
   * If any mutation still passes, the corresponding assertion above is
   * decorative and the page is unguarded on that axis.
   */
  const mutations = {
    face: [/heading: \{ face: 'serifBold'/, "heading: { face: 'sans'"],
    size: [/size: 30 \* SCALE/, 'size: 15 * SCALE'],
    colour: [/color: certificateInk\.deepRed/, 'color: certificateInk.muted'],
    tracking: [/eyebrowPresentedTo: \{ face: 'sans', size: 9 \* SCALE, color: certificateInk\.muted, tracking: 3 \* SCALE \}/,
      "eyebrowPresentedTo: { face: 'sans', size: 9 * SCALE, color: certificateInk.muted, tracking: 0 }"],
    case: [/, upper: true \}(,?)\n(\s*)eyebrowFor/, ' }$1\n$2eyebrowFor'],
  };

  for (const [axis, [find, replace]] of Object.entries(mutations)) {
    assert.match(codeOnly, find, `the control's ${axis} mutation must have something to mutate`);
    const drift = styleDrift(codeOnly.replace(find, replace));
    assert.ok(drift.length > 0, `the scan failed to notice a ${axis} change: ${JSON.stringify(drift)}`);
  }

  // And the unmutated source really is clean, so the control is measuring the
  // mutation rather than a scan that reports drift on everything.
  assert.deepEqual(styleDrift(codeOnly), []);
});

test('the certificate ink is the renderer\'s, to the hex', () => {
  /*
   * The colours the page names have to BE the renderer's, not merely exist.
   * `certificateInk` is the one place in the CRM allowed a colour literal, and
   * it holds these four solely so the preview can mirror a document this repo
   * does not own.
   */
  const ink = fs.readFileSync(PALETTE, 'utf8');
  const block = ink.slice(ink.indexOf('export const certificateInk'));
  for (const [key, hex] of Object.entries({
    brandRed: '#C42430', deepRed: '#8E1B24', ink: '#111111', muted: '#5A5A5A',
  })) {
    assert.match(block, new RegExp(`${key}:\\s*'${hex}'`, 'i'),
      `certificateInk.${key} must be ${hex}, the renderer's own value`);
  }
});

test('the fixed strings are the renderer\'s, including the footer it composes', () => {
  /*
   * The operator types none of these, so the preview is the only thing that can
   * get them wrong. The eyebrow was re-worded ("PRESENTED TO" →
   * "THIS CERTIFICATE IS PROUDLY PRESENTED TO") and the footer became one
   * composed caption rather than a bare id.
   */
  assert.match(codeOnly, /PRESENTED_TO = 'THIS CERTIFICATE IS PROUDLY PRESENTED TO'/);
  assert.match(codeOnly, /DEFAULT_HEADING = 'CERTIFICATE OF COMPLETION'/);
  assert.match(codeOnly, /DEFAULT_EYEBROW = 'FOR SUCCESSFULLY COMPLETING THE TRAINING'/);
  assert.match(codeOnly, /SITE = 'www\.easyfix\.in'/);

  /*
   * The footer is NOT drawn in the preview, and that is the assertion now.
   *
   * The Certificate ID became server-issued on 2026-09-07, so at preview time
   * it does not exist — while the downloaded file always carries the line.
   * Omitting it is honest; inventing a placeholder would put text on screen
   * that the file will not contain, which is the one thing this preview must
   * never do. The caption under the Download buttons states the omission.
   */
  assert.doesNotMatch(
    codeOnly,
    /certificateId(?!Line)/,
    'the operator must not be able to type a Certificate ID — it is issued by the server',
  );
  assert.doesNotMatch(
    codeOnly,
    /\['certificateIdLine',\s*[^\]]*`/,
    'the preview must not compose a Certificate ID line it cannot know',
  );
  assert.match(
    src,
    /issued on download/i,
    'and the page must SAY the number is issued on download, so the gap is stated not silent',
  );
});

test('the type is the renderer\'s own font files, and nothing may fall back', () => {
  const faces = strip(fs.readFileSync(FACES, 'utf8'));

  /*
   * NOT `next/font/google`. Two independent reasons, and either alone is
   * disqualifying: the Google release of Playfair Display is the variable v2,
   * whose advances differ from the static Bold the renderer embeds — so the
   * fitter would shrink long runs to a different size than the PDF — and
   * `next/font/google` fetches at BUILD time, which has already taken a Prod
   * deploy down once (see src/app/layout.tsx).
   */
  assert.ok(!/next\/font\/google/.test(faces), 'the certificate faces must not come from Google Fonts');
  assert.match(faces, /import localFont from 'next\/font\/local'/);

  // The three display faces are vendored; the sans face reuses the CRM's own.
  for (const file of ['PlayfairDisplay-Bold.ttf', 'IBMPlexSans-Bold.ttf', 'GreatVibes-Regular.ttf']) {
    assert.ok(fs.existsSync(path.join(CERT_DIR, 'fonts', file)), `${file} must be vendored beside the page`);
    assert.match(faces, new RegExp(`src: '\\./fonts/${file.replace('.', '\\.')}'`));
  }
  assert.match(faces, /src: '\.\.\/\.\.\/\.\.\/fonts\/ibm-plex-sans-400\.woff2'/,
    'the sans face must reuse the CRM\'s existing woff2 rather than a fourth copy of the bytes');

  /*
   * A synthesised fallback would draw the wrong shapes on a document about to
   * be shipped, and would make `style.fontFamily` a list the readiness check
   * has to pick apart. Off on every face.
   */
  assert.equal(
    (faces.match(/adjustFontFallback: false/g) || []).length, 4,
    'every face must disable next/font\'s synthetic fallback',
  );
  assert.equal((faces.match(/display: 'block'/g) || []).length, 4, 'and none may paint a substitute while loading');

  /*
   * Every face's metrics are the renderer's, read off the same files. These are
   * ascent/unitsPerEm and (ascent - descent)/unitsPerEm — what pdfkit uses for
   * `_font.ascender` and `currentLineHeight()`. The page used to carry
   * Helvetica's 0.718/0.925 for all four, which puts the recipient name's
   * baseline ~19 canvas units high.
   */
  for (const [face, ascender, lineHeight] of [
    ['sans', '1.025', '1.3'], ['sansBold', '1.025', '1.3'],
    ['serifBold', '1.082', '1.333'], ['script', '0.851', '1.252'],
  ]) {
    assert.match(
      faces,
      new RegExp(`${face}:\\s*\\{[^}]*ascender:\\s*${ascender.replace('.', '\\.')},\\s*lineHeight:\\s*${lineHeight.replace('.', '\\.')}`),
      `${face} must carry its own ascender/lineHeight, not another face's`,
    );
  }
  assert.ok(!/0\.718|0\.925/.test(codeOnly + faces), 'Helvetica\'s metrics must be gone from both files');

  // And the page must refuse to draw until they are confirmed loaded.
  assert.match(codeOnly, /fonts\.load\(spec, FACE_SAMPLE\)/);
  assert.match(codeOnly, /fonts\.check\(spec, FACE_SAMPLE\)/,
    'load() resolves for a face that 404s — only check() answers whether it is usable');
  assert.match(codeOnly, /\{facesReady && runs\.map\(/, 'no run may be drawn before the faces are ready');
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

test('one issuance per form — the key is minted from the values, not per click', () => {
  /*
   * Reported 2026-09-08: one filled form, a click on PDF then on PNG, and the
   * backend recorded two certificate numbers for one award. Pressing a second
   * FORMAT button is not issuing a second document, and only this page knows
   * where one issuance ends — so it mints the key.
   */
  assert.match(
    codeOnly,
    /const issueKey = React\.useMemo\(/,
    'the page must mint an issue key',
  );
  assert.match(
    codeOnly,
    /\[JSON\.stringify\(values\)\]/,
    'keyed on the SERIALISED values — `values` is rebuilt every render, so identity would mint a new key per keystroke',
  );
  assert.match(
    codeOnly,
    /body: \{ \.\.\.values, format, issueKey \}/,
    'and send it with every download',
  );

  /*
   * It must NOT reach the preview. The preview draws the document; this is
   * bookkeeping about the act of issuing one, and a value that appears in both
   * is a value that can end up printed.
   */
  const planRuns = codeOnly.slice(codeOnly.indexOf('function planRuns'));
  const planBody = planRuns.slice(0, planRuns.indexOf('\n}'));
  assert.doesNotMatch(planBody, /issueKey/, 'the key must never reach the preview');
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
