/**
 * Semantic tokens — what components actually mean, mapped onto brand primitives.
 *
 * NO COLOUR LITERALS LIVE HERE. Every value is a `palette.*` reference. This
 * file answers "what is a border?", `palette.ts` answers "what is ink-100?",
 * and the two questions stay separable — which is what makes a rebrand a
 * one-file edit.
 *
 * `npm run brand:gen` turns this into `src/app/brand.css` as space-separated
 * HSL triplets, because Tailwind's `hsl(var(--token))` pipeline needs that form
 * for the `/10` and `/40` alpha modifiers the app already relies on in ~500
 * places. Authoring stays hex; consumption stays HSL; the generator bridges.
 *
 * The 22 pre-existing token names are preserved EXACTLY. That is deliberate:
 * every `bg-card`, `text-muted-foreground` and `border-border` in the codebase
 * keeps working untouched, and only the values behind them move. The additions
 * below (ramps + meaning families) exist so the ~750 raw `slate-*`/`sky-*`
 * utilities have somewhere on-brand to land.
 */

import { palette as p } from './palette';

export type TokenMap = Record<string, string>;

/*
 * LIGHT — the identity doc says "light designed first" (rule 7).
 */
const light: TokenMap = {
  background: p.ink50,
  foreground: p.ink900,

  card: p.white,
  'card-foreground': p.ink900,

  popover: p.white,
  'popover-foreground': p.ink900,

  // Brand red is the action colour and is INVARIANT across modes — it is the
  // one thing a technician and an ops user must recognise identically.
  primary: p.red500,
  'primary-foreground': p.white,
  'primary-pressed': p.red600,

  secondary: p.ink100,
  'secondary-foreground': p.ink900,

  muted: p.ink100,
  'muted-foreground': p.ink500,

  // Was a warm orange with no identity counterpart. red-50 is the softest
  // on-brand wash, which is what `accent` was actually being used for.
  accent: p.red50,
  'accent-foreground': p.red700,

  destructive: p.red600,
  'destructive-foreground': p.white,

  border: p.ink100,
  input: p.ink100,
  ring: p.red500,

  // The CRM's surface differentiator per the brand kit, and the identity doc's
  // stated use for ink-900: "headings, dark surfaces".
  sidebar: p.ink900,
  'sidebar-foreground': p.ink300,
  'sidebar-accent': p.ink700,

  // ── Ramps — the landing ground for the raw-utility sweep ─────────────────
  'ink-900': p.ink900,
  'ink-700': p.ink700,
  'ink-500': p.ink500,
  'ink-300': p.ink300,
  'ink-100': p.ink100,
  'ink-50': p.ink50,

  'brand-50': p.red50,
  'brand-100': p.red100,
  'brand-500': p.red500,
  'brand-600': p.red600,
  'brand-700': p.red700,

  // ── Meaning families — solid / tint / on-tint text ───────────────────────
  success: p.success,
  'success-tint': p.successTint,
  'success-strong': p.successText,

  warning: p.warning,
  'warning-tint': p.warningTint,
  'warning-strong': p.warningText,

  // Urgent reuses the red ramp by brand rule — there is no second error palette.
  urgent: p.red600,
  'urgent-tint': p.red100,
  'urgent-strong': p.red700,

  info: p.blue500,
  'info-tint': p.blue100,
  'info-strong': p.blue700,
  'info-deep': p.blue900,

  // Gold is grade and rewards ONLY (rule 3). Never on red, never a large fill.
  gold: p.gold,
  'gold-tint': p.goldTint,
  'gold-strong': p.goldText,

  neutral: p.ink500,
  'neutral-tint': p.ink100,
  'neutral-strong': p.ink700,
};

/*
 * DARK — surfaces invert down the ink ramp; brand red does not move.
 *
 * Tints flip to their deep counterparts so text-on-tint keeps its contrast:
 * a success chip is successText-on-successTint in light, and successTint-on-
 * successText in dark. The pair swaps rather than being re-picked, so the two
 * modes cannot drift apart.
 */
const dark: TokenMap = {
  background: p.ink900,
  foreground: p.ink50,

  card: p.ink700,
  'card-foreground': p.ink50,

  popover: p.ink700,
  'popover-foreground': p.ink50,

  primary: p.red500,
  'primary-foreground': p.white,
  'primary-pressed': p.red600,

  secondary: p.ink700,
  'secondary-foreground': p.ink50,

  muted: p.ink700,
  'muted-foreground': p.ink300,

  accent: p.red700,
  'accent-foreground': p.red100,

  destructive: p.red600,
  'destructive-foreground': p.white,

  border: p.ink700,
  input: p.ink700,
  ring: p.red500,

  /*
   * ink-900, the SAME value as the dark page background — not a darker
   * invented shade.
   *
   * A one-step-darker sidebar reads better, but it needs a colour the identity
   * document does not contain, and rule 10 is "no colour that is not on this
   * page". The separation is carried by the sidebar's border instead, which is
   * exactly how light mode already does it. Inventing an ink-950 here would
   * have been the first crack in the rule this whole pipeline exists to keep.
   */
  sidebar: p.ink900,
  'sidebar-foreground': p.ink300,
  'sidebar-accent': p.ink700,

  'ink-900': p.ink50,
  'ink-700': p.ink100,
  'ink-500': p.ink300,
  'ink-300': p.ink500,
  'ink-100': p.ink700,
  'ink-50': p.ink900,

  'brand-50': p.red700,
  'brand-100': p.red600,
  'brand-500': p.red500,
  'brand-600': p.red600,
  'brand-700': p.red100,

  success: p.success,
  'success-tint': p.successText,
  'success-strong': p.successTint,

  warning: p.warning,
  'warning-tint': p.warningText,
  'warning-strong': p.warningTint,

  urgent: p.red600,
  'urgent-tint': p.red700,
  'urgent-strong': p.red100,

  info: p.blue500,
  'info-tint': p.blue900,
  'info-strong': p.blue100,
  'info-deep': p.blue100,

  gold: p.gold,
  'gold-tint': p.goldText,
  'gold-strong': p.goldTint,

  neutral: p.ink300,
  'neutral-tint': p.ink700,
  'neutral-strong': p.ink100,
};

/* Card and button radius 12 per the identity doc's shape section. */
export const radius = '0.75rem';

export const tokens = { light, dark };
