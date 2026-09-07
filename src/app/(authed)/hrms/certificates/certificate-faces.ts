/* ════════════════════════════════════════════════════════════════════════════
 * The four faces the certificate is set in, and the metrics the preview places
 * them with.
 *
 * ─── WHY THE BYTES ARE VENDORED, NOT PULLED FROM GOOGLE FONTS ───────────────
 *
 * These are the SAME .ttf files EasyFix_Backend embeds — `assets/fonts/` there,
 * `fonts/` here, byte-for-byte. That is the whole point. The preview's job is to
 * predict a document rendered somewhere else, and it predicts it by measuring
 * the same glyph advances the renderer measures. A Google Fonts copy would not
 * do: `Playfair Display` on fonts.google.com is the variable v2 release, whose
 * outlines and advances differ from the static PlayfairDisplay-Bold the backend
 * embeds — so the fitter would shrink a long title to a different size than the
 * PDF does, silently, which is precisely the class of bug this page exists to
 * avoid.
 *
 * It is also what `src/app/layout.tsx` already does, and for a second reason
 * documented at length there: `next/font/google` fetches from fonts.gstatic.com
 * during `next build`, and that dependency has already taken a Prod deploy down
 * once. Do not "simplify" this to `next/font/google`.
 *
 * ─── THE SANS FACE IS NOT COPIED ────────────────────────────────────────────
 *
 * `sans` reuses the IBM Plex Sans 400 woff2 the CRM already ships for its own
 * UI type rather than vendoring a fourth file. Not an assumption: rendered in
 * headless Chrome at 200px, the CRM's woff2 and the backend's
 * IBMPlexSans-Regular.ttf measure the same 66-character sample at 6318.4277px
 * — a delta of exactly 0.0000. woff2 is a lossless transform of the same
 * tables, so the two cannot fit text differently.
 *
 * ─── THE METRICS ARE READ OFF THE FILES, NOT GUESSED ────────────────────────
 *
 * `ascender` and `lineHeight` are what pdfkit uses to place a baseline:
 *
 *     doc._font.ascender        = font.ascent  / unitsPerEm * 1000
 *     doc.currentLineHeight()   = (ascender - descender) / 1000 * size
 *
 * so the numbers below are `ascent / unitsPerEm` and `(ascent - descent) /
 * unitsPerEm`, read out of these very files with fontkit — the same library
 * pdfkit measures with. They are constants because the browser exposes no API
 * for an arbitrary font's ascent, and the page needs the RENDERER's line box,
 * not the browser's.
 *
 * This is where the preview used to drift hardest: it carried Helvetica's
 * 0.718/0.925 for every run, against four faces that range from 0.851 to 1.082.
 * On the recipient name that is a baseline ~40 canvas units off, which reads as
 * the name sitting visibly high in its rule.
 *
 * Regenerate after any font change:
 *   node -e "const f=require('fontkit').openSync(FILE); \
 *            console.log(f.ascent/f.unitsPerEm, (f.ascent-f.descent)/f.unitsPerEm)"
 * ════════════════════════════════════════════════════════════════════════════ */

import localFont from 'next/font/local';

/*
 * `adjustFontFallback: false` on all three, deliberately.
 *
 * next/font otherwise synthesises a metric-adjusted local fallback and appends
 * it to `style.fontFamily`. For body copy that is exactly right — it stops the
 * page reflowing when the real face swaps in. Here it is wrong twice over: a
 * fallback face draws the wrong shapes on a document the operator is about to
 * ship, and it makes `style.fontFamily` a LIST, which the readiness check below
 * would then have to pick apart. With it off, each face is one name that is
 * either loaded or is not.
 *
 * `display: 'block'` for the same reason: never paint a substitute. The preview
 * additionally refuses to draw at all until `document.fonts` confirms the faces,
 * so this is the belt to that pair of braces.
 */
const serifBoldFace = localFont({
  src: './fonts/PlayfairDisplay-Bold.ttf',
  weight: '700',
  style: 'normal',
  display: 'block',
  adjustFontFallback: false,
});

const sansBoldFace = localFont({
  src: './fonts/IBMPlexSans-Bold.ttf',
  weight: '700',
  style: 'normal',
  display: 'block',
  adjustFontFallback: false,
});

const scriptFace = localFont({
  src: './fonts/GreatVibes-Regular.ttf',
  weight: '400',
  style: 'normal',
  display: 'block',
  adjustFontFallback: false,
});

/* The UI face, reached by relative path so there is one copy of the bytes. */
const sansFace = localFont({
  src: '../../../fonts/ibm-plex-sans-400.woff2',
  weight: '400',
  style: 'normal',
  display: 'block',
  adjustFontFallback: false,
});

export type FaceKey = 'sans' | 'sansBold' | 'serifBold' | 'script';

export type Face = {
  /** The family name next/font generated for this file. */
  family: string;
  weight: number;
  /** ascent / unitsPerEm — pdfkit's `_font.ascender / 1000`. */
  ascender: number;
  /** (ascent - descent) / unitsPerEm — pdfkit's `currentLineHeight() / size`. */
  lineHeight: number;
};

/*
 * Keys are the backend STYLE table's `font` values verbatim, so a run's face
 * cannot be looked up under a name the renderer does not use.
 */
export const FACES: Record<FaceKey, Face> = {
  sans: { family: sansFace.style.fontFamily, weight: 400, ascender: 1.025, lineHeight: 1.3 },
  sansBold: { family: sansBoldFace.style.fontFamily, weight: 700, ascender: 1.025, lineHeight: 1.3 },
  serifBold: { family: serifBoldFace.style.fontFamily, weight: 700, ascender: 1.082, lineHeight: 1.333 },
  script: { family: scriptFace.style.fontFamily, weight: 400, ascender: 0.851, lineHeight: 1.252 },
};

/*
 * A CSS font shorthand per face, for `document.fonts.load` / `.check`.
 *
 * The size is arbitrary — font loading is per FACE, not per size — but the
 * weight is not: asking for `400` of a family that only ships `700` reports
 * loaded for a face the browser would then synthesise from. Each entry names
 * the weight its own file declares.
 */
export const FACE_SPECS = Object.values(FACES).map((f) => `${f.weight} 100px ${f.family}`);

/*
 * The glyphs the check has to cover. `document.fonts.load(spec, text)` only
 * loads the subset needed for `text`, and `.check(spec, text)` only answers for
 * that subset — so passing nothing asks about the default 'BESbswy', which
 * would report a face ready while the ellipsis the fitter appends, or the
 * middot in the footer line, were still absent.
 */
export const FACE_SAMPLE = 'ABCabc123·…&,.';
