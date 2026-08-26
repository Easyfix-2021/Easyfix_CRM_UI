'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, ExternalLink, RefreshCw, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { api, ApiError, type JobLocationResponse, type LiveLocationPing } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/utils';
import { parseIstDateTime } from '@/lib/format';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useUiFlags } from '@/lib/hooks';
import { darkMapStyles, loadGoogleMaps, type GMaps } from '@/lib/google-maps';
import { useTheme } from '@/lib/use-theme';
import { palette } from '@/brand/palette';

/*
 * LiveLocationPopover — shared live-technician-location viewer.
 *
 * Used by BOTH:
 *   (A) Job rows ("Pending App Ack" / "Pending to Close") → source="job"
 *       calls GET /admin/jobs/:id/location (latest ping + breadcrumb track).
 *   (B) Manage Easyfixers rows                            → source="easyfixer"
 *       calls GET /admin/easyfixers/:id/location (latest ping only).
 *
 * Both endpoints return the modern { success, data } envelope unwrapped by
 * lib/api's request(), so this component only ever sees the `data` payload.
 *
 * Polling: while the dialog is open it refetches every POLL_MS (15s). The
 * interval is cleared on close AND on unmount (the effect cleanup) so we never
 * leak a timer or fire a request against a closed dialog. A manual "Refresh"
 * affordance is also offered for impatient operators.
 *
 * Empty state: `latest === null` means the technician hasn't sent a GPS ping
 * (GPS off / no active job) — we show a friendly explainer rather than blank
 * coordinates.
 *
 * Rendered as a Dialog (the repo has no Popover primitive; modals are the
 * established overlay pattern — see EasyfixerTransactionsModal et al.). Kept
 * compact (max-w-md) so it reads as a lightweight popover, not a full modal.
 */

const POLL_MS = 15_000;

/*
 * A position is only called "live" if it arrived within this window.
 *
 * Two minutes, not the 15s poll interval: a technician's device reports on its
 * own schedule, so a 30s-old fix is still genuinely where he is. Anything older
 * is a last-known position, and saying so is the whole point of this block.
 */
const LIVE_WINDOW_MS = 120_000;

type Freshness = 'live' | 'stale' | 'unknown-age' | 'none';

/*
 * Which of the four states a ping is in.
 *
 * This exists because the popover used to imply everything it showed was live —
 * it polled every 15s and said so in the footer. Once the legacy fallback
 * landed, most rows are hours old and some have NO KNOWN AGE, and refreshing a
 * stale row every 15s is the worst case: it looks live and is not.
 */
function classify(ping: LiveLocationPing | null): Freshness {
  if (ping == null) return 'none';
  // Legacy rows carry no timestamp — the age is unknowable, not merely old.
  if (!ping.captured_at) return 'unknown-age';
  /*
   * parseIstDateTime, not `new Date(...)`. captured_at is a zone-less MySQL
   * DATETIME meaning IST, so `new Date()` reads it as browser-local. From any
   * zone BEHIND IST the instant lands in the FUTURE, `Date.now() - t` goes
   * NEGATIVE, and negative <= LIVE_WINDOW_MS is TRUE — a ping hours old
   * classified as 'live', painting the green pin, the pulse and the
   * "Live · updated…" banner.
   *
   * That is precisely the failure this function's docblock above says it
   * exists to prevent, arriving through the parse rather than the policy.
   */
  const t = parseIstDateTime(ping.captured_at).getTime();
  if (Number.isNaN(t)) return 'unknown-age';
  return Date.now() - t <= LIVE_WINDOW_MS ? 'live' : 'stale';
}

/*
 * Technician-on-a-two-wheeler marker, as an inline SVG data URI.
 *
 * A data URI rather than a file under /public: no second network request, no
 * new asset to deploy, and — the part that actually matters here — the fill is
 * chosen at RUNTIME, so `live` and `stale` are the same mark in two colours
 * instead of two hand-drawn files.
 *
 * The colours are INTERPOLATED from src/brand/palette.ts and never written as
 * literals. `npm run check:brand` rejects a hex code in any file but the
 * palette, and it is right to: a pin hard-coded to the brand red is a colour
 * the rebrand seam cannot reach, and this one would silently keep the old
 * identity through a rebrand.
 *
 * Drawn in a 44x52 viewBox and rendered at 40x47. No `scaledSize` / `anchor`
 * is passed at the call site because we don't need one — Google anchors an
 * icon at the bottom-centre of its image by default, which is exactly the
 * teardrop's tip, so the tip sits on the reported coordinate.
 */
function bikePinDataUri(body: string, ink: string): string {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="47" viewBox="0 0 44 52">',
    `<path d="M22 51c0 0 18-18.6 18-31a18 18 0 1 0-36 0c0 12.4 18 31 18 31z" fill="${body}" stroke="${ink}" stroke-width="2.5" stroke-linejoin="round"/>`,
    `<g fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">`,
    '<circle cx="13" cy="26.5" r="3.6"/>',
    '<circle cx="31" cy="26.5" r="3.6"/>',
    '<path d="M13 26.5l6.5-6.5H26l5 6.5"/>',
    '<path d="M26 20l3-4.5h3.5"/>',
    '<path d="M22.5 19.5l1.5-6"/>',
    '<path d="M24 15l5 1"/>',
    '</g>',
    `<circle cx="24.5" cy="10.5" r="3.4" fill="${ink}"/>`,
    '</svg>',
  ].join('');
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

/** One breadcrumb from GET /admin/jobs/:id/location. */
type TrackPoint = JobLocationResponse['track'][number];

/** A drawable point. Google wants numbers; MySQL DECIMALs arrive as strings. */
type LatLng = { lat: number; lng: number };

/*
 * Frame the whole trail plus the current fix.
 *
 * Called on every path change, not just at build. A trail that grows past the
 * edge of a once-fitted viewport is worse than no trail — the operator sees a
 * line running off the map with no way to follow it, because this map cannot
 * be panned or zoomed. Re-fitting keeps the entire journey visible for the
 * whole call, which is the only reason to draw it.
 */
function fitToTrail(maps: GMaps, map: { fitBounds: (b: unknown, pad?: number) => void }, path: LatLng[], fix: LatLng): void {
  const bounds = new maps.LatLngBounds();
  for (const point of path) bounds.extend(point);
  bounds.extend(fix);
  map.fitBounds(bounds, 24);
}

/*
 * No accuracy reported → draw a nominal ring so the live state still reads as
 * live on the map. It is a presence indicator at that point, not a claimed
 * precision, which is why it is deliberately small.
 */
const NOMINAL_ACCURACY_M = 40;

export type LiveLocationSource = 'job' | 'easyfixer';

export function LiveLocationPopover({
  open,
  onClose,
  source,
  id,
  title,
}: {
  open: boolean;
  onClose: () => void;
  /* Which endpoint to hit: job-scoped vs technician-scoped. */
  source: LiveLocationSource;
  /* job_id (source="job") or efr_id (source="easyfixer"). Null defers fetch. */
  id: number | null;
  /* Sub-line under the dialog title — e.g. the technician or job label. */
  title?: string;
}) {
  const [latest, setLatest] = useState<LiveLocationPing | null>(null);
  /*
   * The breadcrumb trail, job source only. /admin/jobs/:id/location has always
   * returned it and the popover has always thrown it away; /admin/easyfixers/
   * :id/location has no equivalent, because the legacy `location` table keeps
   * one row per technician and there is no history to draw.
   */
  const [track, setTrack] = useState<TrackPoint[]>([]);
  // `loading` is true only on the FIRST fetch for a given open/id; subsequent
  // poll cycles refresh silently so the coordinates don't flicker every 15s.
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the first fetch (success or empty) lands, so we can distinguish
  // "still loading" from "loaded, but technician has no ping".
  const [loaded, setLoaded] = useState(false);

  // Guard against a slow in-flight request resolving after the dialog closed
  // (or the id changed) and clobbering fresh state.
  const reqSeqRef = useRef(0);

  const fetchOnce = useCallback(
    async (mode: 'initial' | 'poll' | 'manual') => {
      if (id == null) return;
      const seq = ++reqSeqRef.current;
      if (mode === 'initial') setLoading(true);
      if (mode === 'manual') setRefreshing(true);
      try {
        // Split rather than a union + `in` narrowing: only the job endpoint
        // has a track, and the easyfixer branch must clear it explicitly so a
        // job's trail cannot survive into a technician-scoped open.
        if (source === 'job') {
          const data = await api.getJobLocation(id);
          if (seq !== reqSeqRef.current) return; // superseded — discard
          setLatest(data.latest);
          setTrack(data.track ?? []);
        } else {
          const data = await api.getEasyfixerLocation(id);
          if (seq !== reqSeqRef.current) return; // superseded — discard
          setLatest(data.latest);
          setTrack([]);
        }
        setError(null);
        setLoaded(true);
      } catch (e) {
        if (seq !== reqSeqRef.current) return;
        setError(e instanceof ApiError ? e.message : 'Failed to load location');
        setLoaded(true);
      } finally {
        if (seq === reqSeqRef.current) {
          if (mode === 'initial') setLoading(false);
          if (mode === 'manual') setRefreshing(false);
        }
      }
    },
    [id, source],
  );

  // Fetch on open + poll every POLL_MS WHILE open. Cleanup clears the interval
  // on close/unmount/id-change — no stray timers, no requests after close.
  useEffect(() => {
    if (!open || id == null) return;
    // Reset per-open so reopening a different row starts clean.
    setLatest(null);
    setTrack([]);
    setLoaded(false);
    setError(null);
    fetchOnce('initial');
    return undefined;
  }, [open, id, fetchOnce]);

  /*
   * Poll ONLY while the position is live.
   *
   * Polling a row nobody is updating burns a query every 15s to redraw an
   * identical dot, and — worse — it teaches the operator that the dot means
   * "now". A stale or unknown-age position gets a Refresh button instead, so
   * checking again is a deliberate act.
   */
  const freshness = classify(latest);
  useEffect(() => {
    if (!open || id == null || freshness !== 'live') return undefined;
    const t = setInterval(() => fetchOnce('poll'), POLL_MS);
    return () => clearInterval(t);
  }, [open, id, freshness, fetchOnce]);

  /* ── The map ─────────────────────────────────────────────────────────────
   *
   * A PICTURE of where he is, not a tool. The position is a database record
   * that Ops cannot correct from here, so the map offers no affordance that
   * suggests otherwise — see the options block in the build effect below.
   *
   * One `new maps.Map()` per open. AddressPickerWithMap goes further and
   * re-parents a single module-level Map across mounts because Google bills
   * per construction; that machinery is worth it for a picker that remounts on
   * every Section collapse, and not worth it for a modal an operator opens a
   * handful of times a shift. If this popover ever ends up on a hot path, copy
   * the `sharedMapCore` pattern from that file rather than inventing a second.
   */
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  // Minimal call-site surface (.panTo / .setPosition / .setIcon / .setCenter),
  // same reason the loader's GMaps stub is hand-written: no @types/google.maps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const circleRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trailRef = useRef<any>(null);
  // The resolved google.maps namespace, kept so the sync effect can construct
  // a Polyline that did not exist at build time (a trail can reach two points
  // on a later poll) without re-entering the loader.
  const mapsRef = useRef<GMaps | null>(null);
  // Guards the async build against a double-fire (Strict Mode, or a re-render
  // landing before loadGoogleMaps() resolves) minting two Maps into one div.
  const buildStartedRef = useRef(false);
  const [mapsError, setMapsError] = useState<string | null>(null);

  // Coordinates arrive as MySQL DECIMALs and can surface as strings — coerce
  // once here so every consumer below is dealing in real numbers.
  const lat = latest != null ? Number(latest.latitude) : Number.NaN;
  const lng = latest != null ? Number(latest.longitude) : Number.NaN;
  const hasFix = Number.isFinite(lat) && Number.isFinite(lng);
  const accuracyM =
    latest?.accuracy != null && Number(latest.accuracy) > 0
      ? Number(latest.accuracy)
      : NOMINAL_ACCURACY_M;

  /*
   * Differentiate live from not-live ON THE MAP, not only in the caption —
   * ops glance at the picture. Live: brand-red rider, green accuracy ring
   * (plus the CSS pulse rendered over the canvas). Otherwise: an ink rider
   * and a faint grey ring, so a last-known position reads as inert.
   */
  const pinUrl = useMemo(
    () => bikePinDataUri(freshness === 'live' ? palette.red500 : palette.ink500, palette.white),
    [freshness],
  );
  const ringStyle = useMemo(
    () =>
      freshness === 'live'
        ? { strokeColor: palette.success, strokeOpacity: 0.9, strokeWeight: 2, fillColor: palette.success, fillOpacity: 0.18 }
        : { strokeColor: palette.ink500, strokeOpacity: 0.5, strokeWeight: 1, fillColor: palette.ink500, fillOpacity: 0.1 },
    [freshness],
  );

  /*
   * Oldest → newest. The endpoint returns newest-first (so a `LIMIT` keeps the
   * RECENT pings, not the first ones ever recorded), but a line has to be
   * drawn in travel order or it reads backwards.
   */
  const path = useMemo<LatLng[]>(
    () =>
      track
        .map((point) => ({ lat: Number(point.latitude), lng: Number(point.longitude) }))
        .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
        .reverse(),
    [track],
  );
  const hasTrail = path.length >= 2;

  /*
   * Blue, not red: the trail is information, the technician is the action, and
   * a red line running to a red pin merges into one shape at a glance.
   */
  const trailStyle = useMemo(
    () => ({ strokeColor: palette.blue500, strokeOpacity: 0.85, strokeWeight: 3 }),
    [],
  );

  /*
   * Restyle the tiles in dark mode. `resolved` (not `theme`) because a user on
   * 'system' must follow the OS, and it updates live — hence the setOptions in
   * the sync effect rather than a build-time-only read.
   */
  const { resolved } = useTheme();
  const mapStyles = useMemo(() => (resolved === 'dark' ? darkMapStyles : null), [resolved]);

  // Build once per open, as soon as there is a fix to centre on.
  useEffect(() => {
    if (!open || !hasFix || buildStartedRef.current || !mapNodeRef.current) return undefined;
    buildStartedRef.current = true;
    const node = mapNodeRef.current;
    let cancelled = false;
    loadGoogleMaps()
      .then((maps) => {
        if (cancelled || mapRef.current) return;
        const center = { lat, lng };
        /*
         * EVERY interaction is off ON PURPOSE. Do not re-enable one.
         *
         * What this map shows is a row in the database — the last GPS ping the
         * technician's device sent. Ops cannot change where he is, and a map
         * you can pan, zoom and drop a pin on says the opposite: it reads as an
         * editor, like the one in Book New Call, and invites someone to
         * "correct" a position that is a record of fact. The read-only surface
         * is the honesty of the feature, not over-configuration.
         *
         * The two things that still move are ours, not the operator's: we
         * reposition the marker and pan to follow a fresh `live` fix. Anyone
         * who genuinely needs an interactive map has "Open in Google Maps"
         * below — a plain URL, no key, no editing pretence.
         */
        mapsRef.current = maps;
        mapRef.current = new maps.Map(node, {
          center,
          zoom: 15,
          // null, not undefined: passing null explicitly clears any styles on
          // a later setOptions, which is how a dark→light switch gets its
          // default tiles back.
          styles: mapStyles,
          disableDefaultUI: true,
          gestureHandling: 'none',
          draggable: false,
          scrollwheel: false,
          disableDoubleClickZoom: true,
          keyboardShortcuts: false,
          clickableIcons: false,
        });
        markerRef.current = new maps.Marker({
          position: center,
          map: mapRef.current,
          // Both default to false. Stated anyway so the next reader sees the
          // read-only intent here too and doesn't "helpfully" turn one on.
          draggable: false,
          clickable: false,
          icon: { url: pinUrl },
        });
        circleRef.current = new maps.Circle({
          map: mapRef.current,
          center,
          radius: accuracyM,
          clickable: false,
          ...ringStyle,
        });
        if (path.length >= 2) {
          trailRef.current = new maps.Polyline({
            map: mapRef.current,
            path,
            clickable: false,
            ...trailStyle,
          });
          fitToTrail(maps, mapRef.current, path, center);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setMapsError(e instanceof Error ? e.message : 'Map unavailable');
      });
    return () => { cancelled = true; };
    // pinUrl / ringStyle / accuracyM / path / mapStyles are read for the
    // INITIAL paint only; the sync effect below owns every subsequent change,
    // so they are not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasFix]);

  /*
   * MOVE the pin, never recreate it.
   *
   * Recreating the marker on each 15s poll makes it blink out and back, and
   * throws away the map's animation state mid-pan. setPosition + panTo is both
   * cheaper and the only thing that looks like a technician riding.
   */
  useEffect(() => {
    if (!open || !hasFix || !mapRef.current || !markerRef.current) return;
    const pos = { lat, lng };
    markerRef.current.setPosition(pos);
    markerRef.current.setIcon({ url: pinUrl });
    if (circleRef.current) {
      circleRef.current.setCenter(pos);
      circleRef.current.setRadius(accuracyM);
      circleRef.current.setOptions(ringStyle);
    }
    // Theme can flip while the modal is open (settings toggle, or the OS
    // switching under a 'system' preference).
    mapRef.current.setOptions({ styles: mapStyles });

    const maps = mapsRef.current;
    if (hasTrail && maps) {
      // The trail may cross the two-point threshold on a later poll, so the
      // Polyline is created here as readily as it is in the build effect.
      if (!trailRef.current) {
        trailRef.current = new maps.Polyline({
          map: mapRef.current,
          path,
          clickable: false,
          ...trailStyle,
        });
      } else {
        trailRef.current.setPath(path);
      }
      /*
       * Re-frame instead of panning. panTo would centre the technician and
       * push the older half of the trail off a map nobody can drag back.
       */
      fitToTrail(maps, mapRef.current, path, pos);
    } else {
      mapRef.current.panTo(pos);
    }
  }, [open, hasFix, lat, lng, accuracyM, pinUrl, ringStyle, mapStyles, hasTrail, path, trailStyle]);

  /*
   * Teardown, keyed on the two conditions that render the container div.
   *
   * `open` false is the obvious one (Radix unmounts DialogContent). `hasFix`
   * false is the one that bites: the fetch effect blanks `latest` whenever the
   * popover is pointed at a different row, and the map lives inside the
   * `latest != null` branch — so the div goes away mid-open too. Either way the
   * Map is left attached to nothing, so drop the refs and let the next fix
   * build against the fresh node rather than writing into a detached tree.
   * The error clears with them, giving a transient script failure one more try.
   *
   * Nothing to unsubscribe: this map registers no listeners at all, which is
   * the other quiet benefit of making it read-only.
   */
  useEffect(() => {
    if (!open || !hasFix) return undefined;
    return () => {
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
      trailRef.current = null;
      mapsRef.current = null;
      buildStartedRef.current = false;
      setMapsError(null);
    };
  }, [open, hasFix]);

  // Global map-clickability toggle. When off, the "Open in Google Maps" link
  // is rendered as a disabled, non-navigable span.
  const { mapClickable } = useUiFlags();

  const mapsHref =
    latest != null
      ? `https://www.google.com/maps?q=${latest.latitude},${latest.longitude}`
      : null;

  // Read-only popover (no editable form) — pass isDirty:false so the shared
  // discard-changes guard closes immediately. Matches CsvCellModal /
  // EasyfixerTransactionsModal et al.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-4 w-4" /> Live Technician Location
          </DialogTitle>
          {title && <DialogDescription>{title}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-3">
          {loading && !loaded && (
            <div className="space-y-2" aria-busy>
              <div className="h-3 w-40 rounded bg-muted animate-pulse" />
              <div className="h-3 w-28 rounded bg-muted animate-pulse" />
              <div className="h-3 w-32 rounded bg-muted animate-pulse" />
            </div>
          )}

          {!loading && loaded && error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Empty state — no ping yet (GPS off / no active job). */}
          {!loading && loaded && !error && latest == null && (
            <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-tint px-3 py-3 text-sm text-warning-strong">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>Location unavailable — technician&apos;s GPS may be off.</span>
            </div>
          )}

          {/* Loaded with a ping — coordinates + accuracy + last-updated + map. */}
          {!loading && loaded && !error && latest != null && (
            <>
              {/*
                * Say which KIND of position this is, before the numbers.
                *
                * The coordinates look identical whether they arrived 10 seconds
                * or 10 hours ago, so without this an operator reads a stale
                * position as the technician's current one and guides him from it.
                */}
              {freshness === 'live' && (
                <div className="flex items-center gap-2 rounded-md border border-success bg-success-tint px-3 py-2 text-sm text-success-strong">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                  </span>
                  <span><strong className="font-semibold">Live</strong> · updated {relativeTime(latest.captured_at)}</span>
                </div>
              )}
              {freshness === 'stale' && (
                <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-tint px-3 py-2 text-sm text-warning-strong">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>
                    <strong className="font-semibold">Last known position</strong> · {relativeTime(latest.captured_at)}.
                    {' '}This is not live — use Refresh to check again.
                  </span>
                </div>
              )}
              {freshness === 'unknown-age' && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>
                    <strong className="font-semibold text-foreground">Last known position — age unknown.</strong>
                    {' '}Recorded by the older app, which did not store a timestamp.
                  </span>
                </div>
              )}

              {/*
                * The map itself. Honest no-key fallback: if the loader can't
                * resolve an API key there is nothing to draw, so say so in one
                * line and let the coordinates and the Google Maps link below
                * carry the feature, rather than parking a broken grey box here.
                */}
              {mapsError ? (
                <p className="text-xs text-muted-foreground">
                  {mapsError.includes('API key not configured')
                    ? 'Map preview unavailable — no Google Maps key is configured for this environment.'
                    : `Map preview unavailable — ${mapsError}.`}
                  {' '}The coordinates below and the Google Maps link still work.
                </p>
              ) : (
                <div className="relative h-[200px] w-full overflow-hidden rounded-md border bg-muted">
                  <div ref={mapNodeRef} className="h-full w-full" />
                  {/*
                    * Live pulse. Rendered over the canvas rather than animated
                    * through the Maps API because the map cannot be panned or
                    * zoomed — so the reported position is at the exact centre
                    * of this box, and a CSS ring there needs no timer, no
                    * overlay class and no cleanup of its own.
                    *
                    * That centring assumption is the whole reason it is also
                    * gated on `!hasTrail`: once a breadcrumb trail is drawn the
                    * view is fitted to the whole journey, the technician sits
                    * at one END of it rather than the middle, and a pulse in
                    * the centre would be marking empty road. The red pin and
                    * the green accuracy ring — both anchored to the real
                    * position — carry liveness on their own in that case.
                    */}
                  {freshness === 'live' && !hasTrail && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute left-1/2 top-1/2 -ml-4 -mt-4 inline-flex h-8 w-8 animate-ping rounded-full bg-success opacity-40"
                    />
                  )}
                </div>
              )}

              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Latitude</dt>
                <dd className="font-mono tabular-nums">{latest.latitude}</dd>
                <dt className="text-muted-foreground">Longitude</dt>
                <dd className="font-mono tabular-nums">{latest.longitude}</dd>
                <dt className="text-muted-foreground">Accuracy</dt>
                <dd className="tabular-nums">
                  {latest.accuracy != null ? `${Math.round(latest.accuracy)} m` : '—'}
                </dd>
                <dt className="text-muted-foreground">Last updated</dt>
                <dd>
                  {latest.captured_at ? (
                    <span title={formatDate(latest.captured_at)}>
                      {relativeTime(latest.captured_at)}
                    </span>
                  ) : (
                    /* A bare em-dash here reads as a rendering bug. Name the reason. */
                    <span className="text-muted-foreground">Not recorded</span>
                  )}
                </dd>
              </dl>

              {/*
                * HIDDEN, not disabled, when ui.map.clickable is off.
                *
                * A greyed control that still reads "Open in Google Maps" tells
                * the operator there is something here and then refuses — it
                * looks like a broken link rather than a switched-off feature,
                * and the only explanation was a title attribute nobody hovers.
                * Withdrawing it entirely is the honest rendering of "this is
                * turned off": the coordinates are still on screen, so nothing
                * an operator needs is lost.
                */}
              {mapsHref && mapClickable && (
                <a
                  href={mapsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-brand-600 hover:underline"
                >
                  <ExternalLink className="h-4 w-4" /> Open in Google Maps
                </a>
              )}
            </>
          )}

          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-muted-foreground">
              {freshness === 'live'
                ? `Auto-refreshing every ${POLL_MS / 1000}s while open.`
                : 'Not auto-refreshing — this position is not live.'}
            </span>
            <button
              type="button"
              onClick={() => fetchOnce('manual')}
              disabled={refreshing || id == null}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Refresh now"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/*
 * relativeTime now comes from '@/lib/utils'.
 *
 * This file used to carry a PRIVATE COPY of it — identical body, identical
 * clamps — which was left behind when the shared one was converted to
 * parseIstDateTime. So the shared helper was fixed and this panel kept the
 * bug: west of IST the diff went negative and the `diffSec < 0` clamp turned
 * a three-hour-old technician position into "just now".
 *
 * Deleted rather than patched. Two copies of a formatter is how the first one
 * got fixed alone, and the panel's whole purpose is to be honest about age.
 */
