'use client';

/**
 * Per-user dark mode.
 *
 * THREE VALUES, NOT A COLOUR PICKER
 *
 * `'light' | 'dark' | 'system'` and nothing else. The identity document's rule
 * 7 is "light and dark mode only" — the palette is the brand, so a user-chosen
 * accent is a rebrand nobody reviewed. Widening this union is a brand change,
 * not a feature flag.
 *
 * `'system'` is the default and is deliberately distinct from whichever of
 * light/dark it currently resolves to: a user who picked `'system'` in June
 * should follow the OS into dark in December, and collapsing the two on write
 * silently converts a preference into a snapshot.
 *
 * Tailwind is configured `darkMode: ['class']`, so the entire mechanism is one
 * class on <html>. There is no CSS-variable juggling here and there must not
 * be — `src/app/brand.css` already defines both palettes.
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'easyfix.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Anything else in localStorage (stale value, hand-edited key) is ignored. */
function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Pre-paint theme application.
 *
 * WITHOUT THIS, EVERY LOAD FLASHES LIGHT.
 *
 * The hook below can only read localStorage after hydration, which is several
 * hundred milliseconds after first paint. A dark-mode user would see a full
 * white page, then a snap to dark, on every single navigation that reloads the
 * document — the flash of incorrect theme. This IIFE runs synchronously in
 * <head>, before the browser paints anything, so the correct class is already
 * on <html> when the first pixel lands.
 *
 * Intended for a `<script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />`
 * in layout.tsx. It must stay synchronous and inline: `defer`, `async`, or an
 * external file all reintroduce the flash by definition.
 *
 * The try/catch is not defensive padding — localStorage throws outright when
 * cookies are blocked or in some private-browsing modes, and an uncaught throw
 * in a <head> script blocks the rest of the document.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=t==='dark'||((t===null||t==='system')&&window.matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export type UseThemeResult = {
  /** The stored preference, including `'system'`. */
  theme: Theme;
  /** What `theme` currently means on this device. */
  resolved: ResolvedTheme;
  setTheme: (next: Theme) => void;
};

export function useTheme(): UseThemeResult {
  /*
   * Both pieces of state start at their SSR-safe constants and are corrected
   * in an effect. Reading localStorage or matchMedia during render would throw
   * on the server and, on the client, would produce markup that disagrees with
   * what the server sent — a hydration mismatch. THEME_INIT_SCRIPT is what
   * makes the brief disagreement invisible: the class is already correct on
   * <html>, so nothing repaints when these settle.
   */
  const [theme, setThemeState] = useState<Theme>('system');
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) setThemeState(stored);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    setSystemDark(mq.matches);

    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  /*
   * The class is driven from `resolved` in an effect rather than inside
   * setTheme, so an OS-level switch while the tab is open is honoured too —
   * that is the whole point of the `'system'` option.
   */
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked: the choice still applies for this session.
    }
  }, []);

  return { theme, resolved, setTheme };
}
