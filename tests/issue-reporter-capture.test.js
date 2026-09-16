'use strict';
/*
 * Issue reporter (owner, 2026-09-16): capture the page URL, capture the screen,
 * and let the floating button be dragged out of the way — with the spot kept
 * in a cookie.
 *
 * AND, after the first cut shipped (owner, 2026-09-16):
 *   · "it still does not auto capture the page screenshot"
 *   · "everything is just in header line ... like 'Navigation: <Page Path>'"
 *   · "users should be able to add images in comments as well"
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
  // 2048 since migrations/2026-09-16-widen-crm-issue-page-path.sql; the cap
  // is named so the validator's max() and slice() cannot drift apart.
  assert.match(v, /const PAGE_PATH_MAX = 2048;/, 'the cap is the widened column');
  assert.match(rule, /\.slice\(0, PAGE_PATH_MAX\)/, 'and the value is cut to it, never to the old 255');
});

// ─── Capture Screen ─────────────────────────────────────────────────────

test('capture is the browser\'s own API, defaulted to this tab, JPEG at a bounded quality', () => {
  assert.match(SRC, /md\.getDisplayMedia\(\{/);
  assert.match(SRC, /preferCurrentTab: true,/);
  assert.match(SRC, /selfBrowserSurface: 'include',/);
  assert.match(SRC, /canvas\.toBlob\(r, 'image\/jpeg', CAPTURE_JPEG_QUALITY\)/);
  assert.match(SRC, /const CAPTURE_JPEG_QUALITY = 0\.85;/);
  /*
   * AMENDED 2026-09-16. This used to assert NO capture library at all, and that
   * was right while the only capture was the button: getDisplayMedia is native
   * and pixel-exact. The owner then asked for an AUTOMATIC capture, which that
   * API cannot do — it requires a user gesture and always prompts. So exactly
   * ONE rasteriser is allowed, for route zero, and the MANUAL path must still
   * be native. A second library, or the manual path quietly switching to the
   * rasteriser, both fail here.
   */
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(deps.filter((d) => /canvas|screenshot|dom-to-image|html-to-image/i.test(d)), ['modern-screenshot'],
    'exactly one rasteriser, for the automatic capture only');
  const manualAt = SRC.indexOf('async function captureScreen()');
  const manual = SRC.slice(manualAt, SRC.indexOf('\n  }\n', manualAt));
  assert.doesNotMatch(manual, /modern-screenshot|domToBlob/,
    'Capture Screen stays pixel-exact — that is the whole reason it survived route zero');
});

test('the captured frame goes through acceptFiles, so the 5-file and 5 MB rules apply', () => {
  assert.match(SRC, /acceptFiles\(\[new File\(\[blob\], `screen-\$\{Date\.now\(\)\}\.jpg`, \{ type: 'image\/jpeg' \}\)\]\);/);
  // The allow-set lives in the shared module now — assert it where it IS.
  assert.match(strip(read('src/components/issue/screenshotAttachments.tsx')),
    /export const ALLOWED_MIME = new Set\(\['image\/png', 'image\/jpeg'/,
    'jpeg must be in the allow-set or every capture is refused');
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

// ─── The queue links it ─────────────────────────────────────────────────

test('the issue queue renders page_path as a link — the repro is one click', () => {
  const PAGE = strip(read('src/app/(authed)/admin-actions/issues/page.tsx'));
  assert.match(PAGE, /import Link from 'next\/link';/);
  // Both renders: the list cell and the detail header.
  /*
   * Checked per SURFACE rather than with one whole-tag regex. The two links are
   * formatted differently — the list cell on one line, the detail header
   * attribute-per-line — and a single regex that happened to match only one of
   * them would pass with the other deleted, which is precisely the bug this
   * assertion exists to catch.
   */
  for (const [surface, expr] of [['list cell', 'r.page_path'], ['detail header', 'data.page_path']]) {
    const at = PAGE.indexOf(`href={${expr}}`);
    assert.ok(at > -1, `${surface}: page_path must be an anchor's href`);
    const tag = PAGE.slice(PAGE.lastIndexOf('<Link', at), PAGE.indexOf('>', at));
    assert.match(tag, /target="_blank"/, `${surface}: opens in a new tab`);
    assert.match(tag, /rel="noopener"/, `${surface}: and drops the opener reference`);
  }
  // Only an in-app path is linked. page_path is written by one validator, but
  // the guard costs one call and keeps a stray absolute URL from becoming a
  // click-through to somewhere else.
  assert.equal((PAGE.match(/page_path\.startsWith\('\/'\)/g) || []).length, 2, 'each link is guarded on a leading slash');
  assert.doesNotMatch(PAGE, /\{r\.page_path \|\| '—'\}/, 'the old plain-text cell must be gone');
});

// ─── Route zero: the AUTOMATIC capture ──────────────────────────────────

test('opening the panel captures the page with no click and no picker', () => {
  /*
   * getDisplayMedia (route three) requires a user gesture and always shows the
   * browser's picker — a security property of the API, not a setting — so the
   * automatic one HAS to rasterise the DOM instead.
   */
  assert.match(SRC, /const autoCapture = React\.useCallback\(async \(\) => \{/);
  assert.match(SRC, /await import\('modern-screenshot'\)/,
    'dynamically imported: this component mounts on every authed page');
  assert.match(SRC, /domToBlob\(document\.body, \{/);
  // Fires on the OPEN transition, not on every render.
  assert.match(SRC, /if \(!open\) \{ autoCaptureDone\.current = false; return; \}/);
  assert.match(SRC, /if \(autoCaptureDone\.current \|\| files\.length\) return;/,
    're-opening a panel that already has screenshots must not shove another in front of the operator');
});

test('the auto shot is the VIEWPORT, and excludes the reporter itself', () => {
  // A full-body rasterise of a 500-row table is an enormous image against a
  // 5 MB cap, and "Current Screen's Screenshot" is what was asked for.
  assert.match(SRC, /width: window\.innerWidth,/);
  assert.match(SRC, /height: window\.innerHeight,/);
  assert.match(SRC, /translate\(\$\{-window\.scrollX\}px, \$\{-window\.scrollY\}px\)/);
  // The shot must be the PAGE, not the form sitting on top of it.
  assert.match(SRC, /const REPORTER_ROOT_ATTR = 'data-issue-reporter';/);
  assert.match(SRC, /filter: \(node: Node\) => !\(node instanceof Element && node\.hasAttribute\(REPORTER_ROOT_ATTR\)\)/);
  assert.equal((SRC.match(/\{\.\.\.\{ \[REPORTER_ROOT_ATTR\]: '' \}\}/g) || []).length, 2,
    'both roots — the panel and the FAB — must carry the marker');
});

test('a failed auto-capture is SILENT, and goes through the same acceptFiles', () => {
  const at = SRC.indexOf('const autoCapture = React.useCallback');
  assert.ok(at > -1, 'positive control: autoCapture must be locatable');
  const fn = SRC.slice(at, SRC.indexOf('  }, []);', at));
  assert.match(fn, /acceptFiles\(\[new File\(\[blob\], `page-\$\{Date\.now\(\)\}\.jpg`/,
    'the 5-file and 5 MB rules must apply to it like any other attachment');
  assert.match(fn, /\} catch \{/);
  assert.doesNotMatch(fn, /showToast/,
    'it is automatic — a toast on every page whose images will not inline is noise nobody can act on');
});

// ─── Images on comments ─────────────────────────────────────────────────

test('the caps and the picker live in ONE module, used by all three surfaces', () => {
  const SHARED = strip(read('src/components/issue/screenshotAttachments.tsx'));
  assert.match(SHARED, /export const MAX_SCREENSHOTS = 5;/);
  assert.match(SHARED, /export const SCREENSHOT_FIELD = 'screenshot';/,
    "singular — a plural field name arrives at multer as Unexpected field");
  // The report form, the reporter's comment box, and the queue's comment box.
  const QUEUE = strip(read('src/app/(authed)/admin-actions/issues/page.tsx'));
  assert.equal((SRC.match(/useScreenshotAttachments\(\)/g) || []).length, 2,
    'the reporter holds two independent sets: the report form and the comment box');
  assert.match(QUEUE, /useScreenshotAttachments\(\)/);
  // No surface may re-declare the rules.
  for (const [name, src] of [['reporter', SRC], ['queue', QUEUE]]) {
    assert.doesNotMatch(src, /image\/png', 'image\/jpeg/, `${name} must not re-declare the allow-set`);
  }
});

test('a comment posts multipart only when something is attached', () => {
  for (const [name, src] of [['reporter', SRC], ['queue', strip(read('src/app/(authed)/admin-actions/issues/page.tsx'))]]) {
    assert.match(src, /appendScreenshots\(fd, /, `${name}: must send the files`);
    assert.match(src, /fd\.append\('comment_text', text\);/, `${name}: and the text alongside them`);
    // Plain JSON otherwise — every client before this deploy posted that shape.
    assert.match(src, /comment_text: text \}\)/, `${name}: keeps the JSON path`);
  }
});

test('a comment renders its own attachments, opened full size in a tab', () => {
  for (const [name, src] of [['reporter', SRC], ['queue', strip(read('src/app/(authed)/admin-actions/issues/page.tsx'))]]) {
    assert.match(src, /c\.screenshot_urls\?\.length \? \(/, `${name}: renders the gallery`);
    assert.match(src, /target="_blank" rel="noopener noreferrer"/, `${name}: opens full size`);
  }
});

test('text stays required — an image with no sentence cannot be triaged', () => {
  assert.match(SRC, /disabled=\{posting \|\| !commentText\.trim\(\)\}/);
});

// ─── The detail header ──────────────────────────────────────────────────

test('the header is a labelled definition list, and the URL is "Navigation"', () => {
  const QUEUE = strip(read('src/app/(authed)/admin-actions/issues/page.tsx'));
  // It was one flex-wrap row of bare values with nothing saying which was which.
  assert.doesNotMatch(QUEUE, /<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">/,
    'the run-on header line must be gone');
  assert.match(QUEUE, /<dl className="grid/);
  for (const label of ['Status', 'Issue', 'Reported By', 'Reported On', 'Navigation']) {
    assert.match(QUEUE, new RegExp(`<Meta label="${label}"`), `missing field: ${label}`);
  }
  // A real <dt>/<dd>, so a screen reader reads term-then-value.
  assert.match(QUEUE, /<dt className=/);
  assert.match(QUEUE, /<dd className=/);
  // Navigation spans both columns — a full URL with its query is the longest value.
  assert.match(QUEUE, /<Meta label="Navigation" span2>/);
  assert.match(QUEUE, /Not Captured/, 'and says so when there is no path, rather than rendering an em dash');
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
