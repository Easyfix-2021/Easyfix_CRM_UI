'use strict';

/*
 * check-brand-tokens — the regexes behind `npm run check:brand`.
 *
 * WHY A GUARD SCRIPT NEEDS ITS OWN TESTS
 *
 * This checker's whole job is to fail a build, so its two failure modes are
 * asymmetric and both expensive:
 *
 *   FALSE POSITIVE — it flags `bg-primary` or a hex sitting inside a comment,
 *     and the next person "fixes" correct code, or (much more likely) adds the
 *     file to the allowlist and the guard quietly stops guarding.
 *   FALSE NEGATIVE — it reports zero and everyone believes the brand system is
 *     clean while raw `bg-slate-100` keeps landing. A guard that under-reports
 *     is worse than no guard, because it is trusted.
 *
 * The comment-stripping ORDER is the sharpest edge here, and it is invisible.
 * Strip `/* … *\/` blocks before `//` lines and a line comment containing a
 * stray `/*` swallows every line up to the next `*\/` — hundreds of lines of
 * real code drop out of the scan and their violations disappear silently. The
 * ordering test below is the only thing that would ever catch that.
 *
 * These assertions run against the exported predicates, not the CLI, so they
 * pin behaviour independently of what happens to be in src/ today.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const B = require('../scripts/check-brand-tokens.js');

/** Kinds reported for one line of TSX from an ordinary (non-allowlisted) file. */
const kinds = (src, opts = {}) =>
  B.scanSource(src, { file: '/nowhere/Component.tsx', ...opts }).map((f) => f.kind);

const flags = (src, kind, opts) => kinds(src, opts).includes(kind);

// ─── raw Tailwind palette utilities — the big one ─────────────────────────

test('a raw Tailwind palette class is a violation; a semantic token class is not', () => {
  assert.ok(flags('<div className="bg-slate-500" />', B.KINDS.PALETTE));
  assert.ok(flags('<div className="text-red-600" />', B.KINDS.PALETTE));
  assert.ok(flags('<div className="border-gray-200" />', B.KINDS.PALETTE));

  // Semantic classes carry no hue/shade pair — they resolve through the theme.
  assert.equal(flags('<div className="bg-primary" />', B.KINDS.PALETTE), false);
  assert.equal(flags('<div className="text-muted-foreground" />', B.KINDS.PALETTE), false);
  assert.equal(flags('<div className="border-border bg-card" />', B.KINDS.PALETTE), false);
  // `text-black` carries no hue/shade pair and is not a palette reference.
  assert.equal(flags('<div className="text-black" />', B.KINDS.PALETTE), false);
});

test('OPAQUE bg-white is a violation; frost bg-white/N is not', () => {
  /*
   * `bg-white` was invisible to this guard until 2026-08-18 — the palette rule
   * matches a hue plus a NUMERIC shade, and `bg-white` has neither, so 122 of
   * them sat in the codebase while the guard reported zero. It is a surface
   * that cannot follow the theme: it stays white while the page goes dark.
   */
  assert.ok(flags('<div className="bg-white p-3" />', B.KINDS.PALETTE));
  assert.ok(flags('<div className="rounded bg-white shadow" />', B.KINDS.PALETTE));

  /*
   * Alpha white is the FROST pattern — white over a coloured or dark ground,
   * correct in both themes. It must never be flagged, or a sweep would convert
   * it to bg-card/N and dissolve it into the surface underneath in dark mode.
   */
  assert.equal(flags('<div className="bg-white/10" />', B.KINDS.PALETTE), false);
  assert.equal(flags('<div className="bg-white/70 ring-1" />', B.KINDS.PALETTE), false);

  /*
   * A frost element that intensifies on interaction carries both forms on one
   * line. Flagging the opaque half alone would push someone to convert it and
   * flip the control white -> ink-700 mid-hover.
   */
  assert.equal(flags('<button className="bg-white/90 hover:bg-white" />', B.KINDS.PALETTE), false);
});

test('variant-prefixed palette classes still count', () => {
  assert.ok(flags('<div className="hover:bg-slate-100" />', B.KINDS.PALETTE));
  assert.ok(flags('<div className="md:dark:text-zinc-400" />', B.KINDS.PALETTE));
  assert.ok(flags('<div className="from-sky-50 via-blue-500 to-indigo-900" />', B.KINDS.PALETTE));
});

test('a lookalike that is not a palette shade is left alone', () => {
  // 999 is not a Tailwind shade; `slate` alone is not a colour reference.
  assert.equal(flags('<div className="bg-slate-999" />', B.KINDS.PALETTE), false);
  assert.equal(flags("const label = 'slate-500 roof tiles';", B.KINDS.PALETTE), false);
});

// ─── the 12px type floor ──────────────────────────────────────────────────

test('arbitrary type below 12px is a violation; 12px and above is fine', () => {
  assert.ok(flags('<span className="text-[10px]" />', B.KINDS.FLOOR));
  assert.ok(flags('<span className="text-[11px]" />', B.KINDS.FLOOR));
  assert.equal(flags('<span className="text-[12px]" />', B.KINDS.FLOOR), false);
  assert.equal(flags('<span className="text-[14px]" />', B.KINDS.FLOOR), false);
  assert.equal(flags('<span className="text-xs" />', B.KINDS.FLOOR), false);
});

test('two sub-floor sizes on one line report twice (the /g regex resets per line)', () => {
  const found = kinds('<i className="text-[10px] md:text-[11px]" />')
    .filter((k) => k === B.KINDS.FLOOR);
  assert.equal(found.length, 2);
});

// ─── weights above 600 ────────────────────────────────────────────────────

test('font weights above 600 are violations; 600 and below are not', () => {
  assert.ok(flags('<h1 className="font-bold" />', B.KINDS.WEIGHT));
  assert.ok(flags('<h1 className="font-extrabold" />', B.KINDS.WEIGHT));
  assert.ok(flags('<h1 className="font-black" />', B.KINDS.WEIGHT));
  assert.ok(flags('style={{ fontWeight: 700 }}', B.KINDS.WEIGHT));
  assert.ok(flags("style={{ fontWeight: 'bold' }}", B.KINDS.WEIGHT));

  assert.equal(flags('<h1 className="font-medium" />', B.KINDS.WEIGHT), false);
  assert.equal(flags('<h1 className="font-semibold" />', B.KINDS.WEIGHT), false);
  assert.equal(flags('style={{ fontWeight: 600 }}', B.KINDS.WEIGHT), false);
});

// ─── colour literals ──────────────────────────────────────────────────────

test('hex literals are violations in every length Tailwind/CSS accepts', () => {
  assert.ok(flags("const c = '#fff';", B.KINDS.HEX));
  assert.ok(flags("const c = '#C42430';", B.KINDS.HEX));
  assert.ok(flags("const c = '#C42430ff';", B.KINDS.HEX));
});

test('rgb/rgba/hsl literals are violations, but hsl(var(--token)) is NOT', () => {
  assert.ok(flags("boxShadow: '0 4px 16px rgba(15,23,42,0.08)',", B.KINDS.FUNC));
  assert.ok(flags("cursor={{ fill: 'hsl(210, 40%, 96%)' }}", B.KINDS.FUNC));

  // Token consumption at the CSS layer — the pattern the whole system is
  // built on (brand.css stores HSL triplets for exactly this).
  assert.equal(
    flags('  background-color: hsl(var(--card));', B.KINDS.FUNC, { css: true }),
    false,
  );
  assert.equal(
    flags('  box-shadow: 2px 0 4px -2px hsl(var(--ink-900) / 0.08);', B.KINDS.FUNC, { css: true }),
    false,
  );
});

// ─── comments are not code ────────────────────────────────────────────────

test('a hex inside a comment is NOT a violation', () => {
  assert.deepEqual(kinds('// brand red is #C42430'), []);
  assert.deepEqual(kinds('/* brand red is #C42430 */'), []);
  assert.deepEqual(kinds('/**\n * red500: #C42430 — header, primary action\n */'), []);
  // …and a doc comment naming the banned classes doesn't trip the palette rule.
  assert.deepEqual(kinds('// never write bg-slate-100 or text-red-600 here'), []);
});

test('a CSS comment is stripped, and a url() with // survives', () => {
  assert.deepEqual(kinds('/* was #C42430 */', { css: true }), []);
  // If the JS line-comment pass ran over CSS, `//x/y.png…` would be eaten and
  // the real hex after it would vanish from the scan.
  assert.ok(
    flags(
      '.a { background: url(https://cdn.example/y.png); border: 1px solid #C42430; }',
      B.KINDS.HEX,
      { css: true },
    ),
  );
});

test('ORDERING: a line comment containing /* must not swallow the code below it', () => {
  // Strip block comments first and everything up to the next `*/` disappears —
  // including the two genuine violations below — and the guard reports clean.
  const src = [
    '// see the /* token block */ in brand.css',
    'const c = "#C42430";',
    'const cls = "bg-slate-500";',
  ].join('\n');
  const found = kinds(src);
  assert.ok(found.includes(B.KINDS.HEX), 'hex below a line comment must still be reported');
  assert.ok(found.includes(B.KINDS.PALETTE), 'palette class below a line comment must still be reported');
});

test('a protocol URL is not mistaken for a line comment', () => {
  assert.ok(flags("const u = 'https://x.test/#C42430';", B.KINDS.HEX));
});

// ─── the allowlist ────────────────────────────────────────────────────────

test('src/brand/palette.ts may hold colour literals; nothing else may', () => {
  const paletteFile = path.join(__dirname, '..', 'src', 'brand', 'palette.ts');
  assert.ok(B.COLOUR_SOURCE_OF_TRUTH.has(paletteFile), 'palette.ts must be the allowlisted seam');

  const line = "  red500: '#C42430',";
  assert.deepEqual(B.scanSource(line, { file: paletteFile }), []);
  assert.ok(B.scanSource(line, { file: '/nowhere/Other.tsx' }).length > 0);
});

test('only Logo.tsx may wire a logo asset path into <Image>', () => {
  const line = '<Image src="/logo-full.png" alt="EasyFix" width={139} height={34} />';
  assert.deepEqual(B.scanSource(line, { file: B.LOGO_COMPONENT }), []);
  assert.ok(flags(line, B.KINDS.LOGO));
});

test('the allowlist exempts colour literals only — palette.ts is still held to the rest', () => {
  const paletteFile = path.join(__dirname, '..', 'src', 'brand', 'palette.ts');
  const found = B.scanSource('<h1 className="font-bold text-[10px]" />', { file: paletteFile })
    .map((f) => f.kind);
  assert.ok(found.includes(B.KINDS.WEIGHT));
  assert.ok(found.includes(B.KINDS.FLOOR));
});

// ─── findings shape (what the CLI table prints) ───────────────────────────

test('a finding carries a 1-based line number and the trimmed source line', () => {
  const [f] = B.scanSource('\n\n  <div className="bg-slate-500" />\n', { file: '/x/A.tsx' });
  assert.equal(f.line, 3);
  assert.equal(f.kind, B.KINDS.PALETTE);
  assert.equal(f.text, '<div className="bg-slate-500" />');
});

test('clean source produces no findings at all', () => {
  const src = [
    'export function Badge() {',
    '  return <span className="rounded bg-primary/10 px-2 text-xs font-medium text-primary">New</span>;',
    '}',
  ].join('\n');
  assert.deepEqual(kinds(src), []);
});
