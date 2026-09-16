'use strict';
/*
 * Issue reporter (owner, 2026-09-16): capture the page URL, capture the screen,
 * and let the floating button be dragged out of the way — with the spot kept
 * in a cookie.
 *
 * Source-scanned, like issue-reporter-scope.test.js and
 * issue-screenshot-enlarge.test.js: the suite mounts nothing, and every rule
 * here is a deletion that type-checks. Comments are stripped before scanning
 * and the first test proves the stripper bites, because the component explains
 * every one of these choices in prose that names the calls it makes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const RAW = read('src/components/issue/IssueReporter.tsx');
const SRC = strip(RAW);

test('the stripper bites — prose naming a call cannot satisfy a check for it', () => {
  assert.match(RAW, /getDisplayMedia rather than a DOM-to-canvas library/,
    'positive control: the header must still describe the capture in prose');
  assert.doesNotMatch(SRC, /DOM-to-canvas library/, 'the comment stripper is broken — every scan below reads documentation');
});

// ─── The page URL ───────────────────────────────────────────────────────

test('the report carries path AND query — the query is the reproduction', () => {
  assert.match(SRC, /import \{ usePathname, useSearchParams \} from 'next\/navigation';/);
  assert.match(SRC, /const search = searchParams\?\.toString\(\);/);
  assert.match(SRC, /const pageUrl = `\$\{pathname \?\? ''\}\$\{search \? `\?\$\{search\}` : ''\}`;/);
  // Both submit branches (multipart with files, JSON without) send the same thing.
  assert.match(SRC, /fd\.append\('page_path', pageUrl\);/);
  assert.match(SRC, /page_path: pageUrl \}/);
  assert.doesNotMatch(SRC, /page_path', pathname|page_path: pathname/, 'no branch may still send the bare pathname');
});

test('the backend keeps the query too — otherwise the FE change is theatre', () => {
  // Located like every cross-repo test here: EASYFIX_BACKEND_DIR first (CI),
  // sibling second. FAIL, never skip: a validator that silently strips the
  // query would make this feature look shipped while storing nothing new.
  const be = process.env.EASYFIX_BACKEND_DIR || path.resolve(__dirname, '../../EasyFix_Backend');
  const file = path.join(be, 'validators', 'issue.validator.js');
  assert.ok(fs.existsSync(file),
    `EasyFix_Backend checkout not found — set EASYFIX_BACKEND_DIR or clone it beside this repo (looked for ${file})`);
  const v = strip(fs.readFileSync(file, 'utf8'));
  const at = v.indexOf('const pagePath = ');
  assert.ok(at > -1, 'positive control: pagePath must be locatable');
  // Up to the custom's NAME, not the first `);` — that one is inside the function.
  const rule = v.slice(at, v.indexOf("'strip-fragment');", at));
  assert.ok(rule.length > 0, 'the rule must still be named strip-fragment');
  assert.match(rule, /split\('#'\)\[0\]/, 'the fragment is still dropped');
  assert.doesNotMatch(rule, /split\('\?'\)/, 'the query must NOT be stripped any more');
  assert.match(rule, /\.slice\(0, 255\)/, 'and the value still fits the VARCHAR(255) column');
});

// ─── Capture Screen ─────────────────────────────────────────────────────

test('capture is the browser\'s own API, defaulted to this tab, JPEG at a bounded quality', () => {
  assert.match(SRC, /md\.getDisplayMedia\(\{/);
  assert.match(SRC, /preferCurrentTab: true,/);
  assert.match(SRC, /selfBrowserSurface: 'include',/);
  assert.match(SRC, /canvas\.toBlob\(r, 'image\/jpeg', CAPTURE_JPEG_QUALITY\)/);
  assert.match(SRC, /const CAPTURE_JPEG_QUALITY = 0\.85;/);
  // No DOM-to-image dependency crept in.
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(deps.filter((d) => /canvas|screenshot|dom-to-image|html-to-image|modern-screenshot/i.test(d)), [],
    'screen capture must stay native — no capture library');
});

test('the captured frame goes through acceptFiles, so the 5-file and 5 MB rules apply', () => {
  assert.match(SRC, /acceptFiles\(\[new File\(\[blob\], `screen-\$\{Date\.now\(\)\}\.jpg`, \{ type: 'image\/jpeg' \}\)\]\);/);
  assert.match(SRC, /const ALLOWED_MIME = new Set\(\['image\/png', 'image\/jpeg'/, 'jpeg must be in the allow-set or every capture is refused');
  assert.match(SRC, /if \(capturing \|\| files\.length >= MAX_SCREENSHOTS\) return;/);
});

test('the capture stream is ALWAYS stopped, and the panel is out of the shot', () => {
  const at = SRC.indexOf('async function captureScreen()');
  assert.ok(at > -1, 'positive control: captureScreen must be locatable');
  const fn = SRC.slice(at, SRC.indexOf('\n  }\n', at));
  const finallyAt = fn.indexOf('} finally {');
  assert.ok(finallyAt > -1, 'the stop must live in finally');
  assert.match(fn.slice(finallyAt), /stream\?\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\);/);
  assert.match(fn.slice(finallyAt), /setCapturing\(false\);/);
  // Hidden BEFORE the picker opens, so the page under it is already panel-free.
  assert.ok(fn.indexOf('setCapturing(true);') < fn.indexOf('md.getDisplayMedia('), 'hide the panel before the picker');
  assert.match(SRC, /capturing && 'invisible',/, 'the panel hides by visibility, never by unmounting the draft');
  // Closing the picker is not an error.
  assert.match(fn, /err\.name === 'NotAllowedError'/);
});

test('the Capture Screen button sits beside Choose Files and is capped like it', () => {
  assert.match(SRC, /onClick=\{captureScreen\}/);
  assert.match(SRC, /disabled=\{capturing \|\| files\.length >= MAX_SCREENSHOTS\}/);
  assert.match(SRC, /Capture Screen\s*<\/Button>/);
});

// ─── The button moves ───────────────────────────────────────────────────

test('the FAB is dragged with pointer events, and a short press is still a click', () => {
  const fab = SRC.slice(SRC.lastIndexOf('<button'), SRC.lastIndexOf('</button>'));
  for (const h of ['onClick={fabClick}', 'onPointerDown={fabPointerDown}', 'onPointerMove={fabPointerMove}', 'onPointerUp={fabPointerUp}', 'onPointerCancel={fabPointerUp}']) {
    assert.ok(fab.includes(h), `the FAB must wire ${h}`);
  }
  assert.ok(fab.includes('touch-none'), 'a finger drag must move the button, not scroll the page');
  assert.match(SRC, /const DRAG_THRESHOLD_PX = 4;/);
  assert.match(SRC, /if \(!d\.moved && Math\.hypot\(dx, dy\) < DRAG_THRESHOLD_PX\) return;/);
  // The click the browser fires after a drag must not toggle the panel.
  assert.match(SRC, /swallowNextClick\.current = true;/);
  assert.match(SRC, /if \(swallowNextClick\.current\) \{\s*swallowNextClick\.current = false;\s*return;\s*\}/);
});

test('the spot is a cookie, long-lived, and read only after mount', () => {
  assert.match(SRC, /const FAB_COOKIE = 'crm_issue_fab';/);
  assert.match(SRC, /const FAB_COOKIE_MAX_AGE = 60 \* 60 \* 24 \* 365;/);
  assert.match(SRC, /document\.cookie = `\$\{FAB_COOKIE\}=\$\{Math\.round\(p\.x\)\},\$\{Math\.round\(p\.y\)\}; path=\/; max-age=\$\{FAB_COOKIE_MAX_AGE\}; SameSite=Lax`;/);
  // Written on release of a drag — with the last clamped position, not a stale one.
  assert.match(SRC, /if \(d\.last\) writeFabCookie\(d\.last\);/);
  // Read in an effect, never during render (SSR has no document).
  assert.match(SRC, /React\.useEffect\(\(\) => \{\s*const saved = readFabCookie\(\);\s*if \(saved\) setFabPos\(clampFab\(saved\)\);/);
  assert.doesNotMatch(SRC, /useState<FabPos \| null>\(readFabCookie/, 'never initialise state from the cookie — that runs on the server');
});

test('a saved spot is clamped into the viewport, on load and on resize', () => {
  assert.match(SRC, /function clampFab\(p: FabPos\): FabPos \{/);
  assert.match(SRC, /const onResize = \(\) => setFabPos\(\(p\) => \(p \? clampFab\(p\) : p\)\);/);
  assert.match(SRC, /window\.addEventListener\('resize', onResize\);/);
  assert.match(SRC, /return \(\) => window\.removeEventListener\('resize', onResize\);/);
  // The corner classes stay the default; a saved spot overrides them inline.
  assert.match(SRC, /style=\{fabPos \? \{ left: fabPos\.x, top: fabPos\.y, right: 'auto', bottom: 'auto' \} : undefined\}/);
});

// ─── Vocabulary ─────────────────────────────────────────────────────────

test('every new label is Title Case', () => {
  for (const label of [
    'Capture Screen', 'Grab This Tab As A Screenshot', 'Report An Issue — Drag To Move',
    'Could Not Capture The Screen.',
    'Screen Capture Is Not Available In This Browser. Paste Or Choose A File Instead.',
  ]) {
    assert.ok(SRC.includes(label), `missing label: ${label}`);
    for (const word of label.replace(/[.—]/g, ' ').split(/\s+/).filter(Boolean)) {
      assert.match(word, /^[A-Z]/, `"${label}" must be Title Case (check:brand / label-casing rule)`);
    }
  }
});
