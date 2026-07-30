/*
 * ESLint flat config (2026-06-03).
 *
 * Single-purpose: installs the project's "no inline onOpenChange on
 * <Dialog>" rule. Run with `npx eslint .` (NOT `next lint`, which is
 * deprecated and routes through @rushstack/eslint-patch — that patch
 * is incompatible with ESLint 9's flat-config loader as of Next 15.5).
 *
 * Next.js's `next dev` / `next build` already runs its own internal
 * linter for build-time checks; this flat config is intentionally
 * additive and ONLY houses our local custom rule. When Next ships
 * native flat-config support we can extend `eslint-config-next` here
 * the standard way.
 *
 * THE RULE
 *
 *   no-restricted-syntax — "no inline `onOpenChange={(o) => …}` arrow
 *                          on a <Dialog> mount"
 *
 * Reason: every form modal across the CRM now routes its close paths
 * (Esc / X / overlay-click) through the shared `useFormDirtyGuard`
 * hook in src/lib/use-form-dirty-guard.ts. The hook returns an
 * `(o: boolean) => void` handler intended to be bound at the
 * component's top level (React rules-of-hooks) and passed by name to
 * `<Dialog onOpenChange={guardedOpenChange}>`. An inline arrow at the
 * call site silently bypasses the discard-changes confirm — a class of
 * regression we want CI to flag.
 *
 * Carve-outs:
 *   - The hook source files (src/lib/use-form-dirty-guard.ts and
 *     src/lib/use-cancel-confirm.ts) — they wrap/return these arrow
 *     shapes by design.
 *   - Test files and build output — excluded.
 *
 * Bypass for legitimate exceptions:
 *   // eslint-disable-next-line no-restricted-syntax
 * Prefer the hook over the disable comment; the comment is last
 * resort.
 */

const RESTRICTED_DIALOG_ONOPENCHANGE = {
  // ESQuery selector — match a JSXOpeningElement whose name is "Dialog"
  // with a JSXAttribute named "onOpenChange" whose value is a
  // JSXExpressionContainer wrapping an ArrowFunctionExpression. The
  // Identifier-as-value case (e.g. onOpenChange={guardedOpenChange})
  // is NOT matched and stays allowed.
  selector: [
    'JSXOpeningElement[name.name="Dialog"]',
    'JSXAttribute[name.name="onOpenChange"]',
    'JSXExpressionContainer',
    'ArrowFunctionExpression',
  ].join(' > '),
  message:
    'Inline `onOpenChange={(o) => …}` on <Dialog> bypasses the shared '
    + 'discard-changes guard. Use `useFormDirtyGuard` from '
    + "'@/lib/use-form-dirty-guard' and pass the returned handler "
    + 'instead, e.g. `const guardedOpenChange = useFormDirtyGuard(onClose); '
    + '<Dialog onOpenChange={guardedOpenChange}>`.',
};

/*
 * RESTRICTED_USEEFFECT_API_CALL — blocks `useEffect(() => { api.<verb>(…) })`
 * and `useEffect(() => { fetch(…) })`. React 18 Strict Mode mounts effects
 * twice in dev, which silently doubles every direct fetch you write at a
 * component call site. The shared `useFetchOnce` / `useFetch` / `useDebouncedValue`
 * hooks in `@/lib/hooks` dedupe in-flight requests at the module level,
 * memoise results, and own the cancellation/cleanup story — that's the
 * canonical migration target for any "load data on mount / when key
 * changes" pattern.
 *
 * The selector matches a CallExpression whose callee is the identifier
 * `useEffect`, with an arrow-function first argument whose body
 * synchronously contains a CallExpression on `api.<get|post|put|delete|patch>`
 * or a bare `fetch(...)`. It catches both `api.get(...)` direct and
 * `await api.get(...)` (still a CallExpression descendant).
 *
 * Side-effect call sites (e.g. an `api.post` fired from a save handler
 * declared inside `useEffect` only as a closure to be called later from
 * a UI event) are technically caught by this selector — when that
 * happens, the right escape is a targeted `// eslint-disable-next-line
 * no-restricted-syntax` comment with a one-line rationale.
 */
const RESTRICTED_USEEFFECT_API_CALL = {
  selector:
    'CallExpression[callee.name="useEffect"] '
    + 'CallExpression[callee.object.name="api"][callee.property.name=/^(get|post|put|delete|patch)$/]',
  message:
    "Don't call `api.<verb>` inside `useEffect` — React 18 Strict Mode "
    + 'double-fires effects in dev, causing duplicate HTTP requests. Use '
    + '`useFetchOnce` / `useFetch` / `useDebouncedValue` from '
    + "'@/lib/hooks' instead (module-level dedupe + cache + cleanup baked "
    + "in). If this is a legitimate side-effect (not a data load), add a "
    + 'targeted `// eslint-disable-next-line no-restricted-syntax` with a '
    + 'one-line rationale.',
};

const RESTRICTED_USEEFFECT_FETCH = {
  selector:
    'CallExpression[callee.name="useEffect"] CallExpression[callee.name="fetch"]',
  message:
    "Don't call `fetch()` directly inside `useEffect` — use `useFetchOnce` "
    + "/ `useFetch` from '@/lib/hooks' (Strict-Mode-safe + dedupe + "
    + 'cleanup).',
};

// TS-aware parser (already installed as a transitive of eslint-config-next).
// Required because our source is TypeScript + JSX — the default
// `espree` parser bails on TS syntax (`Unexpected token :` on `prop: type`).
import tsParser from '@typescript-eslint/parser';

// React hooks plugin — registered so existing
// `// eslint-disable-next-line react-hooks/exhaustive-deps` comments in
// the codebase don't trip "rule definition not found" errors. We don't
// enable the rule (we leave that to Next's build-time linter); just
// having the plugin loaded satisfies the disable-directive references.
import reactHooksPlugin from 'eslint-plugin-react-hooks';

// Plugins registered ONLY so dormant disable comments resolve cleanly
// (codebase carries
//   // eslint-disable-next-line @next/next/no-img-element
//   // eslint-disable-next-line @typescript-eslint/no-explicit-any
// from before this flat config existed). We import the plugin objects
// but don't enable any of their rules — Next's build-time linter owns
// those enforcement decisions. Without these registrations ESLint 9
// throws hard errors on every reference inside a disable directive:
// "Definition for rule 'X' was not found".
import nextPlugin from '@next/eslint-plugin-next';
import tsPlugin from '@typescript-eslint/eslint-plugin';
// jsx-a11y — registered to satisfy dormant
//   // eslint-disable-next-line jsx-a11y/media-has-caption
// comments in the codebase. Same pattern as the other two plugins
// above: load but don't enable any rules, so Next's build-time linter
// stays the only enforcement surface for accessibility checks.
// Added 2026-06-03 after Docker build failed with
//   "Definition for rule 'jsx-a11y/media-has-caption' was not found"
// on JobModal.tsx:3452.
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';

/*
 * LOCAL RULE — local/no-duplicate-chart-series-color
 *
 * Bans two entries in the SAME chart `series={[…]}` (or `colors={[…]}`) array
 * resolving to the same colour. This is a VALUE equality, so `no-restricted-
 * syntax` (a purely syntactic ESQuery matcher) can't express it: it can't know
 * that `QS_COLORS[2]` and `QS_SEMANTIC.warn` are byte-for-byte the same hex,
 * and it certainly can't follow a local alias like `const C_OPEN = QS_SEMANTIC.warn`.
 *
 * Why this rule exists: the QuickSight chart palette in
 * src/components/quicksight/charts.tsx has TWO overlapping systems —
 *   QS_COLORS   — a 10-hue ROTATION palette ("give me N distinct categories")
 *   QS_SEMANTIC — a MEANING palette (good/warn/bad/info/neutral)
 * and by construction QS_COLORS[1..4] are byte-identical to
 * QS_SEMANTIC.good/warn/bad/info. Picking one of each for two adjacent series
 * renders both bars the same colour and the legend stops distinguishing them.
 * That shipped once (State/User "Tickets Created" vs "Open Orders", both amber,
 * 2026-07-30). TypeScript can't catch it — both are just `string`.
 *
 * HOW IT RESOLVES a colour expression to a hex (conservatively — an
 * unresolvable entry is SKIPPED, never guessed, so the rule can only fire on a
 * genuine, provable collision and never false-positives a build):
 *   - '#rrggbb' string literal            → itself
 *   - QS_COLORS[<int literal>]            → embedded palette copy below
 *   - QS_SEMANTIC.<key>                   → embedded palette copy below
 *   - a local `const X = <any of the above>` alias → followed via scope
 *   - anything else (loop var, .map, fn call) → unresolved, skipped
 *
 * STALENESS GUARD: the palette is embedded here (a lint rule can't import app
 * source). To stop that copy silently drifting from charts.tsx — the exact
 * "invisible drift" failure mode that caused the original bug — the rule ALSO
 * lints the real `QS_COLORS` / `QS_SEMANTIC` definitions and reports a `drift`
 * error if their literal values no longer match this copy. So a palette edit
 * that isn't mirrored here fails lint loudly instead of rotting the check.
 */
const QS_COLORS_COPY = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#0ea5e9',
  '#8b5cf6', '#14b8a6', '#f97316', '#ec4899', '#84cc16',
];
const QS_SEMANTIC_COPY = {
  good: '#10b981', warn: '#f59e0b', bad: '#ef4444', info: '#0ea5e9', neutral: '#94a3b8',
};

const noDuplicateChartSeriesColor = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow two entries in one chart series/colors array resolving to the same colour.' },
    schema: [],
    messages: {
      dup:
        'Two entries in this chart array resolve to the SAME colour {{hex}} ({{a}} and {{b}}), so their '
        + 'bars/slices are indistinguishable. QS_COLORS[1..4] alias QS_SEMANTIC.good/warn/bad/info (identical '
        + 'hex) — pick a QS_COLORS index ≥5 when a hand-picked series sits beside a QS_SEMANTIC one, or choose '
        + 'a different QS_SEMANTIC key.',
      drift:
        '{{name}} in charts.tsx no longer matches the copy embedded in the local/no-duplicate-chart-series-color '
        + 'ESLint rule. Update QS_COLORS_COPY / QS_SEMANTIC_COPY in eslint.config.mjs to match, or the '
        + 'colour-collision check is verifying against a stale palette.',
    },
  },
  create(context) {
    const sc = context.sourceCode || context.getSourceCode();

    // Follow `const X = <init>` up the scope chain; returns the init node or null.
    const resolveIdentInit = (name, scope) => {
      for (let s = scope; s; s = s.upper) {
        const v = s.variables.find((x) => x.name === name);
        if (v) {
          const def = v.defs[0];
          return def && def.node && def.node.type === 'VariableDeclarator' ? def.node.init : null;
        }
      }
      return null;
    };

    const resolveColor = (node, scope, depth = 0) => {
      if (!node || depth > 8) return null;
      if (node.type === 'TSAsExpression') return resolveColor(node.expression, scope, depth + 1);
      if (node.type === 'Literal' && typeof node.value === 'string') {
        const s = node.value.trim().toLowerCase();
        return /^#[0-9a-f]{3,8}$/.test(s) ? s : null;
      }
      if (node.type === 'MemberExpression') {
        const { object, property, computed } = node;
        if (computed && object.type === 'Identifier' && object.name === 'QS_COLORS'
          && property.type === 'Literal' && Number.isInteger(property.value)) {
          return QS_COLORS_COPY[property.value] ?? null;
        }
        if (!computed && object.type === 'Identifier' && object.name === 'QS_SEMANTIC'
          && property.type === 'Identifier') {
          return QS_SEMANTIC_COPY[property.name] ?? null;
        }
        return null;
      }
      if (node.type === 'Identifier') {
        return resolveColor(resolveIdentInit(node.name, scope), scope, depth + 1);
      }
      return null;
    };

    const keyName = (p) => (p.key.type === 'Identifier' ? p.key.name : p.key.value);

    return {
      // The staleness guard — only fires on the real palette definitions.
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier' || !node.init) return;
        if (node.id.name === 'QS_COLORS' && node.init.type === 'ArrayExpression') {
          const vals = node.init.elements.map(
            (e) => (e && e.type === 'Literal' && typeof e.value === 'string' ? e.value.toLowerCase() : null),
          );
          if (vals.some((v) => v === null)) return; // non-literal palette — can't compare
          if (vals.length !== QS_COLORS_COPY.length || vals.some((v, i) => v !== QS_COLORS_COPY[i])) {
            context.report({ node, messageId: 'drift', data: { name: 'QS_COLORS' } });
          }
        }
        if (node.id.name === 'QS_SEMANTIC' && node.init.type === 'ObjectExpression') {
          const map = {};
          for (const p of node.init.properties) {
            if (p.type !== 'Property' || p.computed
              || p.value.type !== 'Literal' || typeof p.value.value !== 'string') return; // give up quietly
            map[keyName(p)] = p.value.value.toLowerCase();
          }
          const keys = new Set([...Object.keys(map), ...Object.keys(QS_SEMANTIC_COPY)]);
          for (const k of keys) {
            if (map[k] !== QS_SEMANTIC_COPY[k]) {
              context.report({ node, messageId: 'drift', data: { name: 'QS_SEMANTIC' } });
              return;
            }
          }
        }
      },

      JSXAttribute(node) {
        const attr = node.name && node.name.name;
        if (attr !== 'series' && attr !== 'colors') return;
        const val = node.value;
        if (!val || val.type !== 'JSXExpressionContainer' || val.expression.type !== 'ArrayExpression') return;

        const scope = sc.getScope(node);
        const seen = new Map(); // hex -> first {label}
        for (const el of val.expression.elements) {
          if (!el) continue;
          let colorNode = null;
          let label = null;
          if (attr === 'series' && el.type === 'ObjectExpression') {
            for (const p of el.properties) {
              if (p.type !== 'Property' || p.computed) continue;
              const k = keyName(p);
              if (k === 'color') colorNode = p.value;
              else if ((k === 'label' || k === 'key') && !label && p.value.type === 'Literal') {
                label = String(p.value.value);
              }
            }
          } else if (attr === 'colors') {
            colorNode = el;
          }
          if (!colorNode) continue;
          const hex = resolveColor(colorNode, scope);
          if (!hex) continue; // unresolved → skip; never false-positive
          const prev = seen.get(hex);
          if (prev) {
            context.report({
              node: colorNode,
              messageId: 'dup',
              data: {
                hex,
                a: prev.label ? `"${prev.label}"` : 'an earlier entry',
                b: label ? `"${label}"` : 'this entry',
              },
            });
          } else {
            seen.set(hex, { label });
          }
        }
      },
    };
  },
};

const localPlugin = { rules: { 'no-duplicate-chart-series-color': noDuplicateChartSeriesColor } };

const config = [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    // Silence "Unused eslint-disable directive" warnings (2026-06-03):
    //   ESLint 9 defaults `reportUnusedDisableDirectives` to 'warn'.
    //   This flat config doesn't actually ENABLE many of the rules the
    //   codebase has historical disable comments for (e.g.
    //   `react-hooks/exhaustive-deps`, `@typescript-eslint/no-explicit-any`)
    //   because Next's internal linter handles those at build time. The
    //   default 'warn' fires on every dormant disable and Next's build
    //   pipeline treats the noise as a failure (Docker build exit 1 on
    //   `RUN npm run build`). Turning the meta-rule off lets historical
    //   disable comments stay where they were authored without bringing
    //   their underlying rule definitions into scope.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    plugins: {
      'react-hooks': reactHooksPlugin,
      '@next/next': nextPlugin,
      '@typescript-eslint': tsPlugin,
      'jsx-a11y': jsxA11yPlugin,
      local: localPlugin,
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        RESTRICTED_DIALOG_ONOPENCHANGE,
        RESTRICTED_USEEFFECT_API_CALL,
        RESTRICTED_USEEFFECT_FETCH,
      ],
      // Colour-collision guard for QuickSight charts (rule + rationale above).
      // Inert on files with no `series`/`colors` chart arrays.
      'local/no-duplicate-chart-series-color': 'error',
    },
  },

  // Carve-outs from `no-restricted-syntax`:
  //
  //   src/lib/use-form-dirty-guard.ts  — the hook source itself wraps
  //                                       an inline arrow.
  //   src/lib/use-cancel-confirm.ts    — same — companion hook.
  //   src/components/ui/confirm-dialog.tsx — the SHARED useConfirm
  //                                       primitive that BOTH hooks
  //                                       delegate to; its Dialog
  //                                       mount intentionally uses
  //                                       an inline arrow because
  //                                       there's no `onClose` callback
  //                                       at that layer (the whole
  //                                       confirm-vs-reject decision
  //                                       is encoded in the arrow).
  //   src/components/notice/NoticeDetailModal.tsx — pure-display modal
  //                                       with no editable form state
  //                                       (audit flagged it as
  //                                       "non-form, skip"). No dirty
  //                                       state to guard.
  //   src/components/zones/ZoneDetailModal.tsx — same: pure-display.
  //
  // Each file's exemption is documented at its own onOpenChange site
  // too so future readers know why the rule was skipped.
  {
    files: [
      'src/lib/use-form-dirty-guard.ts',
      'src/lib/use-cancel-confirm.ts',
      'src/components/ui/confirm-dialog.tsx',
      'src/components/notice/NoticeDetailModal.tsx',
      'src/components/zones/ZoneDetailModal.tsx',
      // JobModal carries its own `guardedClose` dirty-tracking pattern
      // (predates useFormDirtyGuard) — already audited as exempt. The
      // file also hosts 10+ nested sub-dialogs (Outcome, AddRemarks,
      // Address edit, etc.) each with their own inline onOpenChange
      // by design. Migrating them piecemeal would create churn without
      // changing observable behaviour.
      'src/components/job/JobModal.tsx',
      // Lightweight confirm-popup style dialogs that DON'T carry editable
      // form state — closing silently is the intended behaviour, no
      // dirty data to discard.
      'src/components/job/MagicLinkActionPopup.tsx',
      'src/components/job/TransferJobOwnershipDialog.tsx',
      // Drawer-shell / display-mode Dialogs (audit-flagged as non-form,
      // see the audit table from 2026-06-03). These DON'T own form
      // state themselves — they're wrappers around tabbed children
      // (ClientDetailDialog hosts every client tab; CustomerDetail
      // shows read-only customer info; the finance/page.tsx Dialogs
      // at lines 242 and 295 are invoice viewers). Each inner tab is
      // responsible for its own dirty-state warning when applicable;
      // the outer Esc/X just unmounts the host. Migrating these to
      // useFormDirtyGuard would prompt unconditionally on close even
      // when no editable child was touched — wrong UX. Right fix is
      // an architectural per-tab dirty-bus (deferred).
      'src/app/(authed)/clients/page.tsx',
      'src/app/(authed)/customers/page.tsx',
      'src/app/(authed)/finance/page.tsx',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Carve-outs from `no-restricted-syntax` for the useEffect+api rule:
  //
  //   src/lib/hooks.ts             — DEFINES `useFetch` / `useFetchOnce`
  //                                  themselves. They literally implement
  //                                  the dedup+cleanup pattern that the
  //                                  rule mandates everyone else use.
  //   src/lib/use-lookup.ts        — Peer hook (`useLookup`) with its own
  //                                  module-level `fetchOnce` dedup; the
  //                                  whole shared/lookup payload is loaded
  //                                  once per session.
  //   src/app/(authed)/easyfixers/page.tsx
  //                                — Actively iterated; skipping per
  //                                  instructions to avoid mid-session
  //                                  conflicts.
  //   src/app/(public)/profile-update/[token]/page.tsx
  //                                — Possibly touched by another agent.
  {
    // NOTE on globs: Next.js dynamic-segment dirs contain literal `[id]`
    // brackets which micromatch interprets as char classes. Use a `**`
    // wildcard inside the bracket position so the carve-out actually
    // matches the file on disk (verified via `npx eslint --print-config`).
    files: [
      'src/lib/hooks.ts',
      'src/lib/use-lookup.ts',
      'src/app/(authed)/easyfixers/page.tsx',
      'src/app/(public)/profile-update/**/page.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', RESTRICTED_DIALOG_ONOPENCHANGE],
    },
  },

  // Exclusions — never lint these.
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'public/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
  },
];

export default config;
