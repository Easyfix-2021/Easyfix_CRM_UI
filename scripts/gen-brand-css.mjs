/**
 * Generate src/app/brand.css from src/brand/tokens.ts.
 *
 * WHY A GENERATOR AND NOT HAND-WRITTEN CSS
 *
 * The brand identity is authored in hex — that is how the document states it,
 * how the mobile app's palette states it, and how a designer reads it. But
 * Tailwind consumes these as `hsl(var(--token))`, and that form is what makes
 * `bg-primary/10` and `border-border/40` work; a hex-valued custom property
 * cannot support an alpha modifier at all. Roughly 500 class usages in this app
 * already depend on that.
 *
 * So: author hex, consume HSL triplets, and let this script be the only place
 * the two forms meet. The alternative — hand-maintaining HSL triplets — means
 * every future rebrand is a manual colour-space conversion done 60+ times, and
 * a single fat-fingered digit is a colour nobody can trace back to the brand.
 *
 *   npm run brand:gen      write src/app/brand.css
 *   npm run brand:verify   regenerate in memory and diff — fails on drift
 *
 * The output IS committed. A build step that must run before the CSS is valid
 * would break `next dev` for anyone who forgot it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT = join(root, 'src/app/brand.css');

/*
 * tokens.ts is TypeScript, and this script is plain Node with no build step, so
 * the values are lifted by evaluating the two modules' object literals rather
 * than importing them. Narrow and deliberate: it reads `export const palette`
 * and the two token maps, and would rather throw than guess.
 */
function evalModuleObject(file, name, palette) {
  const src = readFileSync(join(root, file), 'utf8');
  const start = src.indexOf(`const ${name}`);
  if (start === -1) throw new Error(`${name} not found in ${file}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error(`unbalanced braces reading ${name} from ${file}`);
  const body = src.slice(open, end + 1)
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  // `p` is tokens.ts's alias for the palette import. Bound explicitly rather
  // than evaluated from a module graph, so this script needs no build step.
  return Function('p', `"use strict"; return (${body});`)(palette);
}

const paletteObj = evalModuleObject('src/brand/palette.ts', 'palette', undefined);

/**
 * Hex → space-separated HSL triplet, e.g. '#C42430' → '355.71 68.87% 45.29%'.
 *
 * TWO DECIMALS, NOT WHOLE NUMBERS — this was measured, not assumed.
 *
 * Rounding to integers (Tailwind's own house style) drifts brand red from
 * #C42430 to #C2242E, ink-900 from #171B1F to #181C20, and gold from #C99A2E
 * to #C8992D. Small individually, but it means the token in the browser is NOT
 * the colour in the identity document — and the whole point of this pipeline is
 * that it is. Two decimals round-trips every brand value byte-exactly, verified
 * by `npm run brand:roundtrip`.
 *
 * The cost is a slightly noisier CSS file. That is the right trade: nobody
 * reads brand.css, and everybody sees the red.
 */
function hexToHslTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }

  const trim = (n) => String(Number(n.toFixed(2)));
  return `${trim(h * 360)} ${trim(s * 100)}% ${trim(l * 100)}%`;
}

function block(selector, map, radius) {
  const lines = Object.entries(map)
    .map(([k, v]) => `  --${k}: ${hexToHslTriplet(v)};`);
  if (radius) lines.push(`  --radius: ${radius};`);
  return `${selector} {\n${lines.join('\n')}\n}`;
}

function build() {
  const light = evalModuleObject('src/brand/tokens.ts', 'light', paletteObj);
  const dark = evalModuleObject('src/brand/tokens.ts', 'dark', paletteObj);
  const radiusSrc = readFileSync(join(root, 'src/brand/tokens.ts'), 'utf8');
  const radius = (/export const radius = '([^']+)'/.exec(radiusSrc) || [])[1] || '0.75rem';

  return `/*
 * GENERATED FILE — do not edit.
 *
 * Source: src/brand/tokens.ts (semantic map) over src/brand/palette.ts (the
 * brand primitives). Regenerate with \`npm run brand:gen\`; \`npm run
 * brand:verify\` fails the build if this file has drifted from its source.
 *
 * Values are space-separated HSL triplets because Tailwind consumes them as
 * hsl(var(--token)) — that is what lets \`bg-primary/10\` and \`border-border/40\`
 * work. Authoring happens in hex, in palette.ts.
 *
 * Deliberately NOT wrapped in @layer base: an @import gives this file its own
 * PostCSS scope, where \`@layer base\` has no matching \`@tailwind base\` and the
 * build fails outright. Custom-property declarations need no layering — they
 * are definitions, not rules competing on specificity.
 */
${block(':root', light, radius)}

${block('.dark', dark, null)}
`;
}

const css = build();
const mode = process.argv[2];

if (mode === '--verify') {
  const current = readFileSync(OUT, 'utf8');
  if (current !== css) {
    console.error('brand.css is out of date with src/brand/tokens.ts — run `npm run brand:gen`');
    process.exit(1);
  }
  console.log('brand.css matches its source');
} else {
  writeFileSync(OUT, css);
  const n = Object.keys(evalModuleObject('src/brand/tokens.ts', 'light', paletteObj)).length;
  console.log(`brand.css written — ${n} tokens, light + dark`);
}
