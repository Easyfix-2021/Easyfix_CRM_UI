'use client';

/*
 * The one error boundary on the MTD tab, and it wraps exactly one card.
 *
 * WHY IT EXISTS. The client document reads four keys off the report response —
 * `tierAging`, `escalatedBySet`, `completedOnCheckin` and the per-bucket
 * `completedCheckin` — with no fallback, because a fallback for a field the
 * backend always sends is dead code. That is the right call for a CRM and a
 * backend deployed together, and it has one failure mode when they are not:
 * the card dereferences `undefined` while React is BUILDING the element tree,
 * which is not a render the card can fail on its own. Without a boundary the
 * throw unwinds to src/app/(authed)/error.tsx — the only other boundary in the
 * app — and that one replaces everything the authed layout puts in <main>. So a
 * missing key on ONE card would blank the filter bar and all eleven sections,
 * none of which need those keys.
 *
 * It is also invisible to a smoke test: the card only renders when exactly one
 * client is ticked, so a tab opened with no client selected looks perfectly
 * healthy. The deploy order (backend first, then CRM) is the real protection;
 * this is what stands behind it when the order slips or the backend is rolled
 * back after the CRM has shipped.
 *
 * WHY IT IS LOCAL rather than a shared `<ErrorBoundary>` in components/. The
 * hazard is this card's, created by this card's hard dependency. A shared
 * boundary would be an invitation to wrap sections that have no such
 * dependency, and wrapping everything in boundaries is how a page learns to
 * swallow bugs quietly instead of failing where someone will notice.
 *
 * NOTE it does not attempt to recover or retry. A missing response key does not
 * fix itself between renders, and a retry button that never works is worse than
 * the plain statement of what is wrong.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

type Props = { children: ReactNode };
type State = { message: string | null };

export class ClientReportBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  /*
   * Logged, not swallowed. This is the only place the failure is recorded — the
   * card below says what a reader needs, which is not a stack trace.
   */
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[MTD] client report card failed to render', error, info.componentStack);
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <Card>
        <CardContent className="flex items-start gap-3 p-4">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-urgent-strong" aria-hidden />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">The client document could not be rendered.</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The rest of this tab is unaffected and its figures are good. The usual cause is a CRM
              deployed ahead of its backend, so the report response is missing a field this card needs
              — it resolves once the matching backend build is live. Everything else on the page reads
              fields that have been there all along.
            </p>
            <p className="font-mono text-xs text-muted-foreground">{this.state.message}</p>
          </div>
        </CardContent>
      </Card>
    );
  }
}
