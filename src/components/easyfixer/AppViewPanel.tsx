'use client';

/*
 * AppViewPanel — the technician's app, floating over the CRM.
 *
 * ─── WHY A PANEL AND NOT A PAGE ────────────────────────────────────────────
 *
 * This started as a route (/easyfixers/[id]/app-view). That was wrong for the
 * actual job: an operator is on the phone walking a technician through his
 * screen, and needs the CRM at the same time — the technician's record, his
 * jobs, the notes they are typing. A full page took the whole CRM away to show
 * one thing, so supporting someone meant navigating back and forth and losing
 * your place each time.
 *
 * It floats, drags and collapses instead, mounted once at the authed layout so
 * it survives navigation. Exactly the shape LiveCallPanel already uses — which
 * is not a coincidence, since the operator usually has both open at once.
 *
 * ─── AN IMPERATIVE OPENER, NOT A CONTEXT ───────────────────────────────────
 *
 * openAppView() dispatches a window event that the single mounted host picks
 * up, mirroring showToast() in components/ui/toast.tsx. LiveCallPanel uses a
 * React context instead, and that is right for it: a call has state many
 * components read. This has one trigger and one host, so a provider would be
 * ceremony around a single call site.
 *
 * ─── THE IFRAME MUST NOT REMOUNT ───────────────────────────────────────────
 *
 * Collapsing hides the panel with CSS rather than unmounting the frame.
 * Unmounting would tear down the app's whole session — the operator would come
 * back to a cold boot and lose whatever screen they had navigated to, which is
 * the one thing a support tool must not do mid-call.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, X, GripVertical, Minus, Maximize2, Smartphone, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { APP_VIEW_PANEL_ATTR } from '@/lib/portal-markers';
import { useDraggablePanel } from '@/components/calls/useDraggablePanel';
import { clearMirrorStorage, seedMirrorStorage } from '@/lib/mirror-storage';

/*
 * Which bundle this image ships. Set by the Dockerfile from the single
 * ARG MIRROR_APP_VERSION, which also names the directory the bundle is
 * unpacked into — so the path below and the folder on disk agree by
 * construction rather than by anyone remembering to update both.
 */
const MIRROR_VERSION = process.env.NEXT_PUBLIC_MIRROR_APP_VERSION || '3.0.0';

const OPEN_EVENT = 'ef:app-view:open';

/* The app's design viewport. Not arbitrary — every breakpoint inside the
 * bundle is written against it, which is why we scale rather than stretch. */
const FRAME_W = 390;
const FRAME_H = 844;

/* Panel chrome above and below the frame (header, version banner, footer). */
const CHROME_H = 190;

const MIN_SCALE = 0.45;
const MAX_SCALE = 1;

/* Largest scale that still leaves the whole panel on screen, with a margin.
 * Guarded for SSR, where there is no window to measure. */
function fitScale(): number {
  if (typeof window === 'undefined') return 0.8;
  const usableH = window.innerHeight - CHROME_H - 32;
  const usableW = window.innerWidth - 32;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(usableH / FRAME_H, usableW / FRAME_W)));
}

export type AppViewTarget = { efrId: number; name?: string | null };

/** Open the floating App View for a technician. Safe to call from anywhere. */
export function openAppView(target: AppViewTarget): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AppViewTarget>(OPEN_EVENT, { detail: target }));
}

type MirrorSession = {
  technician?: Record<string, unknown> | null;
  technicianAppVersion?: string | null;
  language?: string | null;
};

export function AppViewPanelHost() {
  const [target, setTarget] = useState<AppViewTarget | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => setTarget((e as CustomEvent<AppViewTarget>).detail);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  if (!target) return null;
  /*
   * Keyed on the technician so switching to a different one rebuilds the
   * panel from scratch. Without the key, React would reuse the iframe and the
   * previous technician's app would keep rendering behind a new header — the
   * most dangerous possible bug in a tool whose only job is to show you the
   * right person's screen.
   */
  return <AppViewPanel key={target.efrId} target={target} onClose={() => setTarget(null)} />;
}

function AppViewPanel({ target, onClose }: { target: AppViewTarget; onClose: () => void }) {
  const { efrId } = target;
  const { containerRef, style, positioned, headerHandlers, collapsed, toggleCollapsed } =
    useDraggablePanel({ sessionKey: 'app-view', resetKey: efrId });

  /*
   * The nonce in the fetch KEY is mandatory, not decoration. @/lib/hooks
   * memoises every GET for 30s and short-circuits on a cache hit before the
   * request is made, so refetch() on a stable key hands back what it already
   * had. Rolling the key is the only thing that guarantees a round-trip — and
   * it doubles as the iframe's cache-buster, so one state drives both halves.
   */
  const [nonce, setNonce] = useState(0);
  const { data, loading, error } = useFetch<MirrorSession>(
    `/admin/easyfixers/${efrId}/mirror-session?n=${nonce}`,
  );

  const [ready, setReady] = useState(false);
  const [missingKeys, setMissingKeys] = useState<string[]>([]);
  const frameRef = useRef<HTMLIFrameElement>(null);

  /*
   * ── Size ────────────────────────────────────────────────────────────────
   *
   * The app is drawn for a 390x844 phone. Rendering that at 1:1 plus the
   * panel's own header and banner needs ~950px of height, which is taller
   * than a 900px laptop screen — so the panel hung off the bottom and its
   * controls were unreachable.
   *
   * The fix is SCALE, not stretch. Stretching a fixed-viewport RN app to an
   * arbitrary box makes it lay out for a phone it is not on; scaling keeps
   * every breakpoint and safe-area inset honest and just draws it smaller.
   * transform: scale also leaves the iframe's internal coordinate space
   * untouched, so taps still land where they look.
   *
   * The initial value fits the current viewport, so the panel is never born
   * off-screen; the handle then lets the operator trade size for screen room.
   */
  const [scale, setScale] = useState(() => fitScale());
  const resizing = useRef<{ startY: number; startScale: number } | null>(null);

  // Recompute the ceiling when the window changes — a panel sized for a big
  // screen must not be left hanging off a smaller one after a resize.
  useEffect(() => {
    const onResize = () => setScale((s) => Math.min(s, fitScale()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    resizing.current = { startY: e.clientY, startScale: scale };
    e.preventDefault();
    e.stopPropagation();   // never let the resize gesture start a drag
  }, [scale]);

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    const r = resizing.current;
    if (!r) return;
    // Dragging DOWN grows the panel. FRAME_H converts pixels of pointer
    // travel into scale so the corner tracks the cursor at 1:1.
    const next = r.startScale + (e.clientY - r.startY) / FRAME_H;
    // Ceiling is fitScale(), not MAX_SCALE: the operator can shrink freely but
    // cannot enlarge the panel past the screen. Letting them would recreate the
    // exact bug this resize was added to fix — controls off the bottom edge.
    setScale(Math.min(fitScale(), Math.max(MIN_SCALE, next)));
  }, []);

  const onResizePointerUp = useCallback((e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    resizing.current = null;
  }, []);

  useEffect(() => {
    if (!data) return;
    // Clear on open as well as close: an operator moving from one technician
    // to the next must never inherit the previous account-scoped cache.
    clearMirrorStorage();
    const missing = seedMirrorStorage({
      efrId,
      technician: data.technician ?? {},
      language: data.language ?? (data.technician?.language as string | undefined) ?? 'en',
    });
    setMissingKeys(missing);
    /*
     * Seed in the effect BODY, then flip `ready` so the iframe mounts on the
     * NEXT commit. React guarantees the effect completes before the state
     * update it schedules is committed, so storage is populated before the
     * frame's document executes. An ordering guarantee, not a timing one.
     */
    setReady(missing.length === 0);
  }, [data, efrId]);

  useEffect(() => () => {
    clearMirrorStorage();
    // The hooks cache is a plain Map with no eviction and this panel can sit
    // open for a whole shift — drop our entries rather than leaving a stale
    // technician session resident for the life of the tab.
    invalidateFetch((k) => k.includes('/mirror-session'));
  }, []);

  const refresh = useCallback(() => {
    invalidateFetch((k) => k.includes('/mirror-session'));
    setReady(false);
    setNonce(Date.now());
  }, []);

  const technicianVersion = (data?.technicianAppVersion || '').trim();
  const versionMatches = technicianVersion !== '' && technicianVersion === MIRROR_VERSION;

  return createPortal(
    <div
      ref={containerRef}
      style={style}
      {...APP_VIEW_PANEL_ATTR}
      className={cn(
        'fixed z-50 flex flex-col rounded-xl border border-border bg-card shadow-2xl',
        // Hard ceiling. `scale` already fits the panel to the viewport on open
        // and on resize, so this should never engage — it is here because the
        // failure mode it prevents is the panel's own controls ending up off
        // the top of the screen, i.e. unreachable, which leaves the operator
        // with no way to close or shrink it. A scrollbar is a much better worst
        // case than a trapped panel.
        'max-h-[calc(100vh-1rem)]',
        !positioned && 'bottom-4 right-4',
        collapsed && 'w-auto',
      )}
    >
      {/* Header doubles as the drag handle. */}
      <div
        {...headerHandlers}
        className="flex shrink-0 items-center gap-2 rounded-t-xl border-b border-border bg-muted px-3 py-2"
      >
        <GripVertical className="size-4 shrink-0 text-muted-foreground" />
        <Smartphone className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{target.name || `EFR-${efrId}`}</div>
          {!collapsed && (
            <div className="truncate text-xs text-muted-foreground">Read-only app view</div>
          )}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh app view"
          title="Refresh"
          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand app view' : 'Minimize app view'}
          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          {collapsed ? <Maximize2 className="size-4" /> : <Minus className="size-4" />}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close app view"
          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {/*
        * Body is HIDDEN when collapsed, never unmounted — see the file header.
        * Tearing down the iframe would cold-boot the technician's app and lose
        * whatever screen the operator had reached, mid-call.
        */}
      <div className={cn('min-h-0 flex-1 overflow-y-auto p-3', collapsed && 'hidden')}>
        {/* Version honesty. Roughly three technicians in four report no
            version at all today, so "unknown" is the common case and gets its
            own wording rather than being folded in with "matches". */}
        <div
          className={cn(
            'mb-2 flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs',
            technicianVersion === ''
              ? 'border-warning/40 bg-warning-tint text-warning-strong'
              : versionMatches
                ? 'border-success/30 bg-success-tint text-success-strong'
                : 'border-urgent/40 bg-urgent-tint text-urgent-strong',
          )}
        >
          {versionMatches
            ? <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />
            : <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />}
          <span>
            {technicianVersion === ''
              ? `Technician version unknown — screens may differ. Mirror renders v${MIRROR_VERSION}.`
              : versionMatches
                ? `Mirror renders v${MIRROR_VERSION} — the version this technician last reported.`
                : `Mirror renders v${MIRROR_VERSION} · technician reported v${technicianVersion} — screens may differ.`}
          </span>
        </div>

        {loading && !data && (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        )}
        {!loading && error && <div className="py-8 text-center text-sm text-urgent">{error}</div>}

        {/* All-or-nothing seed check — see the ⚠️ in @/lib/mirror-storage. */}
        {missingKeys.length > 0 && (
          <div className="rounded-md border border-urgent/40 bg-urgent-tint px-3 py-2 text-xs text-urgent-strong">
            Could not seed the mirror session — missing {missingKeys.join(', ')}. The app view is
            not shown, because a partial seed renders screens that look fine and behave wrongly.
          </div>
        )}

        {ready && (
          /*
           * The scaled stage. The OUTER box takes the post-scale dimensions so
           * the panel's own layout reserves the right amount of room —
           * transform does not affect layout size, so without this the panel
           * would still reserve the full 844px and hang off the screen exactly
           * as it did before.
           */
          <div
            style={{ width: FRAME_W * scale, height: FRAME_H * scale }}
            className="relative overflow-hidden"
          >
          <div
            style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
            className="absolute left-0 top-0 overflow-hidden rounded-[1.75rem] border-[10px] border-foreground bg-background"
          >
            {/*
              * NO `sandbox` — deliberate, and it reads as an omission
              * otherwise. Sandboxing without `allow-same-origin` gives the
              * frame an opaque origin where every localStorage access THROWS,
              * so the six seeded keys are unreachable and the app boots
              * signed-out. Add `allow-same-origin` back and the sandbox is
              * escapable anyway. The real containment is elsewhere: the token
              * is a non-JWT sentinel the backend rejects, and the proxy is
              * GET-only.
              *
              * `allow=""` IS doing work — an empty permissions policy denies
              * camera, microphone and geolocation, so the mirrored app can
              * never raise a permission prompt on the operator's machine.
              *
              * `/index.html` is explicit: Next serves public/ as flat files
              * with no directory index, so the bare directory URL 308s and
              * then falls through to the CRM's own 404 page.
              */}
            <iframe
              ref={frameRef}
              src={`/technician-mirror/${MIRROR_VERSION}/index.html?m=${nonce}`}
              title="Read-only mirror of the technician app"
              width={FRAME_W}
              height={FRAME_H}
              allow=""
              referrerPolicy="same-origin"
              className="block border-0"
            />
          </div>
          </div>
        )}

        <div className="mt-2 flex items-end justify-between gap-2">
          <p className="text-xs leading-snug text-muted-foreground">
            Read-only — replayed through a GET-only proxy with an invalid session token.
          </p>
          {/*
            * Resize grip. Drag DOWN to grow.
            *
            * A custom handle rather than CSS `resize`, because CSS resize would
            * stretch the box and leave the 390px app laid out for a width it is
            * not on. This drives `scale`, so the phone gets bigger or smaller
            * and stays a phone.
            *
            * touch-none stops the browser treating the drag as a scroll
            * gesture, which otherwise eats every pointermove on a trackpad.
            */}
          <div
            role="slider"
            aria-label="Resize app view"
            aria-valuemin={Math.round(MIN_SCALE * 100)}
            aria-valuemax={Math.round(fitScale() * 100)}
            aria-valuenow={Math.round(scale * 100)}
            tabIndex={0}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onKeyDown={(e) => {
              // Keyboard parity — a pointer-only control is unreachable.
              if (e.key === 'ArrowUp') setScale((v) => Math.max(MIN_SCALE, v - 0.05));
              if (e.key === 'ArrowDown') setScale((v) => Math.min(fitScale(), v + 0.05));
            }}
            title={`${Math.round(scale * 100)}% — drag to resize`}
            className="flex size-5 shrink-0 cursor-nwse-resize touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <GripVertical className="size-3.5 rotate-45" />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
