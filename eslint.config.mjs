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
    },
    rules: {
      'no-restricted-syntax': ['error', RESTRICTED_DIALOG_ONOPENCHANGE],
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
    ],
    rules: {
      'no-restricted-syntax': 'off',
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
