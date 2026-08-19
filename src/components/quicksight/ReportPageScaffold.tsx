'use client';

/*
 * ReportPageScaffold — shared page shell for every native QuickSight
 * report page (Phase 0 infra; consumed by all 10 per-report pages built
 * in later phases).
 *
 * Purely PRESENTATIONAL + COMPOSABLE: it owns the chrome (Title-Case
 * header band, an optional filters row, a download CTA slot, and the
 * four mutually-exclusive page states) but NEVER fetches or knows about
 * a specific report. Pages drive it with flags derived from their own
 * useFetch/useFetchOnce call (per the mandatory fetch-hooks rule — this
 * component must not introduce raw useEffect+api.get).
 *
 * State precedence (first match wins, so a page can pass several true at
 * once during transitions without flicker):
 *   accessDenied → error → loading → isEmpty → children
 *
 * The accessDenied panel is the FE half of the BE `requireQuickSight`
 * hard-403 contract: when a report endpoint returns 403 the page sets
 * `accessDenied` and the operator sees a clean access panel instead of a
 * raw error string (registry decision `accessDenied`).
 *
 * Reused primitives: Card / CardContent (ui/card). The header band copies
 * the /reports landing header style (icon + Title-Case h1 + muted subtitle)
 * so QuickSight reads as part of the same reporting family. The download
 * affordance is the canonical DownloadButton — passed via `onDownload`
 * rather than forked here.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Inbox, Loader2, Lock, type LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { DownloadButton } from '@/components/ui/download-button';

export type ReportPageScaffoldProps = {
  /* Title-Case page title rendered in the header band. */
  title: string;
  /* Optional muted sub-line under the title. */
  subtitle?: string;
  /*
   * Optional leading icon for the header (lucide). Defaults to none —
   * callers typically pass the same icon used on the landing card so the
   * card → page transition feels continuous.
   */
  icon?: LucideIcon;
  /*
   * Filters slot — the page renders its QuickSightFilterBar (or any
   * bespoke filter row) here. Sits in a Card directly under the header.
   * Omit for filter-less reports.
   */
  filters?: ReactNode;
  /* True while the report data request is in flight. */
  loading: boolean;
  /*
   * Non-null human-readable error message (non-403 failure). Shown in a
   * red-tinted error panel. 403s should set `accessDenied` instead.
   */
  error?: string | null;
  /*
   * True when the report endpoint returned 403 (missing ef-QuickSight or
   * the per-report key). Renders the access panel and suppresses the
   * generic error panel.
   */
  accessDenied?: boolean;
  /*
   * True when the request succeeded but returned no rows. Renders a
   * neutral empty-state panel.
   */
  isEmpty: boolean;
  /*
   * Optional download handler. When provided, the canonical green
   * DownloadButton renders in the toolbar row. `downloading` toggles its
   * busy state. The button is disabled while the page is loading or in a
   * no-data / denied / error state (nothing useful to export).
   */
  onDownload?: () => void;
  downloading?: boolean;
  /*
   * The successful report body (table, grid, KPI cards…). Rendered only
   * when not loading / empty / error / denied.
   */
  children: ReactNode;
};

export function ReportPageScaffold({
  title,
  subtitle,
  icon: Icon,
  filters,
  loading,
  error,
  accessDenied = false,
  isEmpty,
  onDownload,
  downloading = false,
  children,
}: ReportPageScaffoldProps) {
  // Export only makes sense when there's real data on screen.
  const canDownload = !loading && !accessDenied && !error && !isEmpty;

  return (
    <div className="space-y-4">
      {/* Header band — mirrors the /reports landing header (icon + Title-Case
          h1 + muted subtitle). DownloadButton is right-aligned in the same
          row when an onDownload handler is supplied. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Back link — QuickSight is not a sidebar menu (it's the dashboard
              header button → /quicksight landing), so every report needs an
              explicit way back to the landing. Lives in the shared scaffold so
              all 10 reports get it from one place. */}
          <Link
            href="/quicksight"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-1"
          >
            <ArrowLeft className="size-4" />
            QuickSight Reports
          </Link>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            {Icon && <Icon className="size-6 shrink-0" />}
            <span className="truncate">{title}</span>
          </h1>
          {subtitle && (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {onDownload && (
          <DownloadButton
            onClick={onDownload}
            disabled={!canDownload}
            downloading={downloading}
            label="Download XLSX"
            title={canDownload ? undefined : 'Nothing to export yet'}
          />
        )}
      </div>

      {/* Filters row — its own card so it stays visible above whichever
          state panel renders below. */}
      {filters && (
        <Card>
          <CardContent className="p-4">{filters}</CardContent>
        </Card>
      )}

      {/* Mutually-exclusive state panels (precedence: denied → error →
          loading → empty → children). */}
      {accessDenied ? (
        <AccessDeniedPanel />
      ) : error ? (
        <StatePanel
          tone="error"
          icon={AlertTriangle}
          title="Couldn’t load this report"
          message={error}
        />
      ) : loading ? (
        <StatePanel
          tone="muted"
          icon={Loader2}
          spin
          title="Loading report…"
          message="Fetching the latest data."
        />
      ) : isEmpty ? (
        <StatePanel
          tone="muted"
          icon={Inbox}
          title="No data for these filters"
          message="Try widening the filters or clearing them to see all rows."
        />
      ) : (
        children
      )}
    </div>
  );
}

/*
 * Clean access-denied panel — the FE side of the hard-403 contract.
 * Title-Case copy; names the family key so an operator knows exactly
 * what to ask an admin to grant.
 */
function AccessDeniedPanel() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-warning-tint text-warning-strong">
          <Lock className="size-6" />
        </span>
        <div className="space-y-1">
          <div className="text-base font-semibold">Access Denied</div>
          <p className="max-w-md text-sm text-muted-foreground">
            You don’t have permission to view this report. Ask an admin to grant
            you QuickSight access (<code className="mx-0.5">ef-QuickSight</code>)
            and this report’s view permission in Settings → Manage Roles.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/*
 * Generic single-panel state (loading / empty / error). `tone` picks the
 * icon colour; `spin` animates the icon (for the loading spinner).
 */
function StatePanel({
  tone,
  icon: Icon,
  spin = false,
  title,
  message,
}: {
  tone: 'muted' | 'error';
  icon: LucideIcon;
  spin?: boolean;
  title: string;
  message?: string;
}) {
  const iconColor = tone === 'error' ? 'text-urgent-strong' : 'text-muted-foreground';
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <Icon className={`size-8 ${iconColor} ${spin ? 'animate-spin' : ''}`} />
        <div className="space-y-1">
          <div className="text-base font-semibold">{title}</div>
          {message && (
            <p className="max-w-md text-sm text-muted-foreground">{message}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
