/**
 * Prove every generated token still equals the brand hex it came from.
 *
 * WHY THIS EXISTS
 *
 * brand.css stores HSL triplets, the identity document states hex, and a
 * conversion sits between them. That conversion is lossy if the precision is
 * wrong: rounding to whole degrees — which is Tailwind's own house style and
 * the obvious thing to do — silently turns brand red #C42430 into #C2242E and
 * gold #C99A2E into #C8992D. Nothing errors. The app just quietly renders a
 * colour that is not the brand's.
 *
 * So this converts every token back and asserts equality with palette.ts. It is
 * the only thing standing between "we use tokens" and "our tokens are correct".
 *
 *   npm run brand:roundtrip
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function hslToHex(h, s, l) {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`.toUpperCase();
}

const paletteSrc = readFileSync(join(root, 'src/brand/palette.ts'), 'utf8');
const tokensSrc = readFileSync(join(root, 'src/brand/tokens.ts'), 'utf8');
const css = readFileSync(join(root, 'src/app/brand.css'), 'utf8');

/*
 * palette key -> hex, straight off the source of truth — and ONLY off the
 * `palette` export.
 *
 * palette.ts deliberately holds more than one export: `palette` (the tokens),
 * `tricolour` (kept out of palette so the token generator cannot reach it) and
 * `certificateInk` (the certificate document's ink). This regex is
 * indentation-based, so scanning the whole file collapses all three into one
 * flat map and a later key silently overwrites an earlier one.
 *
 * That is not theoretical. On 2026-09-07 adding a `gold` key to
 * `certificateInk` failed this check with
 *   --gold: #C99A2E but palette.gold is #B8912F
 * naming a token the change had not touched — and the old failure text then
 * blamed HSL precision in gen-brand-css.mjs, which would have led someone to
 * loosen the tolerance rather than find the shadowing.
 *
 * Same slice-before-you-scan technique the token side already uses below for
 * the light/dark maps, and for the same reason: an indentation-based regex has
 * no idea which block it is standing in.
 */
const PALETTE_OPEN = 'export const palette = {';
const paletteStart = paletteSrc.indexOf(PALETTE_OPEN);
if (paletteStart === -1) {
  console.error('brand:roundtrip could not find `export const palette = {` in src/brand/palette.ts');
  process.exit(1);
}
const paletteEnd = paletteSrc.indexOf('} as const;', paletteStart);
if (paletteEnd === -1) {
  console.error('brand:roundtrip could not find the end of the palette export in src/brand/palette.ts');
  process.exit(1);
}
const paletteBlock = paletteSrc.slice(paletteStart, paletteEnd);

const palette = {};
const duplicateKeys = [];
for (const m of paletteBlock.matchAll(/^\s{2}(\w+):\s*'(#[0-9A-Fa-f]{6})'/gm)) {
  // A key defined twice INSIDE palette is a different fault from a wrong hex,
  // and reporting it as a mismatch would send the reader to the generator.
  if (Object.prototype.hasOwnProperty.call(palette, m[1])) {
    duplicateKeys.push(`  palette.${m[1]} is defined more than once (${palette[m[1]]} then ${m[2].toUpperCase()})`);
  }
  palette[m[1]] = m[2].toUpperCase();
}

/*
 * Shadowing report. The slice above already makes the other exports harmless,
 * so this exists to NAME the collision rather than to prevent it — a key that
 * appears in both `palette` and, say, `certificateInk` is legal but is exactly
 * the shape that produced a mystifying failure before the slice existed.
 */
const shadowed = [];
for (const m of paletteSrc.matchAll(/^export const (\w+) = \{/gm)) {
  const name = m[1];
  if (name === 'palette') continue;
  const start = m.index;
  const end = paletteSrc.indexOf('} as const;', start);
  const block = paletteSrc.slice(start, end === -1 ? undefined : end);
  for (const k of block.matchAll(/^\s{2}(\w+):\s*'(#[0-9A-Fa-f]{6})'/gm)) {
    if (Object.prototype.hasOwnProperty.call(palette, k[1])) {
      shadowed.push(`  ${name}.${k[1]} shares a name with palette.${k[1]} — the palette value (${palette[k[1]]}) is the one checked`);
    }
  }
}

if (duplicateKeys.length) {
  console.error('brand:roundtrip found duplicate keys inside the palette export:');
  console.error(duplicateKeys.join('\n'));
  console.error('\nA later key overwrites an earlier one, so half the file is unreachable.');
  process.exit(1);
}

/*
 * Only the :root block, and only the `light` map that produced it.
 *
 * Both halves of that pairing matter. tokens.ts defines the same token names
 * twice — once per mode — so a scan of the whole file pairs every light token
 * with the DARK map's value and reports 37 phantom mismatches. Slice to the
 * light map, compare against :root, and the check means what it says.
 */
const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('.dark'));
const lightMap = tokensSrc.slice(
  tokensSrc.indexOf('const light'),
  tokensSrc.indexOf('const dark'),
);

let checked = 0;
const failures = [];

for (const m of lightMap.matchAll(/^\s{2}'?([\w-]+)'?:\s*p\.(\w+),/gm)) {
  const [, token, paletteKey] = m;
  const expected = palette[paletteKey];
  if (!expected) continue;
  const hit = new RegExp(`--${token}: ([\\d.]+) ([\\d.]+)% ([\\d.]+)%`).exec(rootBlock);
  if (!hit) continue;
  const got = hslToHex(Number(hit[1]), Number(hit[2]), Number(hit[3]));
  checked += 1;
  if (got !== expected) {
    failures.push(`  --${token}: ${got} but palette.${paletteKey} is ${expected}`);
  }
}

if (!checked) {
  console.error('brand:roundtrip checked nothing — the token or palette format changed');
  process.exit(1);
}

if (failures.length) {
  console.error(`${failures.length} of ${checked} tokens do not match their brand hex:`);
  console.error(failures.join('\n'));
  if (shadowed.length) {
    /*
     * Printed FIRST when it applies, because it is the cheaper explanation and
     * the one a reader will not otherwise guess. The previous version of this
     * message offered only the precision theory, which sent the reader to
     * loosen a tolerance in the generator over a name collision in this file.
     */
    console.error('\nA palette key is also defined in another export of palette.ts:');
    console.error(shadowed.join('\n'));
    console.error('Rename one of them if the two are meant to be different colours.');
  }
  console.error(
    shadowed.length
      ? '\nIf the names above are unrelated, the remaining cause is hex -> HSL precision in scripts/gen-brand-css.mjs.'
      : '\nThe hex -> HSL precision in scripts/gen-brand-css.mjs is too low.',
  );
  process.exit(1);
}

console.log(`brand:roundtrip — ${checked} tokens match their palette hex exactly`);
