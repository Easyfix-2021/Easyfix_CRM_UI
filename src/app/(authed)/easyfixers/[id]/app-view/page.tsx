'use client';
/*
 * Read-only mirror of the technician app, rendered in a phone frame.
 *
 * A real PAGE, not a modal — the same call the Self-Registration
 * verification screen made (see ../verification/page.tsx, reached by
 * router.push, with no tbl_menu row of its own). EasyfixerModal is
 * specifically the wrong host twice over: it is `h-[85vh]`, which leaves
 * roughly 630 px of body on a 900 px screen and would force the 844 px
 * phone to ~0.75 scale before the page chrome is even counted; and it is
 * a `<form id="efr-form">` under useFormDirtyGuard, so an iframe whose
 * inner app writes nothing would still sit inside a dirty-state guard
 * built for a save button that does not exist here.
 *
 * ── How the mirror works ────────────────────────────────────────────────
 *   1. The technician app ships as a static web export inside the CRM's
 *      own image at public/technician-mirror/<version>/ (see the mirror
 *      stage in the Dockerfile). It is same-origin, so it is not a third
 *      party and there is no CORS or cookie-partitioning story.
 *   2. This page seeds the six localStorage keys the app boots from
 *      (@/lib/mirror-storage) and only then mounts the iframe.
 *   3. Inside the frame the app fetches from the CRM's read-only backend
 *      proxy at /api/admin/easyfixers/:id/mirror/*, which is GET-only and
 *      405s anything else, and whose responses pass through the admin
 *      mobile-masking middleware.
 *
 * ── Expected shape of GET /admin/easyfixers/:id/mirror-session ──────────
 * Built alongside this page. Every field below is read defensively so a
 * narrower payload degrades to a visible banner rather than a crash:
 *   {
 *     technician:           object,          // seeded verbatim as easyfix.technician
 *     technicianAppVersion: string | null,   // last version the device reported
 *     language:             string | null,   // optional; falls back to en
 *   }
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { BackLink } from '@/components/ui/back-link';
import { PhoneFrame } from '@/components/easyfixer/PhoneFrame';
import { clearMirrorStorage, seedMirrorStorage } from '@/lib/mirror-storage';

/*
 * Which bundle this image ships. Set by the Dockerfile from the single
 * `ARG MIRROR_APP_VERSION`, which also names the directory the bundle is
 * unpacked into — so the path below and the folder on disk agree by
 * construction rather than by anyone remembering to update both.
 */
const MIRROR_VERSION = process.env.NEXT_PUBLIC_MIRROR_APP_VERSION || '3.0.0';

type MirrorSession = {
  technician?: Record<string, unknown> | null;
  technicianAppVersion?: string | null;
  language?: string | null;
};

export default function EasyfixerAppViewPage() {
  const params = useParams<{ id: string }>();
  const efrId = Number(params.id);
  const validEfrId = Number.isInteger(efrId) && efrId > 0;

  /*
   * The nonce in the fetch KEY is mandatory, not decoration. @/lib/hooks
   * memoises every GET for 30 s and dedupedGet short-circuits on a cache
   * hit before the request is ever made, so `refetch()` on a stable key
   * hands back the same payload it already had. Rolling the key is the
   * only thing that guarantees a real round-trip — and it doubles as the
   * iframe's cache-buster, so one state drives both halves of a refresh.
   */
  const [nonce, setNonce] = useState(0);
  const { data, loading, error } = useFetch<MirrorSession>(
    validEfrId ? `/admin/easyfixers/${efrId}/mirror-session?n=${nonce}` : null,
    { enabled: validEfrId },
  );

  /* `ready` gates the iframe: it flips only AFTER the seed is verified. */
  const [ready, setReady] = useState(false);
  const [missingKeys, setMissingKeys] = useState<string[]>([]);

  useEffect(() => {
    if (!data || !validEfrId) return;
    // Clear on mount as well as unmount: an operator moving from one
    // technician to the next must never inherit the previous session's
    // account-scoped cache (easyfix.user.<efrId>.*).
    clearMirrorStorage();
    const missing = seedMirrorStorage({
      efrId,
      technician: data.technician ?? {},
      language: data.language ?? (data.technician?.language as string | undefined) ?? 'en',
    });
    setMissingKeys(missing);
    /*
     * Seed in the effect BODY, then flip `ready` so the iframe mounts on
     * the NEXT commit. React guarantees the effect has run to completion
     * before the state update it schedules is committed, so the storage
     * is populated before the frame's document starts executing. This is
     * an ordering guarantee, not a timing one — no setTimeout involved.
     */
    setReady(missing.length === 0);
  }, [data, efrId, validEfrId]);

  useEffect(() => () => {
    clearMirrorStorage();
    /*
     * The module cache in @/lib/hooks is a plain Map with no eviction.
     * This page can sit open for a whole shift, so drop our entries on
     * the way out rather than leaving a stale technician session payload
     * resident for the life of the tab.
     */
    invalidateFetch((k) => k.includes('/mirror-session'));
  }, []);

  const refresh = useCallback(() => {
    invalidateFetch((k) => k.includes('/mirror-session'));
    setReady(false);
    setNonce(Date.now());
  }, []);

  const technicianVersion = (data?.technicianAppVersion || '').trim();

  return (
    <div className="space-y-4 p-4 md:p-6">
      <BackLink href="/easyfixers" label="Back to Easyfixers" />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Technician App View</h1>
        <Button variant="outline" onClick={refresh} disabled={loading}>
          <RefreshCw className="size-4" /> Refresh
        </Button>
      </div>

      {/*
        * Version banner. The mirror renders whatever bundle this image
        * shipped, which is not necessarily what the technician is holding
        * — so the page always says which, and never implies a match it
        * cannot prove. Roughly three-quarters of technician records carry
        * no reported version at all today, so "unknown" is the common
        * case and gets its own honest wording rather than being folded in
        * with "matches".
        */}
      {technicianVersion === '' ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-tint px-3 py-2 text-sm text-warning-strong">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span>
            Technician version unknown — screens may differ. Mirror renders v{MIRROR_VERSION}.
          </span>
        </div>
      ) : technicianVersion === MIRROR_VERSION ? (
        <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success-tint px-3 py-2 text-sm text-success-strong">
          <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
          <span>Mirror renders v{MIRROR_VERSION} — the version this technician last reported.</span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-urgent/40 bg-urgent-tint px-3 py-2 text-sm text-urgent-strong">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span>
            Mirror renders v{MIRROR_VERSION} · this technician last reported v{technicianVersion}
            {' '}— screens may differ
          </span>
        </div>
      )}

      {!validEfrId && <div className="text-sm text-urgent">Invalid technician id.</div>}
      {validEfrId && loading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {validEfrId && !loading && error && (
        <div className="text-sm text-urgent">{error}</div>
      )}

      {/* All-or-nothing seed check — see the ⚠️ in @/lib/mirror-storage. */}
      {missingKeys.length > 0 && (
        <div className="rounded-md border border-urgent/40 bg-urgent-tint px-3 py-2 text-sm text-urgent-strong">
          Could not seed the mirror session — missing {missingKeys.join(', ')}. The app view is
          not shown, because a partial seed renders screens that look fine and behave wrongly.
        </div>
      )}

      {ready && (
        <PhoneFrame>
          {/*
            * NO `sandbox` ATTRIBUTE — deliberate, and it looks like an
            * omission otherwise. Sandboxing without `allow-same-origin`
            * gives the frame an opaque origin, where every localStorage
            * access THROWS a SecurityError: the six keys seeded above
            * would be unreachable and the app would boot signed-out. Add
            * `allow-same-origin` back and the sandbox is escapable by the
            * frame itself anyway (it can reach out to the parent
            * document), so it buys nothing it did not just give away.
            * The real containment is elsewhere: the token is a non-JWT
            * sentinel the backend rejects, and the proxy is GET-only.
            *
            * `allow=""` is the attribute doing real work here. An empty
            * permissions policy denies camera, microphone and geolocation
            * to the frame outright, so the mirrored app — which asks for
            * all three on a phone — can never raise a browser permission
            * prompt on the operator's machine.
            */}
          {/*
            * `/index.html` is explicit ON PURPOSE — the directory URL does
            * not work. Next.js serves public/ as flat files with no
            * directory-index behaviour, so a request for
            * `/technician-mirror/<v>/` 308-redirects to the same path with
            * the trailing slash stripped and then falls through to the
            * CRM's own 404 page (measured against `next start`, not
            * assumed). The frame would have rendered a CRM 404 instead of
            * the app, which looks like a broken bundle rather than a
            * routing detail. Naming index.html returns the bundle at 200.
            */}
          <iframe
            src={`/technician-mirror/${MIRROR_VERSION}/index.html?m=${nonce}`}
            title="Read-only mirror of the technician app"
            width={390}
            height={844}
            allow=""
            referrerPolicy="same-origin"
            className="border-0 block"
          />
        </PhoneFrame>
      )}

      <p className="text-center text-xs text-muted-foreground">
        Read-only. Every request the framed app makes is replayed through a GET-only proxy, and
        its session token is deliberately invalid — nothing here can change the technician&apos;s data.
      </p>
    </div>
  );
}
