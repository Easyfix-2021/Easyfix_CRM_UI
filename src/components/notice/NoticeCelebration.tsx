'use client';

import * as React from 'react';

/*
 * NoticeCelebration — the confetti / balloon burst that plays behind a notice
 * modal's hero when the headline is celebratory.
 *
 * Hand-rolled rather than pulling a confetti dependency: the effect is ~30
 * absolutely-positioned spans driven by two keyframes, so a library (and its
 * canvas + rAF loop) would cost more than the feature. Keyframes are declared
 * in a local <style> tag with `nb-` prefixed names so nothing leaks into the
 * global sheet; only one notice modal is open at a time, so at most one copy
 * is ever mounted.
 *
 * Motion is OPT-OUT for anyone who asked the OS to reduce it — the burst is
 * pure decoration, so `prefers-reduced-motion` renders nothing at all rather
 * than a degraded version.
 */

export type CelebrationKind = 'birthday' | 'party' | null;

/*
 * Keyword → animation mapping, read off the notice TITLE only (bodies are long
 * and mention "celebrate" in passing far too often to be a reliable signal).
 * Birthday wins over the generic party burst when a title says both, since it
 * is the more specific occasion.
 */
const BIRTHDAY_RE = /\b(birthdays?|b[’']?days?)\b/i;
const PARTY_RE = /(celebrat|congratulat|congrats|anniversar|\bparty\b|\bfarewell\b|\bfestival\b|\bdiwali\b|\bholi\b|new year|\bwelcome aboard\b)/i;

export function detectCelebration(title?: string | null): CelebrationKind {
  const t = String(title ?? '');
  if (BIRTHDAY_RE.test(t)) return 'birthday';
  if (PARTY_RE.test(t)) return 'party';
  return null;
}

const CONFETTI_COLORS = ['hsl(var(--gold))', 'hsl(var(--urgent))', 'hsl(var(--success))', 'hsl(var(--info))', 'hsl(var(--urgent))', 'hsl(var(--gold))', 'hsl(var(--warning))'];
const BALLOON_COLORS = ['hsl(var(--urgent))', 'hsl(var(--gold))', 'hsl(var(--info))', 'hsl(var(--success))', 'hsl(var(--gold))'];

/*
 * Deterministic pseudo-random. Math.random() would give every render a new
 * scatter — harmless visually, but it also makes the markup non-reproducible
 * between server and client. A hash of the index keeps the burst stable.
 */
function prand(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const CONFETTI_COUNT = 28;
const BALLOON_COUNT = 5;

export function NoticeCelebration({ kind }: { kind: CelebrationKind }) {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  if (!kind || reduced) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <style>{`
        @keyframes nb-burst {
          0%   { transform: translate3d(0,0,0) rotate(0deg) scale(0.6); opacity: 0; }
          12%  { opacity: 1; }
          100% { transform: translate3d(var(--nb-dx), var(--nb-dy), 0) rotate(var(--nb-rot)) scale(1); opacity: 0; }
        }
        @keyframes nb-float {
          0%   { transform: translate3d(0, 30px, 0) scale(0.85); opacity: 0; }
          18%  { opacity: 0.95; }
          100% { transform: translate3d(var(--nb-drift), -150px, 0) scale(1); opacity: 0; }
        }
      `}</style>

      {/* Confetti — bursts outward from just behind the medallion. */}
      {Array.from({ length: CONFETTI_COUNT }).map((_, i) => {
        // Spread across a full circle, biased upward so pieces arc over the title.
        const angle = prand(i, 1) * Math.PI * 2;
        const distance = 90 + prand(i, 2) * 140;
        const dx = Math.cos(angle) * distance;
        const dy = Math.sin(angle) * distance * 0.75 - 20;
        const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
        const isRound = kind === 'birthday' && i % 3 === 0;
        return (
          <span
            key={i}
            className="absolute left-1/2 top-[52px] block"
            style={{
              width: isRound ? 7 : 6,
              height: isRound ? 7 : 11,
              backgroundColor: color,
              borderRadius: isRound ? '9999px' : '1px',
              // Custom props consumed by the nb-burst keyframes above.
              ['--nb-dx' as string]: `${dx}px`,
              ['--nb-dy' as string]: `${dy}px`,
              ['--nb-rot' as string]: `${Math.round(prand(i, 3) * 720 - 360)}deg`,
              animation: `nb-burst ${1100 + Math.round(prand(i, 4) * 700)}ms cubic-bezier(.15,.65,.35,1) ${Math.round(prand(i, 5) * 260)}ms forwards`,
            }}
          />
        );
      })}

      {/* Balloons — birthday only, drifting up behind the headline. */}
      {kind === 'birthday' && Array.from({ length: BALLOON_COUNT }).map((_, i) => (
        <span
          key={`b-${i}`}
          className="absolute bottom-0 block rounded-[50%]"
          style={{
            left: `${8 + i * 21 + prand(i, 6) * 8}%`,
            width: 18,
            height: 23,
            backgroundColor: BALLOON_COLORS[i % BALLOON_COLORS.length],
            opacity: 0.9,
            ['--nb-drift' as string]: `${Math.round(prand(i, 7) * 40 - 20)}px`,
            animation: `nb-float ${2100 + Math.round(prand(i, 8) * 900)}ms ease-out ${Math.round(prand(i, 9) * 500)}ms forwards`,
          }}
        />
      ))}
    </div>
  );
}
