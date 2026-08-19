'use strict';

/*
 * Festival ornaments — the resolver and the assets it points at.
 *
 * WHY THE ASSETS ARE TESTED AND NOT JUST THE LOOKUP
 *
 * `festivalById` is twelve lines and could hardly be wrong. The failure this
 * file actually guards against is the asset drifting away from the table: a
 * renamed SVG, a file that never got committed, an ornament whose animation
 * ignores reduced motion, or a colour that is not on the brand page. Every one
 * of those ships green under a unit test of the lookup alone, and every one of
 * them is invisible until a festival window opens in production — which is
 * exactly when nobody is looking at the CRM's sidebar with a colour picker.
 *
 * HOW THE TS MODULE IS LOADED
 *
 * `npm test` compiles a FIXED list of `src/lib/*.ts` into `.test-build` before
 * running node:test, and `festivals.ts` is not on it (it lives under
 * `src/components/brand/`). Rather than widen that list, the module is
 * transpiled in-process with the TypeScript compiler that is already a
 * devDependency. It has no imports, so a bare CommonJS wrapper is enough, and
 * the assertions run against the REAL exported function rather than a regex
 * scraped out of the source.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const FESTIVALS_TS = path.join(ROOT, 'src', 'components', 'brand', 'festivals.ts');

function loadFestivalsModule() {
  const source = fs.readFileSync(FESTIVALS_TS, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: 'festivals.ts',
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', outputText)(mod.exports, mod, require);
  return mod.exports;
}

const { FESTIVALS, festivalById } = loadFestivalsModule();

/** Ornaments are assets, so their path is resolved from `src`, never guessed. */
const ornamentPath = (festival) => path.join(PUBLIC_DIR, festival.src.replace(/^\//, ''));
const readOrnament = (festival) => fs.readFileSync(ornamentPath(festival), 'utf8');

/*
 * The palette the ornaments are allowed to use.
 *
 * Brand tokens only, plus ONE documented exception: the national tricolour,
 * admitted solely for the two national days as thin rules and a small roof
 * flag. It is asserted separately below so the exception cannot quietly spread
 * to the other three ornaments.
 */
const BRAND_HEXES = [
  '#C99A2E', // gold
  '#E0930F', // warning
  '#2A6FBF', // blue
  '#1B9E5A', // success
  '#C42430', // red
  '#5C636B', // ink-500
  '#9AA1A9', // ink-300
];
const TRICOLOUR_HEXES = ['#FF9933', '#138808'];
const APPROVED_HEXES = new Set([...BRAND_HEXES, ...TRICOLOUR_HEXES].map((h) => h.toUpperCase()));

const hexesIn = (svg) => (svg.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toUpperCase());

// ─── festivalById — fail-soft ─────────────────────────────────────────────

test('festivalById returns null for unknown, null and undefined ids', () => {
  assert.equal(festivalById('christmas'), null);
  assert.equal(festivalById('DIWALI'), null); // ids are exact, not case-folded
  assert.equal(festivalById(''), null);
  assert.equal(festivalById(null), null);
  assert.equal(festivalById(undefined), null);
});

test('festivalById resolves every id in the table to its own entry', () => {
  for (const festival of FESTIVALS) {
    assert.equal(festivalById(festival.id), festival, `id ${festival.id}`);
  }
});

test('festivalById never throws on hostile input', () => {
  // The id comes from an admin-editable row, so a bad value is a Tuesday.
  for (const bad of [0, false, NaN, '  ', '../../etc/passwd', '__proto__']) {
    assert.doesNotThrow(() => festivalById(bad));
  }
  assert.equal(festivalById('__proto__'), null);
});

// ─── the table itself ─────────────────────────────────────────────────────

test('the four expected ornaments are present, with unique ids', () => {
  const ids = FESTIVALS.map((f) => f.id);
  assert.deepEqual([...ids].sort(), ['diwali', 'holi', 'independence', 'mourning']);
  assert.equal(new Set(ids).size, ids.length);
});

test('every entry has a well-formed shape', () => {
  for (const festival of FESTIVALS) {
    assert.equal(typeof festival.id, 'string', 'id');
    assert.ok(festival.label.length > 0, `${festival.id} label`);
    assert.equal(typeof festival.animated, 'boolean', `${festival.id} animated`);
    assert.equal(
      festival.src,
      `/brand/festivals/${festival.id}.svg`,
      `${festival.id} src follows the id`,
    );
  }
});

// ─── the assets on disk ───────────────────────────────────────────────────

test("every entry's src exists on disk under public/", () => {
  for (const festival of FESTIVALS) {
    const file = ornamentPath(festival);
    assert.ok(fs.existsSync(file), `missing ornament for ${festival.id}: ${file}`);
    assert.ok(file.startsWith(PUBLIC_DIR + path.sep), `${festival.id} escapes public/`);
  }
});

test('every ornament carries the reduced-motion opt-out', () => {
  // Tolerant of whitespace, strict about the rule: the accessibility contract
  // travels with the asset instead of depending on the embedding page.
  const REDUCED_MOTION =
    /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{\s*\*\s*\{\s*animation\s*:\s*none\s*!important\s*;?\s*\}\s*\}/;

  for (const festival of FESTIVALS) {
    assert.match(readOrnament(festival), REDUCED_MOTION, `${festival.id} ornament`);
  }
});

test('no ornament uses a hex outside the approved palette', () => {
  for (const festival of FESTIVALS) {
    for (const hex of hexesIn(readOrnament(festival))) {
      assert.ok(APPROVED_HEXES.has(hex), `${festival.id} uses unapproved colour ${hex}`);
    }
  }
});

test('the tricolour exception is confined to the national-day ornament', () => {
  for (const festival of FESTIVALS) {
    const found = hexesIn(readOrnament(festival)).filter((h) => TRICOLOUR_HEXES.includes(h));
    if (festival.id === 'independence') {
      assert.deepEqual([...new Set(found)].sort(), [...TRICOLOUR_HEXES].sort());
    } else {
      assert.deepEqual(found, [], `${festival.id} must not use the tricolour`);
    }
  }
});

test('every ornament shares the tagline lockup viewBox so it overlays 1:1', () => {
  for (const festival of FESTIVALS) {
    assert.match(
      readOrnament(festival),
      /viewBox="0 0 1000 315\.361"/,
      `${festival.id} ornament`,
    );
  }
});

test('the mourning ornament draws nothing', () => {
  // The ink treatment comes from variant selection, not from this overlay.
  const svg = readOrnament(FESTIVALS.find((f) => f.id === 'mourning'));
  const stripped = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.equal(/<(path|circle|rect|g|line|polygon|ellipse|text|image|use)\b/.test(stripped), false);
});
