import { AlertTriangle, Cake, Info, Megaphone, PartyPopper, Pin } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { detectCelebration, type CelebrationKind } from './NoticeCelebration';

/*
 * Notice card themes.
 *
 * The notice modal used to hard-code one look. A maintenance warning, a
 * birthday and a leave-policy update are three different kinds of message, and
 * dressing all three in the same celebratory gradient makes the urgent one read
 * as decoration. So the card's skin is data, chosen per notice.
 *
 * WHAT PICKS THE THEME (in priority order):
 *   1. Celebration keywords in the TITLE — birthdays/anniversaries are obvious
 *      from the headline and ops should not have to tag them.
 *   2. The notice's CATEGORY NAME — the field ops already fills in on every
 *      notice. This is the backbone: no schema change, no new decision at
 *      compose time, and re-categorising a notice re-skins it.
 *   3. Fallback: 'aurora', the house style.
 *
 * A dedicated `theme` column was considered and rejected: it asks an operator
 * to make a design decision on every notice, which in practice means it is
 * ignored or set wrong. Category already carries the intent.
 *
 * The motion itself lives in globals.css (`nb-aurora`, `nb-sweep`, …) so all
 * themes share one sheet and one prefers-reduced-motion switch.
 *
 * TOKEN RULE FOR EVERY SKIN BELOW. brand.css defines each token twice, under
 * `:root` and under `.dark`, and most of them INVERT — their lightness crosses
 * the 50% mid-point between the two themes. A skin here is a plate plus a fixed
 * white/tinted glyph, so an inverting plate under a foreground that does NOT
 * move is the DialogHeader bug: `--ink-900` is hsl(210 14.81% 10.59%) in light
 * (17.31:1 against white) and hsl(200 15.79% 96.27%) in dark (1.08:1), which is
 * white-on-near-white. Commit 497cd6e fixed that by moving to --sidebar /
 * --sidebar-accent, which are STABLE — one value in both themes, and that value
 * is exactly the light-mode ink pair — so the light theme stayed pixel-identical
 * and dark went 1.08 -> 17.31. Plates here therefore use either a stable token,
 * or an inverting token whose foreground inverts WITH it.
 */

export type NoticeThemeKey = 'aurora' | 'spotlight' | 'celebration' | 'quiet';

export type NoticeTheme = {
  key: NoticeThemeKey;
  /** Hero band classes. `null` = the light 'quiet' card, which has no hero. */
  heroClass: string | null;
  /** Medallion glyph + its tint. */
  icon: LucideIcon;
  iconClass: string;
  /** Primary (OK) button tint. */
  buttonClass: string;
  /** Left accent rail — only used by the light 'quiet' card. */
  railClass: string;
  /** Confetti variant to play, when the headline earns one. */
  celebration: CelebrationKind;
};

const AURORA: Omit<NoticeTheme, 'celebration'> = {
  key: 'aurora',
  /* (a) STABLE SURFACE. Was `bg-ink-900`; the medallion below sits INSIDE this
     hero carrying `text-white`, so this is the DialogHeader pairing exactly —
     17.31:1 in light, 1.08:1 in dark. --sidebar holds hsl(210 14.81% 10.59%) in
     BOTH themes, which is --ink-900's light value verbatim, so the light theme
     renders identically and dark stops washing the glyph out. The lint rule
     never saw this one (plate and glyph are different properties here, joined
     only at render), but it is the same defect as the button on QUIET. */
  heroClass: 'nb-aurora bg-sidebar',
  icon: Megaphone,
  iconClass: 'text-white',
  buttonClass: 'bg-primary hover:bg-brand-600 text-white',
  railClass: 'bg-info',
};

const SPOTLIGHT: Omit<NoticeTheme, 'celebration'> = {
  key: 'spotlight',
  heroClass: 'nb-sweep bg-gradient-to-br from-destructive to-warning',
  icon: AlertTriangle,
  iconClass: 'text-white',
  buttonClass: 'bg-destructive hover:bg-destructive-strong text-white',
  railClass: 'bg-destructive',
};

const CELEBRATION: Omit<NoticeTheme, 'celebration'> = {
  key: 'celebration',
  heroClass: 'bg-gradient-to-br from-gold via-destructive to-gold-strong',
  icon: PartyPopper,
  iconClass: 'text-warning-tint',
  /* (c) HOVER-ONLY. The resting plate `bg-gold` is stable (48.43% in both
     themes) so white holds there; only the hover inverted. --gold-strong is
     21.96% in light (8.06:1 under white) and 91.57% in dark (1.12:1) — the
     label vanished the moment the pointer landed. There is no stable dark-gold
     twin to swap in (the stable set has gold at 48.43% and nothing below it in
     this hue), so the hover keeps its token and gains a dark override:
     --gold-tint is --gold-strong's mirror, 91.57% -> 21.96%, so in dark it IS
     the light-mode gold-strong swatch and the hover measures 8.06:1 there too.
     Light theme unchanged — a `dark:` variant emits nothing under :root. */
  buttonClass: 'bg-gold hover:bg-gold-strong dark:hover:bg-gold-tint text-white',
  railClass: 'bg-gold',
};

const QUIET: Omit<NoticeTheme, 'celebration'> = {
  key: 'quiet',
  heroClass: null,
  icon: Info,
  iconClass: 'text-ink-500',
  /* (a) STABLE SURFACE — the 497cd6e substitution, applied verbatim. Both
     halves are exact: --ink-900 (10.59% light) and --sidebar hold the same
     hsl(210 14.81% 10.59%), --ink-700 (23.33% light) and --sidebar-accent hold
     the same hsl(212.73 9.24% 23.33%), and the sidebar pair does not move in
     dark. Light theme is pixel-identical; dark goes from 1.08:1 resting /
     1.24:1 hovered to 17.31:1 and 11.30:1 against the white label. */
  buttonClass: 'bg-sidebar hover:bg-sidebar-accent text-white',
  railClass: 'bg-info',
};

/*
 * Category-name → theme. Matched case-insensitively on a SUBSTRING, so an
 * ops-renamed category ("Urgent Alert", "System Alerts") still lands correctly
 * without a code change. Order matters: first hit wins.
 */
const CATEGORY_RULES: Array<{ re: RegExp; theme: Omit<NoticeTheme, 'celebration'> }> = [
  { re: /(alert|urgent|critical|maintenance|outage|downtime|incident)/i, theme: SPOTLIGHT },
  { re: /(celebrat|festival|birthday|award|recognition)/i, theme: CELEBRATION },
  { re: /(policy|update|hr\b|process|compliance|reminder)/i, theme: QUIET },
  { re: /(general|announcement|news)/i, theme: AURORA },
];

export function themeForNotice(notice: { title?: string | null; category_name?: string | null } | null | undefined): NoticeTheme {
  const title = notice?.title ?? '';
  const category = notice?.category_name ?? '';

  // 1. A celebratory headline always wins — it also selects the confetti kind
  //    and swaps the medallion to a cake for birthdays.
  const celebration = detectCelebration(title);
  if (celebration) {
    return {
      ...CELEBRATION,
      icon: celebration === 'birthday' ? Cake : PartyPopper,
      celebration,
    };
  }

  // 2. Category.
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(category)) return { ...rule.theme, celebration: null };
  }

  // 3. House style.
  return { ...AURORA, celebration: null };
}

/*
 * Pinned notices swap the medallion to a pin and get the shimmer headline —
 * applied on top of whatever theme was selected, so a pinned alert stays red.
 */
export function pinnedIcon(): LucideIcon {
  return Pin;
}
