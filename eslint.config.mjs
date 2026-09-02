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

import reactHooks from 'eslint-plugin-react-hooks';

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

/* ───────────────────────────────────────────────────────────────────────────
 * LOCAL RULE — local/no-raw-time-slot-render
 *
 * Bans rendering `tbl_job.time_slot` (or its legacy sibling
 * `booking_cut_off_time_slot`) straight into JSX.
 *
 * WHY A RULE AND NOT A CODE REVIEW. `time_slot` is DERIVED — it is the booking
 * band CONTAINING `requested_date_time`, and the backend's `resolveTimeSlot`
 * re-derives it on every write. So a stored value can be stale, and the column
 * additionally holds ~20 free-text spellings of four bands accumulated from four
 * pickers over a decade. Rendering it raw produces two failures that both look
 * fine on screen: a band contradicting the appointment time printed beside it
 * (job #482491 stores 05:30 with '3pm to 7pm'), and cosmetic spelling variants
 * that no equality check matches.
 *
 * Eight call sites had this at once. Each was individually reasonable — reading
 * a column the row already carries — which is exactly why review kept missing
 * it. `displaySlot(requestedDateTime, storedSlot)` in src/lib/job-slots.ts is
 * the one correct composition; this rule makes reaching past it visible.
 *
 * SCOPE. Only JSX. Passing `time_slot` to an API, a query param or a helper is
 * fine and common — `ScheduleAssignModal` ships the stored value verbatim as the
 * candidate-search `timeSlot` param on purpose, and that must keep working.
 * A reference inside a call to one of ALLOWED_SLOT_CALLS is also fine, which is
 * what lets `{displaySlot(j.requested_date_time, j.time_slot)}` pass.
 *
 * The genuine exception is a surface rendering an immutable AUDIT SNAPSHOT of
 * what someone submitted (CustomerSubmissionPanel) — there, deriving would
 * falsify the record. Those carry an eslint-disable-next-line with a reason.
 * ─────────────────────────────────────────────────────────────────────────── */
const RAW_SLOT_PROPS = new Set(['time_slot', 'booking_cut_off_time_slot']);
const ALLOWED_SLOT_CALLS = new Set([
  'displaySlot', 'canonicalSlot', 'inferSlotFromTime', 'bandForTime', 'slotChoicesFor', 'isKnownBand',
]);

const noRawTimeSlotRender = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow rendering a raw tbl_job.time_slot into JSX; derive it instead.' },
    schema: [],
    messages: {
      raw:
        'Rendering `{{prop}}` raw. It is DERIVED from requested_date_time and can be stale (job #482491 '
        + 'stores 05:30 with the label \'3pm to 7pm\'), and the column holds ~20 spellings of four bands. '
        + 'Use displaySlot(requestedDateTime, storedSlot) from @/lib/job-slots — it prefers the appointment '
        + 'instant and falls back to the stored label, canonicalised, only for a date-only (00:00 sentinel) '
        + 'job. If this genuinely renders an immutable audit snapshot of what someone submitted, add an '
        + 'eslint-disable-next-line with that reason.',
    },
  },
  create(context) {
    /* Is `node` lexically inside a call to an approved slot helper? */
    const insideAllowedCall = (node, stopAt) => {
      for (let n = node.parent; n && n !== stopAt.parent; n = n.parent) {
        if (n.type === 'CallExpression') {
          const c = n.callee;
          const name = c.type === 'Identifier' ? c.name
            : (c.type === 'MemberExpression' && c.property.type === 'Identifier' ? c.property.name : null);
          if (name && ALLOWED_SLOT_CALLS.has(name)) return true;
        }
      }
      return false;
    };

    /*
     * The nearest enclosing JSXExpressionContainer, or null.
     *
     * Visiting MemberExpression and climbing UP is deliberate. Visiting
     * JSXExpressionContainer and walking DOWN double-reports, because JSX nests:
     * `{rows.map(r => <Row value={r.time_slot} />)}` has a container inside a
     * container, so the descent runs over the same node once per ancestor.
     * Climbing up reaches each node exactly once by construction.
     */
    const enclosingJsxExpression = (node) => {
      for (let n = node.parent; n; n = n.parent) {
        if (n.type === 'JSXExpressionContainer') return n;
        // A function boundary does NOT stop the climb: an arrow inside a
        // container (`.map(r => …)`) still renders into that container.
      }
      return null;
    };

    return {
      MemberExpression(node) {
        // Computed access (`row[key]`) cannot be resolved statically; guessing
        // there would be noise, and this mistake is always a plain `.time_slot`.
        if (node.computed || node.property.type !== 'Identifier') return;
        if (!RAW_SLOT_PROPS.has(node.property.name)) return;
        const container = enclosingJsxExpression(node);
        if (!container) return;                              // not JSX — fine
        if (insideAllowedCall(node, container)) return;
        context.report({ node, messageId: 'raw', data: { prop: node.property.name } });
      },
    };
  },
};

/* ───────────────────────────────────────────────────────────────────────────
 * LOCAL RULE — local/no-unscrollable-dialog-content
 *
 * Bans a BARE `overflow-hidden` on <DialogContent> unless the modal's own
 * subtree provides a scroll region.
 *
 * HALF OF A PAIR. local/dialog-single-scroller (defined just below) is the
 * dual: this rule bans ZERO scrollers, that one bans TWO. Together they say
 * "exactly one scroller, always". Their outer tests are exact negations —
 * this one requires a bare `overflow-hidden` on the panel, that one requires
 * its absence — so no DialogContent can ever trip both. Edit either and read
 * the other first; they share SCROLLY_CLASS, hasBareOverflowHidden and
 * literalTextIn below.
 *
 * WHY THIS ISN'T A no-restricted-syntax SELECTOR. The condition is not
 * "does this attribute contain a string" — it is "does this attribute contain
 * a string AND does the subtree below it lack another one". ESQuery can't
 * express the second half, and a rule that only checked the first would fire
 * on the 22 call sites where `overflow-hidden` is exactly right.
 *
 * THE INVARIANT. DialogContent's base is `max-h-[85vh] overflow-y-auto
 * overflow-x-hidden` (2026-08-13), which bounds every modal and lets it
 * scroll. tailwind-merge puts `overflow-hidden` in the SAME conflict group as
 * `overflow-y-auto`, so a call-site `overflow-hidden` doesn't merely add a
 * clip — it DELETES the base scroll. Verified against the real class strings:
 *
 *     twMerge(base, 'p-0 overflow-hidden')  →  max-h-[85vh] p-0 overflow-hidden
 *
 * Bounded, but clipping: content past 85vh is unreachable, and if that content
 * is the footer, the modal has hidden its own dismiss button. That shipped —
 * a notice longer than the viewport could only be closed with Esc.
 *
 * Two shapes are legitimate and both pass:
 *   1. `overflow-x-hidden` (+ the base's y-scroll) — `auto` still clips to the
 *      border radius, so an edge-to-edge header band keeps its rounded corners.
 *   2. `overflow-hidden` on a `flex flex-col` panel whose body child carries
 *      `flex-1 min-h-0 overflow-y-auto` — the pinned header/footer pattern. The
 *      rule looks for that inner region and stays quiet when it finds one.
 *
 * FALSE-POSITIVE SHAPE: a modal whose body is rendered by a CHILD COMPONENT
 * (`<SomeBody />`) that owns the scroll region — the rule can't see into
 * another file. That's the case for an eslint-disable-next-line with a
 * one-line reason, same as the other rules here.
 * ─────────────────────────────────────────────────────────────────────────── */
/*
 * Matched against RAW SOURCE TEXT, not an extracted string value — so the
 * delimiter on either side is just as often a quote or backtick as a space
 * (`className="overflow-y-auto …"`). A whitespace-anchored version of this
 * silently matched nothing and reported four modals that were perfectly fine.
 * Character-class lookaround is the boundary that actually holds, while still
 * refusing to match inside a longer token.
 */
const SCROLLY_CLASS = /(?<![-\w])overflow-(y-)?(auto|scroll)(?![-\w])/;

/* Is `overflow-hidden` present as a WHOLE class token? Tolerates the `!`
 * important prefix and responsive/state variants, and deliberately does NOT
 * match `overflow-x-hidden` / `overflow-y-hidden`, which are the fix. */
const hasBareOverflowHidden = (text) => text.split(/\s+/).some((tok) => {
  const bare = tok.replace(/^!/, '');
  const base = bare.slice(bare.lastIndexOf(':') + 1);
  return base === 'overflow-hidden';
});

/* Every string literal anywhere inside a JSX attribute value — covers
 * className="…", className={`…`}, className={cn('…', x && '…')},
 * className={'a ' + (c ? 'b' : 'c')} and conditional branches, without caring
 * which shape it is. Module scope because BOTH dialog rules call it; a second
 * copy is exactly the invisible drift the QS_COLORS_COPY staleness guard and
 * the RAW_PALETTE sync note further down exist to complain about. It closes
 * over nothing, so it is a plain function, not a per-run closure.
 *
 * It CONCATENATES every branch rather than evaluating one, so a className
 * whose arms disagree (`compact ? 'p-0' : 'overflow-hidden p-0'`) reads as
 * carrying every class any branch could emit. Both rules lean on that
 * deliberately: it makes them quiet on ambiguous call sites instead of wrong
 * on them.
 */
const literalTextIn = (node) => {
  let out = '';
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'Literal' && typeof n.value === 'string') out += ' ' + n.value;
    else if (n.type === 'TemplateElement') out += ' ' + (n.value.cooked ?? n.value.raw ?? '');
    for (const k of Object.keys(n)) {
      if (k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(node);
  return out;
};

/* The className attribute of a JSXOpeningElement, or undefined. */
const classNameAttr = (opening) => (opening.attributes || []).find(
  (a) => a.type === 'JSXAttribute' && a.name && a.name.name === 'className',
);

const noUnscrollableDialogContent = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow a bare overflow-hidden on DialogContent with no scroll region beneath it.' },
    schema: [],
    messages: {
      clipped:
        '`overflow-hidden` on <DialogContent> DELETES the base `overflow-y-auto` — tailwind-merge treats '
        + 'them as the same conflict group — so this modal clips at max-h-[85vh] with no way to reach the '
        + 'rest. If the footer is down there, the modal hides its own dismiss button (a notice shipped like '
        + 'that; Esc was the only exit). Either use `overflow-x-hidden` instead — `auto` still clips to the '
        + 'rounded corners, so an edge-to-edge header band keeps its corners — or keep `overflow-hidden` and '
        + 'add `flex flex-col` here plus a body child with `flex-1 min-h-0 overflow-y-auto`. If the scroll '
        + 'region lives in a child COMPONENT this rule cannot see, add an eslint-disable-next-line saying so.',
    },
  },
  create(context) {
    const sc = context.sourceCode || context.getSourceCode();

    return {
      JSXOpeningElement(node) {
        if (!node.name || node.name.name !== 'DialogContent') return;
        const classAttr = classNameAttr(node);
        if (!classAttr || !classAttr.value) return;
        if (!hasBareOverflowHidden(literalTextIn(classAttr.value))) return;

        /* Look for a scroll region in the element's own subtree. Scanning the
         * source text of the whole JSXElement rather than walking children:
         * the body region is often several components deep in the same file,
         * and any `overflow-y-auto` below this point is evidence the author
         * provided somewhere for the content to go. Deliberately generous —
         * this rule should only fire when there is provably no escape. */
        const element = node.parent;
        const text = sc.getText(element);
        if (SCROLLY_CLASS.test(text)) return;

        context.report({ node: classAttr, messageId: 'clipped' });
      },
    };
  },
};

/* ───────────────────────────────────────────────────────────────────────────
 * LOCAL RULE — local/dialog-single-scroller
 *
 * Bans a scrolling DIRECT CHILD inside a <DialogContent> that itself still
 * scrolls. One modal, two nested scroll containers.
 *
 * THE DUAL OF local/no-unscrollable-dialog-content (directly above). That rule
 * bans ZERO scrollers — a bare `overflow-hidden` with nothing beneath it to
 * scroll. This one bans TWO. Together they say: exactly one scroller, always.
 * The two outer tests are exact negations of each other, so a given
 * DialogContent is always the business of at most one of them and a single
 * layout mistake never produces two errors.
 *
 * WHY THIS ISN'T A no-restricted-syntax SELECTOR. Same reason as its dual: the
 * condition is relational — this element's className AND a child's className —
 * and ESQuery has no way to say "…and one of my children carries an attribute
 * containing X". A selector matching only the child half would fire on all 17
 * legitimately-nested scrollers (see DIRECT CHILD ONLY below).
 *
 * WHAT IT COSTS — MEASURED on the Manage Users modal, the defect that prompted
 * the rule. Its DialogContent kept the base `max-h-[85vh] overflow-y-auto` and
 * the body div added its own `max-h-[…] overflow-y-auto` on top:
 *   · the inner band alone held 1419px of scroll content;
 *   · the panel then scrolled a FURTHER 56px at 1400x900, and 86px at a
 *     700px-tall viewport — two scrollbars, nested, and the outer one takes
 *     the wheel as soon as the pointer leaves the inner band;
 *   · the footer sat below the fold of that OUTER scroller, so the action row
 *     was invisible until the user found the second scrollbar.
 * The fix took the modal from 2 scrollers to 1.
 *
 * THE FIX, and the reference implementation. src/app/(authed)/settings/
 * manage-roles/page.tsx (~line 1022) is the shape to copy:
 *
 *     <DialogContent className="… max-h-[85vh] flex flex-col overflow-hidden">
 *       <DialogHeader className="shrink-0"> … </DialogHeader>
 *       <div className="space-y-4 flex-1 min-h-0 overflow-y-auto pr-1"> … </div>
 *       <DialogFooter className="shrink-0"> … </DialogFooter>
 *     </DialogContent>
 *
 * `overflow-hidden` on the panel is what disarms the base scroller (the
 * tailwind-merge conflict-group fact is documented on the dual above),
 * `shrink-0` pins the bands so they cannot be squeezed, and `flex-1 min-h-0`
 * is what makes the body — and only the body — the scroller. Deleting the
 * child's scroll classes and letting the whole panel scroll as one is equally
 * correct and a smaller diff; it is the right answer whenever the modal has no
 * footer worth pinning.
 *
 * DIRECT CHILD ONLY, and that scope IS the design. A scroller further down —
 * a bounded picker list inside a form section — is a deliberate sub-region and
 * is correct. The audit counted 17 of those against 16 real violations, and 13
 * of the 17 sit under a DialogContent that still scrolls, so a rule phrased as
 * "any scrolling descendant" would have been wrong nearly as often as right on
 * its very first run.
 *
 * WHAT COUNTS AS A DIRECT CHILD. In the DOM sense, not the AST sense: JSX
 * expression containers and fragments are TRANSPARENT. `{cond ? <div …/> : <div
 * …/>}`, `{rows.map((r) => <div …/>)}` and `<>…</>` all render children of
 * DialogContent. So the walk descends through anything that is NOT a
 * JSXElement and stops at the first one on each path. This is not academic:
 * five of the sixteen violations (the QuickSight drill-down modals) live in the
 * final arm of a four-way conditional chain and are invisible to a rule that
 * reads only `node.children`.
 *
 * WHAT IT DELIBERATELY CANNOT SEE — skipped silently, never guessed:
 *   · a child COMPONENT that owns its own overflow (`<ClickToCallTab />`,
 *     `<ScrollArea>`) — the className lives in another file;
 *   · a className assembled from a variable or a CSS module — no literal to
 *     read, so `literalTextIn` returns nothing and the child is skipped;
 *   · a DialogContent carrying BOTH `overflow-hidden` and an explicit
 *     `overflow-y-auto`, which in practice means different arms of a ternary.
 *     Which one tailwind-merge keeps depends on the order they are emitted in,
 *     and "order" is not a property a conditional has. Ambiguous is not a
 *     violation: the `hasBareOverflowHidden` bail below catches this case and
 *     hands the site to nobody.
 * A noisy rule gets disabled; a quiet one keeps working. Where the rule is
 * wrong anyway, an eslint-disable-next-line with a one-line reason is the
 * documented escape, same as the other rules in this file.
 * ─────────────────────────────────────────────────────────────────────────── */
const dialogSingleScroller = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow a scrolling direct child inside a DialogContent that still scrolls.' },
    schema: [],
    messages: {
      nested:
        'This is a direct child of a <DialogContent> that STILL SCROLLS — the base is '
        + '`max-h-[85vh] overflow-y-auto` and nothing on the panel disarms it — so the modal now has two '
        + 'nested scroll containers. Measured on Manage Users: the inner band held 1419px of content and '
        + 'the panel still scrolled a further 56px at 1400x900 (86px at a 700px-tall viewport), which put '
        + 'the footer below the fold of the OUTER scroller — the action row was unreachable until you found '
        + 'the second scrollbar. Two fixes, both correct: drop the scroll classes here and let the dialog '
        + 'scroll as one panel; or commit to the pinned pattern — add `flex flex-col overflow-hidden` to the '
        + 'DialogContent, `shrink-0` to the header and footer, and keep `flex-1 min-h-0 overflow-y-auto` on '
        + 'this body. src/app/(authed)/settings/manage-roles/page.tsx is the reference implementation. If '
        + 'this scroller is a deliberate bounded sub-region and not the modal body, add an '
        + 'eslint-disable-next-line saying so.',
    },
  },
  create(context) {
    /* Direct children in the DOM sense (see WHAT COUNTS AS A DIRECT CHILD
     * above): descend through fragments, `{…}` containers, ternary arms, `&&`
     * guards and `.map()` callbacks, and stop at the first JSXElement on each
     * path. Stopping there is precisely what keeps grandchildren — the 17
     * legitimate bounded sub-regions — out of the result. */
    const directChildElements = (jsxElement) => {
      const out = [];
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'JSXElement') { out.push(n); return; }   // a child — do NOT descend
        for (const k of Object.keys(n)) {
          if (k === 'parent') continue;
          const v = n[k];
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v.type === 'string') walk(v);
        }
      };
      (jsxElement.children || []).forEach(walk);
      return out;
    };

    return {
      JSXOpeningElement(node) {
        if (!node.name || node.name.name !== 'DialogContent') return;

        /* Does the PANEL still scroll? A missing className means yes — the base
         * carries the scroll, and 27 of the 118 call sites pass no className at
         * all, so "absent" must read as "scrolls" rather than "skip". A bare
         * `overflow-hidden` means no: that panel belongs to the dual rule. */
        const own = classNameAttr(node);
        if (own && own.value && hasBareOverflowHidden(literalTextIn(own.value))) return;

        for (const child of directChildElements(node.parent)) {
          const attr = classNameAttr(child.openingElement);
          if (!attr || !attr.value) continue;
          /* SCROLLY_CLASS has no /g flag, so `.test()` carries no lastIndex
           * between children. Do not add one — this loop calls it N times. */
          if (!SCROLLY_CLASS.test(literalTextIn(attr.value))) continue;
          // Reported on the CHILD's className: that is where the fix goes.
          context.report({ node: attr, messageId: 'nested' });
        }
      },
    };
  },
};

/* ───────────────────────────────────────────────────────────────────────────
 * LOCAL RULE — local/no-inverting-surface-with-fixed-foreground
 *
 * Bans a surface class (`bg-` / `from-` / `via-` / `to-`) built on a token
 * whose LIGHTNESS INVERTS between themes, when the same class set pins the
 * foreground to something that does NOT invert — a literal (`text-white`,
 * `text-black`, `text-[#fff]`) or one of the 16 stable tokens. The surface
 * follows the theme, the text does not, and in one of the two themes they
 * cross over.
 *
 * THE MEASUREMENT THAT DEFINES THE TOKEN SETS. src/app/brand.css declares all
 * 54 semantic colour tokens twice, once under `:root` and once under `.dark`,
 * as space-separated HSL triplets. Parse both blocks, read the third component
 * (lightness) of each pair, and a token INVERTS when the two values sit on
 * opposite sides of the 50% mid-point. That split is 38 inverting / 16 stable
 * (byte-identical in both blocks; none of the 54 changes value without also
 * crossing). `--radius` is the only other custom property and is not a colour.
 * The INVERTING_TOKENS map carries both lightness values per token precisely so
 * the message can quote them and so the next person can re-derive the list:
 * re-run that comparison over brand.css after `npm run brand:gen` and the two
 * halves should still add to 54.
 *
 * INVERTING IS NOT THE BUG. A text scale MUST invert — `text-ink-900` has to
 * stay readable in both themes — and most tokens invert IN PAIRS: `--card`
 * flips and `--card-foreground` flips with it, so `bg-card text-card-foreground`
 * is correct. `--success-tint` (92.35% → 20.78%) and `--success-strong`
 * (20.78% → 92.35%) swap WITH EACH OTHER, so `bg-success-tint
 * text-success-strong` is correct too. The rule therefore stays silent the
 * moment the foreground is itself an inverting token — that pairing IS the
 * design, not the defect.
 *
 * THE DEFECT THAT PROMPTED IT, measured. DialogHeader painted
 * `bg-gradient-to-r from-ink-900 via-ink-700 to-ink-900 text-white`. --ink-900
 * is rgb(23,27,31) under :root — 17.31:1 against white — and rgb(244,246,247)
 * under .dark, which is 1.08:1. Every dialog title in the app was
 * white-on-near-white in dark mode. Commit 497cd6e fixed it by swapping to
 * --sidebar / --sidebar-accent: stable in both themes AND equal to the
 * light-mode ink values, so the light theme came out pixel-identical.
 *
 * WHY THIS ISN'T A no-restricted-syntax SELECTOR, and why it does NOT reuse
 * `literalTextIn`. Same relational problem as the two dialog rules above — the
 * condition is "this class set holds an inverting surface AND a non-inverting
 * foreground" — but with one twist that rules the shared helper out.
 * `literalTextIn` CONCATENATES every branch on purpose, which is exactly right
 * for the dialog pair (it makes them quiet) and exactly wrong here (it would
 * make this one LOUD). The single largest false-positive source for this defect
 * is pairing a surface from one ternary arm with a foreground from the other:
 *
 *     isOpen ? 'bg-brand-50 text-primary' : 'bg-card text-ink-700'
 *
 * Concatenated, that also reads as `bg-card` + `text-primary` and reports a
 * pairing that can never render. So this rule splits a class expression into
 * INDEPENDENT sets instead: the unconditional text is a base, and each
 * conditional arm, each `&&`/`||` right-hand side and each template quasi
 * becomes its own set layered on that base. Sibling `cn()` arguments DO share
 * one set — they are emitted together onto one element — and that is what
 * catches the sites that split an element's classes across several string
 * arguments.
 *
 * NOT JUST className. The QUIET notice theme stores its CTA classes as a plain
 * object property (`buttonClass: 'bg-ink-900 hover:bg-ink-700 text-white'` in
 * src/components/notice/noticeThemes.ts) and never touches a JSX attribute, so
 * an attribute-scoped rule would miss it. So the rule accepts a set root from a
 * className attribute, an argument to a class combinator (cn/clsx/classNames/
 * twMerge/cva), OR an object property / variable binding whose NAME ends in
 * `class`, `classes` or `className` — which is how this codebase stores class
 * strings outside JSX.
 *
 * IT IS NAME-GATED, NOT SHAPE-GATED, and that is a real limitation rather than
 * an oversight. It once did walk the whole program and treat any class-shaped
 * expression as a root; that version reported
 *
 *     const MSG = 'Could not load bg-ink-900 text-white preset';
 *
 * which is prose, reaches no `class` attribute, and cannot be a contrast bug. A
 * rule that flags prose gets switched off, and then it protects nothing. The
 * cost of the gate is that a class string in a generically named binding —
 * `const T = { active: 'bg-ink-900 text-white' }` — is invisible here. Probed:
 * `buttonClass`, `heroClass` and `className` all report; `active` and `klass`
 * do not. Name the binding after what it holds and the rule sees it.
 *
 * VARIANTS. `hover:` / `focus:` / `active:` / `group-hover:` surfaces pair with
 * the element's own foreground and ARE reportable — a green CTA whose base is
 * the stable `bg-success` but whose hover is the inverting `bg-success-strong`
 * loses its white label the moment the pointer lands — so the message names the
 * variant. Anything carrying `dark:` is theme-specific by construction and the
 * whole set is skipped: the author has already said what dark mode should do.
 *
 * WHAT IT DELIBERATELY CANNOT SEE — skipped silently, never guessed:
 *   · a class string assembled from a variable, a prop, a MemberExpression or a
 *     lookup table in another file — there is no literal to read, so nothing is
 *     contributed to the set;
 *   · a surface and a foreground that live on DIFFERENT elements but share one
 *     literal (a `cn()` handed to a wrapper and its label) — read as one set;
 *     the documented escape is an eslint-disable-next-line, as with the rules
 *     above;
 *   · composited alpha (`bg-ink-900/85`): the opacity is stripped and the token
 *     judged at full strength. That chip does still cross — 11.14:1 in light,
 *     1.47:1 in dark — but the rule is not computing the composite, it is
 *     flagging the token underneath it;
 *   · a set with no `text-` colour at all — colour is inherited and the pairing
 *     is decided somewhere this rule cannot see, so it is NOT a defect;
 *   · a set declaring BOTH a fixed and an inverting foreground AT THE SAME
 *     variant scope — which one wins depends on emission order, and ambiguous
 *     is not a violation. (Foregrounds at DIFFERENT scopes no longer mask each
 *     other; see crossoverIn.)
 * A noisy rule gets disabled within a week; a quiet one keeps working.
 * ─────────────────────────────────────────────────────────────────────────── */

/* token → [lightness under :root, lightness under .dark]. Derived from
 * src/app/brand.css by the mid-point comparison documented above — 38 of 54.
 * Regenerate, do not hand-edit. */
const INVERTING_TOKENS = new Map([
  ['accent',               [96.27, 30.39]],
  ['accent-foreground',    [30.39, 91.76]],
  ['background',           [96.27, 10.59]],
  ['border',               [90.59, 39.02]],
  ['brand-100',            [91.76, 38.82]],
  ['brand-50',             [96.27, 30.39]],
  ['brand-700',            [30.39, 91.76]],
  ['card',                 [100.00, 23.33]],
  ['card-foreground',      [10.59, 96.27]],
  ['foreground',           [10.59, 96.27]],
  ['gold-strong',          [21.96, 91.57]],
  ['gold-tint',            [91.57, 21.96]],
  ['info-deep',            [18.24, 93.73]],
  ['info-strong',          [31.76, 93.73]],
  ['info-tint',            [93.73, 18.24]],
  ['ink-100',              [90.59, 23.33]],
  ['ink-300',              [63.33, 39.02]],
  ['ink-50',               [96.27, 10.59]],
  ['ink-500',              [39.02, 63.33]],
  ['ink-700',              [23.33, 90.59]],
  ['ink-900',              [10.59, 96.27]],
  ['input',                [90.59, 39.02]],
  ['muted',                [90.59, 39.02]],
  ['muted-foreground',     [39.02, 63.33]],
  ['neutral',              [39.02, 63.33]],
  ['neutral-strong',       [23.33, 90.59]],
  ['neutral-tint',         [90.59, 23.33]],
  ['popover',              [100.00, 23.33]],
  ['popover-foreground',   [10.59, 96.27]],
  ['secondary',            [90.59, 39.02]],
  ['secondary-foreground', [10.59, 96.27]],
  ['success-strong',       [20.78, 92.35]],
  ['success-tint',         [92.35, 20.78]],
  ['urgent',               [38.82, 91.76]],
  ['urgent-strong',        [30.39, 91.76]],
  ['urgent-tint',          [91.76, 30.39]],
  ['warning-strong',       [21.96, 91.96]],
  ['warning-tint',         [91.96, 21.96]],
]);

/* The other 16: byte-identical under :root and .dark. Safe as chrome, and the
 * only surfaces a `text-white` label may sit on — but as a FOREGROUND they are
 * the fixed half of the crossover, which is why the same list feeds both
 * FIXED_FOREGROUNDS and the "use one of these instead" half of the message. */
const STABLE_TOKENS = [
  'brand-500', 'brand-600', 'destructive', 'destructive-foreground', 'destructive-strong',
  'gold', 'info', 'primary', 'primary-foreground', 'primary-pressed', 'ring',
  'sidebar', 'sidebar-accent', 'sidebar-foreground', 'success', 'warning',
];

/* A foreground that will NOT move when the theme flips. Bare literals plus the
 * stable tokens; arbitrary colour values (`text-[#fff]`) are matched separately
 * by ARBITRARY_COLOR because they have no closed vocabulary. */
const FIXED_FOREGROUNDS = new Set(['white', 'black', ...STABLE_TOKENS]);
const ARBITRARY_COLOR = /^\[(#|rgb|hsl|oklch)/i;

/* Surfaces only: the gradient stops count because `from-ink-900 … text-white`
 * IS the DialogHeader defect. `text-` is handled separately as the foreground;
 * `border-` and `ring-` are not surfaces and never carry the label. */
const SURFACE_UTILITY = /^(bg|from|via|to)-(.+)$/;

/* Variants that describe an interaction STATE rather than a viewport or a
 * theme. Used only to phrase the message ("on `hover:`"); a state-only
 * crossover is still a crossover. */
const STATE_VARIANT = /(^|-)(hover|focus|focus-visible|focus-within|active|open|checked|selected|pressed|disabled)$/;

/* Functions whose arguments are all emitted onto ONE element, so they share a
 * class set. Counted in src/: cn 121, twMerge 1, clsx 1, cva 1. */
const CLASS_JOINERS = new Set(['cn', 'clsx', 'classNames', 'classnames', 'twMerge', 'cva']);

/* Is this node part of a class expression — i.e. can classSets() read it?
 * Used twice: to walk INTO a class expression, and to decide whether a node is
 * the OUTERMOST one (a set root) by asking the same question of its parent. A
 * CallExpression only counts when its callee is a known joiner, so an unrelated
 * `showToast('…')` leaves its string literal to be judged on its own. */
const isClassExpr = (n) => {
  if (!n || typeof n.type !== 'string') return false;
  switch (n.type) {
    case 'CallExpression':
      return !!n.callee && n.callee.type === 'Identifier' && CLASS_JOINERS.has(n.callee.name);
    case 'BinaryExpression':
      return n.operator === '+';
    case 'Literal':
      return typeof n.value === 'string';
    case 'TemplateLiteral':
    case 'ConditionalExpression':
    case 'LogicalExpression':
    case 'ArrayExpression':
    case 'JSXExpressionContainer':
    case 'JSXAttribute':
    case 'TSAsExpression':
      return true;
    default:
      return false;
  }
};

/* Strip the `!` important marker, peel the variant chain off the front and the
 * `/40` opacity off the back, and hand back both halves. Bracket-depth aware:
 * `bg-[url(a:b)]` and `text-[hsl(0_0%_0%/50%)]` must not be split on the colon
 * or the slash inside their arbitrary value. */
const utilityParts = (token) => {
  const tok = token.replace(/^!/, '');
  const variants = [];
  let depth = 0;
  let cur = '';
  for (const ch of tok) {
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    if (ch === ':' && depth === 0) { variants.push(cur); cur = ''; continue; }
    cur += ch;
  }
  const base = cur.replace(/^!/, '').replace(/\/[\d.]+$/, '');
  return { variants, base };
};

/* Every INDEPENDENT class set a class expression can emit, as arrays of raw
 * utility tokens. Returns [base, ...branches] where every branch already has
 * the base folded in — so `cn('bg-success text-white', busy && 'opacity-60')`
 * yields a base holding the pairing, and a nested ternary's arms never see each
 * other. Unreadable shapes (Identifier, MemberExpression, a call to anything
 * that is not a joiner) contribute NOTHING rather than a guess.
 *
 * Each template QUASI is its own set, not one concatenated run: the static text
 * either side of an interpolation is frequently two different elements' worth
 * of classes, and keeping them apart costs nothing real (a quasi that genuinely
 * holds both halves of a pairing still holds them together). */
const classSets = (node) => {
  const base = [];
  const branches = [];
  const addText = (s) => { for (const t of String(s).split(/\s+/)) if (t) base.push(t); };
  const tokensOf = (s) => String(s).split(/\s+/).filter(Boolean);

  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    switch (n.type) {
      case 'Literal':
        if (typeof n.value === 'string') addText(n.value);
        return;
      case 'TemplateLiteral':
        for (const q of n.quasis) branches.push(tokensOf(q.value.cooked ?? q.value.raw ?? ''));
        for (const e of n.expressions) branches.push(...classSets(e));
        return;
      case 'ConditionalExpression':
        branches.push(...classSets(n.consequent), ...classSets(n.alternate));
        return;
      case 'LogicalExpression':
        // `cond && '…'` / `x ?? '…'` — only the right side can reach the DOM.
        branches.push(...classSets(n.right));
        return;
      case 'BinaryExpression':
        if (n.operator === '+') { walk(n.left); walk(n.right); }
        return;
      case 'ArrayExpression':
        (n.elements || []).forEach(walk);
        return;
      case 'CallExpression':
        if (isClassExpr(n)) (n.arguments || []).forEach(walk);
        return;
      case 'JSXExpressionContainer': walk(n.expression); return;
      case 'JSXAttribute': walk(n.value); return;
      case 'TSAsExpression': walk(n.expression); return;
      default: return;   // unreadable — skipped silently, see the header
    }
  };

  walk(node);
  return [base, ...branches.map((b) => base.concat(b))];
};

/* The crossover test for ONE set, or null.
 *
 * FOREGROUNDS ARE MATCHED AT THE SURFACE'S OWN VARIANT SCOPE, and that detail
 * earns its keep. NoticeDetailModal's Open Link chip is
 * `border-brand-100 bg-brand-50 text-primary hover:bg-brand-100
 * hover:text-brand-700`: the RESTING state is the defect (--brand-50 inverts
 * 96.27% → 30.39% under a fixed primary red — 5.17:1 light, 1.72:1 dark) while
 * the hover state is fine, because brand-100 and brand-700 swap with each
 * other. A flat "does this set contain any inverting foreground" test reads the
 * `hover:text-brand-700` and calls the whole chip safe — one real defect lost to
 * a recolour that only applies under the pointer. So each foreground is filed
 * under its own variant key, and a surface consults the foregrounds declared at
 * its key, falling back to the unvariant ones when it has none of its own —
 * which is what the cascade actually does. */
const crossoverIn = (tokens) => {
  let surface = null;
  let surfacePrefix = '';
  let surfaceVariants = [];
  const foregrounds = [];   // { key, colour, inverting }

  for (const tok of tokens) {
    const { variants, base } = utilityParts(tok);
    // A `dark:` anywhere in the set means the author is already steering the
    // theme by hand; the whole set is theirs, not ours.
    if (variants.includes('dark')) return null;
    const key = variants.slice().sort().join('.');

    const surfaceMatch = SURFACE_UTILITY.exec(base);
    if (surfaceMatch && INVERTING_TOKENS.has(surfaceMatch[2]) && !surface) {
      surface = surfaceMatch[2];
      surfacePrefix = surfaceMatch[1];
      surfaceVariants = variants;
      continue;
    }
    if (!base.startsWith('text-')) continue;
    const colour = base.slice('text-'.length);
    if (INVERTING_TOKENS.has(colour)) foregrounds.push({ key, colour, inverting: true });
    else if (FIXED_FOREGROUNDS.has(colour) || ARBITRARY_COLOR.test(colour)) {
      foregrounds.push({ key, colour, inverting: false });
    }
  }
  if (!surface) return null;

  const surfaceKey = surfaceVariants.slice().sort().join('.');
  const own = foregrounds.filter((f) => f.key === surfaceKey);
  const applicable = own.length ? own : foregrounds.filter((f) => f.key === '');
  // An inverting foreground at the same scope IS the intended pairing; a scope
  // carrying both is ambiguous, and ambiguous is not a violation.
  if (!applicable.length || applicable.some((f) => f.inverting)) return null;

  const state = surfaceVariants.find((v) => STATE_VARIANT.test(v));
  return { surface, surfacePrefix, fixedFg: applicable[0].colour, state };
};

const noInvertingSurfaceWithFixedForeground = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow an inverting surface token paired with a foreground that does not invert.' },
    schema: [],
    messages: {
      crossover:
        '`{{prefix}}-{{surface}}`{{when}} is an INVERTING surface but `text-{{fg}}` is not: --{{surface}} is '
        + '{{light}}% lightness under :root and {{dark}}% under .dark, so it crosses the 50% mid-point between '
        + 'themes while the text stays put — in one of the two themes they land on the same side and the '
        + 'contrast collapses. Measured precedent: DialogHeader painted `from-ink-900 via-ink-700 to-ink-900 '
        + 'text-white`; --ink-900 is rgb(23,27,31) in light (17.31:1 against white) and rgb(244,246,247) in '
        + 'dark (1.08:1), so every dialog title in the app was white-on-near-white. Commit 497cd6e fixed it by '
        + 'moving to --sidebar / --sidebar-accent, which do not invert and happen to equal the light-mode ink '
        + 'values, so the light theme stayed pixel-identical. Two fixes, both correct: (1) paint the surface '
        + 'with a STABLE token — sidebar, sidebar-accent, primary, primary-pressed, brand-500, brand-600, '
        + 'success, warning, info, gold, destructive, destructive-strong, ring — which hold one value in both '
        + 'themes; or (2) drop the fixed foreground and use the matching -foreground / paired token instead '
        + '(`bg-card text-card-foreground`, `bg-success-tint text-success-strong`), so both halves flip '
        + 'together. If the surface and the label are never on the same element, add an '
        + 'eslint-disable-next-line saying so.',
    },
  },
  create(context) {
    const report = (node, hit) => {
      const [light, dark] = INVERTING_TOKENS.get(hit.surface);
      context.report({
        node,
        messageId: 'crossover',
        data: {
          prefix: hit.surfacePrefix,
          surface: hit.surface,
          fg: hit.fixedFg,
          when: hit.state ? ' on `' + hit.state + ':`' : '',
          light: light.toFixed(2),
          dark: dark.toFixed(2),
        },
      });
    };

    return {
      'Program:exit'(program) {
        /* One walk, tracking the parent explicitly rather than trusting
         * node.parent — a set ROOT is any class expression whose parent is not
         * itself one, and that question has to be answerable for every node.
         * The walk continues THROUGH a root: a ternary arm may hold a whole
         * JSXElement, whose own className is a separate root further down. */
        /*
         * CLASSNAME CONTEXT GATE (2026-09-02). Without this the rule walked the
         * whole program and reported any string that merely LOOKED like classes.
         * The adversarial pass caught it on real shapes:
         *
         *   const MSG = 'Could not load bg-ink-900 text-white preset';   <- prose
         *   return 'from-ink-900 to-ink-900 text-white';                 <- a plain return
         *
         * Neither reaches a `class` attribute, so neither can be a contrast bug.
         * A rule that flags prose gets disabled, and then it protects nothing.
         *
         * In context means: a className JSX attribute, an argument to a class
         * combinator, or an object property / variable whose NAME ends in Class
         * — which is how this codebase stores class strings outside JSX
         * (noticeThemes.ts uses `buttonClass`, `heroClass`, `iconClass`).
         *
         * KNOWN LIMITATION, deliberate: a class string held in a generically
         * named binding (`const TOGGLES = [{ on: 'bg-ink-900 text-white' }]`) is
         * not reachable from here and is silently skipped. Quiet beats noisy:
         * every miss is one this rule never claimed, whereas one false positive
         * costs the whole rule.
         */
        const CLASS_FNS = new Set(['cn', 'clsx', 'classNames', 'twMerge', 'cva']);
        const NAME_IS_CLASSY = /class(es|name)?$/i;
        const opensContext = (n) => {
          if (!n || typeof n.type !== 'string') return false;
          if (n.type === 'JSXAttribute') return n.name && n.name.name === 'className';
          if (n.type === 'CallExpression') {
            const c = n.callee;
            return !!c && ((c.type === 'Identifier' && CLASS_FNS.has(c.name))
              || (c.type === 'MemberExpression' && c.property && CLASS_FNS.has(c.property.name)));
          }
          if (n.type === 'Property') {
            const k = n.key;
            const name = k && (k.name || k.value);
            return typeof name === 'string' && NAME_IS_CLASSY.test(name);
          }
          if (n.type === 'VariableDeclarator') {
            return n.id && n.id.type === 'Identifier' && NAME_IS_CLASSY.test(n.id.name);
          }
          return false;
        };

        const visit = (node, parent, inCtx) => {
          if (!node || typeof node !== 'object') return;
          const ctx = inCtx || opensContext(node);
          if (ctx && typeof node.type === 'string' && isClassExpr(node) && !isClassExpr(parent)) {
            for (const set of classSets(node)) {
              const hit = crossoverIn(set);
              if (!hit) continue;
              // One report per root: a gradient names three stops and both arms
              // of a ternary can be wrong, but there is one edit to make.
              report(node, hit);
              break;
            }
          }
          for (const key of Object.keys(node)) {
            // `tokens` / `comments` hang off Program and carry a `type` of their
            // own; descending into them walks the whole file a second time.
            if (key === 'parent' || key === 'tokens' || key === 'comments' || key === 'loc') continue;
            const v = node[key];
            if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c, node, ctx); }
            else if (v && typeof v.type === 'string') visit(v, node, ctx);
          }
        };
        visit(program, null, false);
      },
    };
  },
};

const localPlugin = {
  rules: {
    'no-duplicate-chart-series-color': noDuplicateChartSeriesColor,
    'no-raw-time-slot-render': noRawTimeSlotRender,
    'no-unscrollable-dialog-content': noUnscrollableDialogContent,
    'dialog-single-scroller': dialogSingleScroller,
    'no-inverting-surface-with-fixed-foreground': noInvertingSurfaceWithFixedForeground,
  },
};

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
      // Booking-band guard: a stored time_slot may not be rendered raw — it is
      // derived, can be stale, and holds ~20 spellings of four bands. Inert on
      // files that never touch the column.
      'local/no-raw-time-slot-render': 'error',
      // Modal-escape guard: a bare `overflow-hidden` on <DialogContent>
      // out-merges the base scroll and can hide a modal's own dismiss button.
      // Inert on files with no DialogContent.
      'local/no-unscrollable-dialog-content': 'error',
      // The other half of that contract: a <DialogContent> that KEPT its base
      // `overflow-y-auto` must not also hand a DIRECT child its own scroll
      // region — two nested scrollbars, and the outer one takes the wheel while
      // hiding the footer below its own fold. A scroller deeper than a direct
      // child is a deliberate sub-region and is left alone. Inert on files with
      // no DialogContent.
      'local/dialog-single-scroller': 'error',
      // Dark-mode crossover guard: a surface token whose lightness INVERTS
      // between :root and .dark (38 of the 54 in brand.css) must not be paired
      // with a foreground that stays put — a literal `text-white`/`text-black`
      // or one of the 16 stable tokens. That is the DialogHeader defect
      // (17.31:1 in light, 1.08:1 in dark) generalised. Each conditional branch
      // is judged on its own, so a surface in one ternary arm never pairs with
      // a foreground in the other. Inert on files with no Tailwind colour
      // classes.
      'local/no-inverting-surface-with-fixed-foreground': 'error',
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

  /*
   * react-hooks/exhaustive-deps — ERROR, scoped to Manage Jobs (2026-08-18).
   *
   * WHY THIS FILE, AS AN ERROR, WHILE THE REST OF THE APP IS UNGATED
   *
   * A dependency omission here shipped a user-visible bug twice in one day.
   * The search box was wired into the request payload and the response cache
   * key but not into the refetch effect's deps, so typing triggered nothing:
   * the table kept the page it already had and narrowed it in memory. That is
   * indistinguishable from the behaviour the fix was meant to replace, which
   * is why it survived review and a deploy.
   *
   * The file is clean as of this commit, so the rule is an ERROR rather than a
   * warning — a warning in a codebase that emits 55 of them app-wide is read
   * as noise and scrolls past. Enabling it everywhere at once would mean
   * either 55 warnings nobody actions, or a `useCallback` refactor of `load`
   * across ~20 pages in a single change. Neither belongs in a bug fix.
   *
   * reportUnusedDisableDirectives is the other half and arguably the more
   * important one. Three disables in this file were written as
   * `eslint-disable-next-line` INSIDE a single-line effect — which suppresses
   * the following line and therefore nothing at all. They read as considered
   * decisions while silencing no warning; only the unused-directive check
   * surfaces that.
   *
   * The remaining disables are legitimate: `load` is redeclared on every
   * render, so listing it would loop. Fixing that properly means wrapping it
   * in useCallback with its own dependency set — worth doing, but as its own
   * change with its own testing.
   */
  {
    files: ['src/app/(authed)/jobs/page.tsx'],
    plugins: { 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: { 'react-hooks/exhaustive-deps': 'error' },
  },

  /*
   * BRAND GUARD — brand/no-raw-palette-utility (WARNING, editor feedback only)
   *
   * Flags a raw Tailwind palette class inside a JSX `className` — `bg-slate-100`,
   * `hover:text-red-600`, `border-gray-200`, `from-sky-50`. A raw palette class is
   * exactly as hard-coded as `#f1f5f9`; it just doesn't look like one, which is why
   * ~1500 of them accumulated before anything checked. `src/brand/palette.ts` is the
   * rebrand seam and every raw class is a colour that seam cannot reach — Tailwind's
   * `slate` grey is a BLUE grey while the brand ink ramp is warm, so a rebrand that
   * edits palette.ts leaves those call sites rendering the old identity. Semantic
   * classes (`bg-primary`, `text-muted-foreground`, `border-border`) resolve through
   * the generated tokens in src/app/brand.css and are the migration target.
   *
   * WHY THIS IS A SEPARATE RULE KEY AND NOT ANOTHER `no-restricted-syntax` ENTRY
   *
   * `no-restricted-syntax` already carries three entries at ERROR (the Dialog
   * onOpenChange guard and the two useEffect-fetch guards), plus per-file carve-outs
   * below that switch it off or narrow it. Flat config does NOT merge rule options:
   * the last config object matching a file replaces that rule key outright, and one
   * key carries exactly one severity. So appending a fourth entry at the end would
   * have to either
   *   (a) restate the rule for every `src/**` file — silently discarding the
   *       per-file carve-outs below, which exist precisely because those files
   *       legitimately trip the Dialog rule; or
   *   (b) share the existing ERROR severity — turning ~1500 pre-existing call sites
   *       into hard lint errors and red-walling the repo mid-sweep; or
   *   (c) drop to WARN for all four — quietly downgrading three guards that are
   *       meant to fail a build.
   * A distinct rule key has its own severity and clobbers nothing. This is the same
   * reasoning that made local/no-unscrollable-dialog-content its own rule.
   *
   * WHY WARN. The sweep replacing these classes with tokens is in flight; an ERROR
   * would block every unrelated change until it finishes. The rule's job here is the
   * squiggle under the class as you type it, so no NEW ones land while the existing
   * ones are being retired. Note that `npm run lint:flat` runs with
   * `--max-warnings=0`, so these warnings do fail that script (and CI) until the
   * sweep reaches zero — if the sweep won't land in the same change, set this to
   * 'off' rather than deleting the block.
   *
   * THE REAL GATE IS THE CLI. `npm run check:brand` (scripts/check-brand-tokens.js)
   * is broader and authoritative: hex/rgb/hsl literals, the 12px type floor, weights
   * above 600, logo assets outside <Logo>, and src/app/globals.css — none of which
   * an ESQuery selector over className literals can see. This rule is the editor
   * half of that checker, not a second source of truth.
   *
   * The pattern below is a copy of RAW_PALETTE in scripts/check-brand-tokens.js
   * (a lint config can't import it without adding a module-level require). It
   * enumerates stock Tailwind hues and shades — a fixed upstream list, not a moving
   * target. Keep the two in sync; the checker's copy is the one under test
   * (tests/brand-tokens.test.js) and the one that decides a build.
   */
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      brand: {
        rules: {
          'no-raw-palette-utility': {
            meta: {
              type: 'problem',
              docs: {
                description:
                  'Disallow raw Tailwind palette utilities in className — use the brand tokens.',
              },
              schema: [],
              messages: {
                raw:
                  '`{{cls}}` is a raw Tailwind palette colour, not a brand token, so a rebrand '
                  + 'cannot reach it (src/brand/palette.ts is the only seam). Use the semantic '
                  + 'class that carries the same meaning — bg-primary / bg-card / bg-muted, '
                  + 'text-foreground / text-muted-foreground, border-border, ring-ring — or add '
                  + 'the token in src/brand/tokens.ts and re-run `npm run brand:gen`. '
                  + '`npm run check:brand` lists every remaining site.',
              },
            },
            create(context) {
              const RAW_PALETTE =
                /\b(bg|text|border|ring|from|via|to|fill|stroke|divide|outline|placeholder|decoration|shadow|accent|caret)-(slate|gray|zinc|neutral|stone|sky|blue|indigo|violet|purple|fuchsia|pink|rose|red|orange|amber|yellow|lime|green|emerald|teal|cyan)-(50|100|200|300|400|500|600|700|800|900|950)\b/;

              // Report once per offending string chunk, naming the first hit so the
              // message is actionable without re-reading the line.
              const check = (node, value) => {
                if (typeof value !== 'string') return;
                const hit = RAW_PALETTE.exec(value);
                if (hit) context.report({ node, messageId: 'raw', data: { cls: hit[0] } });
              };

              return {
                // Covers `className="…"`, `className={'…'}`, and string arms inside
                // cn()/clsx() calls and ternaries — anywhere a literal sits beneath
                // the attribute.
                'JSXAttribute[name.name="className"] Literal': (node) => check(node, node.value),
                // …and the static chunks of `className={`… ${x} …`}`.
                'JSXAttribute[name.name="className"] TemplateElement': (node) =>
                  check(node, node.value.raw),
              };
            },
          },
        },
      },
    },
    rules: {
      'brand/no-raw-palette-utility': 'warn',
    },
  },

  // Exclusions — never lint these.
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'public/**',
      // tsc output that `npm test` regenerates each run — generated code, and
      // linting it would just re-report whatever src/lib/job-slots.ts says.
      '.test-build/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
  },
];

export default config;
