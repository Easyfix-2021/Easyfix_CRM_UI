'use client';

/*
 * Route-level error boundary for every authenticated screen.
 *
 * ─── WHY THIS EXISTS (2026-09-09) ──────────────────────────────────────────
 *
 * There was no error.tsx anywhere under src/app. One component throwing during
 * render therefore hit Next's ROOT fallback, which replaces the entire
 * document with the bare sentence "Application error: a client-side exception
 * has occurred while loading crm.easyfix.in" — no sidebar, no navbar, no way
 * to get anywhere else, and no indication of which part failed.
 *
 * That is what a temporal-dead-zone bug in ONE report body did to the whole
 * Performance page: four working tabs and every other screen's navigation went
 * down with it, and the only route out was editing the URL by hand.
 *
 * Sitting inside the (authed) group, this boundary replaces only what the
 * layout renders into <main> — the sidebar and navbar in layout.tsx stay
 * mounted and usable. A broken report becomes one broken panel rather than a
 * broken CRM.
 *
 * ─── WHAT IT DELIBERATELY SHOWS ────────────────────────────────────────────
 *
 * The DIGEST, prominently. Production bundles are minified, so a client error
 * reads `Cannot access 'I' before initialization` — an identifier that exists
 * in no source file. The digest is the only stable handle that ties what a
 * user saw to what the logs recorded, and diagnosing the outage above cost
 * hours precisely because nobody could quote one. It is shown as copyable text
 * rather than hidden behind a console instruction.
 *
 * It does NOT pretend to recover. `reset()` re-renders the same subtree with
 * the same inputs; for a deterministic fault (the TDZ one fired on every
 * mount) it fails again immediately. So the button is honest about being a
 * retry, and a route out is offered beside it rather than being the fallback
 * after a retry silently fails twice.
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCw, LayoutDashboard } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function AuthedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    /*
     * Console, not a toast: the toast host lives inside the tree this boundary
     * just replaced. Kept so the stack is one keystroke away in a browser the
     * moment someone reports a blank panel — which is more than we had.
     */
    // eslint-disable-next-line no-console
    console.error('[authed/error]', error?.digest ?? '(no digest)', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl py-10">
      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="flex items-start gap-3">
            <span className="rounded-full bg-urgent-tint p-2 text-urgent-strong shrink-0">
              <AlertTriangle className="size-5" />
            </span>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">This Screen Could Not Be Displayed</h1>
              <p className="text-sm text-muted-foreground">
                Something on this page failed while rendering. The rest of the CRM is
                unaffected — use the sidebar to carry on, or try loading this screen again.
              </p>
            </div>
          </div>

          {/*
            * Shown whenever the runtime gives us either handle. In production the
            * message is usually minified and the digest is the useful one; in dev
            * it is the reverse. Neither is guaranteed, hence the fallback line.
            */}
          <div className="rounded border bg-muted/30 p-3 text-xs space-y-1">
            <p className="font-medium text-foreground">Details For Support</p>
            {error?.message ? (
              <p className="font-mono break-words">{error.message}</p>
            ) : (
              <p className="text-muted-foreground">No error message was provided by the browser.</p>
            )}
            {error?.digest && (
              <p className="font-mono text-muted-foreground">
                Digest: <span className="select-all">{error.digest}</span>
              </p>
            )}
            <p className="text-muted-foreground">
              Quote the line above when reporting this — it is what ties this screen to the
              server logs.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {/*
              * "Try Again" rather than "Retry" or "Reload": reset() re-renders the
              * same subtree, so for a deterministic fault it will fail again. The
              * label promises an attempt, not a fix.
              */}
            <Button onClick={() => reset()}>
              <RotateCw className="size-4 mr-1.5" /> Try Again
            </Button>
            <Button variant="outline" asChild>
              <Link href="/dashboard">
                <LayoutDashboard className="size-4 mr-1.5" /> Go To Dashboard
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
