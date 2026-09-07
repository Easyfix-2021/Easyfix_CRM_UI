'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/*
 * check-brand-roundtrip.mjs reads palette.ts with an INDENTATION-based regex:
 *
 *   /^\s{2}(\w+):\s*'(#[0-9A-Fa-f]{6})'/gm
 *
 * An indentation-based regex has no idea which block it is standing in, and
 * palette.ts deliberately holds several exports — `palette` (the tokens),
 * `tricolour` (kept out of palette so the token generator cannot reach it) and
 * `certificateInk`. Scanning the whole file collapsed all of them into one flat
 * map where a later key silently overwrote an earlier one.
 *
 * WHAT WENT WRONG (2026-09-07)
 *
 * Adding a `gold` key to `certificateInk` failed this check with
 *   --gold: #C99A2E but palette.gold is #B8912F
 * naming a token the change had never touched. The failure text then blamed
 * hex->HSL precision in gen-brand-css.mjs, which points at loosening a
 * tolerance in the generator — the opposite of the actual fix. It was worked
 * around by deleting the key; `tricolour.saffron` and `tricolour.green` sat in
 * the same flat map and were harmless only because no token is named saffron
 * or green.
 *
 * The script now slices to the `palette` export before scanning — the same
 * technique it already used on the light/dark token maps, where an unsliced
 * scan produced "37 phantom mismatches".
 *
 * These tests run the REAL script against a throwaway copy of the brand files,
 * because the bug lived in how it reads a file, and a paraphrase of the regex
 * would only test the paraphrase.
 */

const ROOT = path.join(__dirname, '..');
const FILES = [
  'scripts/check-brand-roundtrip.mjs',
  'src/brand/palette.ts',
  'src/brand/tokens.ts',
  'src/app/brand.css',
];

/*
 * The script derives its root from its OWN location (`import.meta.url/..`), so
 * a sandbox is a directory holding the same four files at the same relative
 * paths. Nothing under the repo is written or mutated by these tests.
 */
function sandbox(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-roundtrip-'));
  for (const rel of FILES) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  const palettePath = path.join(dir, 'src/brand/palette.ts');
  if (mutate) fs.writeFileSync(palettePath, mutate(fs.readFileSync(palettePath, 'utf8')));
  const run = spawnSync(process.execPath, [path.join(dir, 'scripts/check-brand-roundtrip.mjs')], {
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

/** Insert `key: '#hex'` as the first entry of a named export. */
function addKeyTo(exportName, key, hex) {
  return (src) => {
    const open = `export const ${exportName} = {`;
    const at = src.indexOf(open);
    assert.notEqual(at, -1, `fixture expects an \`${open}\` export in palette.ts`);
    const eol = src.indexOf('\n', at);
    return `${src.slice(0, eol + 1)}  ${key}: '${hex}',\n${src.slice(eol + 1)}`;
  };
}

/** The first key of the `palette` export, and its hex. */
function firstPaletteKey() {
  const src = fs.readFileSync(path.join(ROOT, 'src/brand/palette.ts'), 'utf8');
  const start = src.indexOf('export const palette = {');
  const block = src.slice(start, src.indexOf('} as const;', start));
  const m = /^ {2}(\w+):\s*'(#[0-9A-Fa-f]{6})'/m.exec(block);
  assert.ok(m, 'fixture expects at least one key in the palette export');
  return { key: m[1], hex: m[2] };
}

test('the unmodified repo passes, so the sandbox is a faithful copy', () => {
  /*
   * Runs first on purpose. Every assertion below reads a non-zero exit as
   * meaningful, and that only holds if a clean tree exits 0 in here.
   */
  const { status, out } = sandbox(null);
  assert.equal(status, 0, `a clean sandbox must pass:\n${out}`);
  assert.match(out, /tokens match their palette hex exactly/);
});

test('a key in another export no longer resolves as a palette key', () => {
  /*
   * The regression proper. `gold` exists in `palette`; before the slice, a
   * `gold` in `certificateInk` overwrote it and the check failed naming a
   * token the edit never touched.
   */
  const { status, out } = sandbox(addKeyTo('certificateInk', 'gold', '#C99A2E'));
  assert.equal(status, 0, `certificateInk.gold must not shadow palette.gold:\n${out}`);
  assert.doesNotMatch(out, /--gold:/, 'the gold token must not be reported at all');
});

test('the same holds for the tricolour export, which already carries such keys', () => {
  /*
   * tricolour.saffron / .green are in the file today and are safe only because
   * no token happens to share those names. Naming a key that DOES collide
   * proves the protection is structural rather than accidental.
   */
  const { key, hex } = firstPaletteKey();
  const wrong = hex === '#010203' ? '#040506' : '#010203';
  const { status, out } = sandbox(addKeyTo('tricolour', key, wrong));
  assert.equal(status, 0, `tricolour.${key} must not shadow palette.${key}:\n${out}`);
});

test('POSITIVE CONTROL — a genuinely wrong palette hex still fails', () => {
  /*
   * Without this, scoping the parser to nothing at all would pass every test
   * above: a checker that resolves no keys reports no mismatches. This is what
   * separates "stopped reading the wrong export" from "stopped reading".
   */
  const { key, hex } = firstPaletteKey();
  const wrong = hex === '#010203' ? '#040506' : '#010203';
  const { status, out } = sandbox((src) => {
    const start = src.indexOf('export const palette = {');
    const end = src.indexOf('} as const;', start);
    const block = src.slice(start, end);
    return src.slice(0, start) + block.replace(`${key}: '${hex}'`, `${key}: '${wrong}'`) + src.slice(end);
  });
  assert.equal(status, 1, `corrupting palette.${key} must fail the check:\n${out}`);
  assert.match(out, new RegExp(`palette\\.${key} is ${wrong}`, 'i'));
});

test('POSITIVE CONTROL — the check still resolves a real number of tokens', () => {
  /*
   * The script has its own "checked nothing" guard, but that fires only at
   * zero. A slice that silently captured two or three keys would still exit 0
   * with a cheerful message, so assert the count is in the right order of
   * magnitude rather than merely non-zero.
   */
  const { out } = sandbox(null);
  const m = /brand:roundtrip — (\d+) tokens match/.exec(out);
  assert.ok(m, `expected a token count in:\n${out}`);
  assert.ok(Number(m[1]) > 20, `expected the palette slice to yield many tokens, got ${m[1]}`);
});

test('a key defined twice inside palette is reported as duplication, not mismatch', () => {
  /*
   * The two faults need different messages because they send the reader to
   * different files. A wrong hex points at the generator's precision; a
   * duplicate key points here, at a line that is silently unreachable.
   */
  const { key, hex } = firstPaletteKey();
  const wrong = hex === '#010203' ? '#040506' : '#010203';
  const { status, out } = sandbox(addKeyTo('palette', key, wrong));
  assert.equal(status, 1, `a duplicate palette key must fail:\n${out}`);
  assert.match(out, /defined more than once/);
  assert.doesNotMatch(
    out,
    /precision in scripts\/gen-brand-css\.mjs is too low/,
    'a duplicate key must not be blamed on generator precision',
  );
});
