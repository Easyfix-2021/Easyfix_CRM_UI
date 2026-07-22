'use client';

import * as React from 'react';

/*
 * CallRecordingAudio — an <audio> player that DOWNMIXES stereo call recordings
 * to mono for playback.
 *
 * Why this exists (2026-07-15). Plivo records our bridged calls with
 * `recordChannelType="stereo"`, which isolates each party on their own channel:
 * channel 0 = agent, channel 1 = customer (see EasyFix_Backend
 * services/plivo.service.js buildAnswerXml + transcribe-call-analytics.service.js
 * ChannelDefinitions — AWS Transcribe Call Analytics NEEDS those two channels to
 * attribute agent vs customer, so the recording itself must stay stereo).
 *
 * The cost of that design is playback: a plain <audio> faithfully reproduces the
 * panning, so the customer only ever comes out of the RIGHT channel. Any mono
 * output path — a Bluetooth headset in hands-free/HFP mode, a single earbud, a
 * mono speaker — drops the customer entirely, which ops reported as "only the
 * caller's voice is recorded". The audio was always there; nobody could hear it.
 *
 * Fix: route the element through a Web Audio graph whose gain node is forced to
 * ONE channel. Per the Web Audio spec, feeding a 2-channel input into a node
 * with channelCount=1 + channelCountMode='explicit' + channelInterpretation=
 * 'speakers' performs the standard downmix 0.5*(L+R); the destination then
 * upmixes that back across both speakers. Result: both parties audible on every
 * output device, recording untouched, Call Analytics untouched.
 *
 * Unity gain is deliberate. The agent channel already peaks at 0.0 dBFS on real
 * recordings, so any makeup gain on (L+R) would clip.
 *
 * Constraints this respects:
 *   - createMediaElementSource() may be called at most ONCE per element, and it
 *     permanently reroutes that element's output → build the graph in an effect
 *     keyed to the node, guard with a ref, and never rebuild it.
 *   - It also requires CORS-clean audio or it silently emits SILENCE. Our URL is
 *     a PRESIGNED S3 URL (GET /admin/calls/:id/recording → s3.getPresignedUrl),
 *     i.e. cross-origin, so this is the real hazard: wiring the graph to tainted
 *     audio would turn "customer only in the right ear" into "no audio at all".
 *     Hence `crossOrigin="anonymous"` — it converts that silent failure into a
 *     LOUD one (an `error` event when the bucket sends no CORS headers), which
 *     we catch to fall back to a plain stereo <audio>. So the two outcomes are
 *     "downmixed mono" or "exactly today's behaviour" — never silence.
 *   - AudioContext starts suspended until a user gesture; resume() on play.
 *
 * ⚠ To get the mono path (not the fallback) the recordings bucket must allow
 * cross-origin GETs from the CRM origin. Without that CORS rule this component
 * is a no-op that quietly renders the stereo player.
 *
 * Degrades safely at every step: no AudioContext, a throwing graph, or a CORS
 * refusal all end at a normal stereo <audio> — never worse than today.
 */
export function CallRecordingAudio({
  src,
  className,
  autoPlay,
}: {
  src: string;
  className?: string;
  autoPlay?: boolean;
}) {
  const elRef = React.useRef<HTMLAudioElement | null>(null);
  const ctxRef = React.useRef<AudioContext | null>(null);
  // createMediaElementSource is one-shot per element — this guards StrictMode's
  // double-invoke, which would otherwise throw InvalidStateError and leave the
  // player muted.
  const wiredRef = React.useRef(false);
  // Flipped when the CORS-guarded load fails → re-render a plain stereo player.
  // Keyed re-mount (see `key` below) gives us a FRESH element, which matters:
  // createMediaElementSource permanently reroutes the node it was given.
  const [corsBlocked, setCorsBlocked] = React.useState(false);

  React.useEffect(() => {
    if (corsBlocked) return; // Fallback path: leave the element alone.
    const el = elRef.current;
    if (!el || wiredRef.current) return;

    const Ctor =
      typeof window !== 'undefined'
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctor) return; // No Web Audio → plain stereo playback.

    try {
      const ctx = new Ctor();
      const source = ctx.createMediaElementSource(el);
      const mono = ctx.createGain();
      // THE downmix: 2-in → 1-channel node → 0.5*(L+R). See docblock.
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      source.connect(mono);
      mono.connect(ctx.destination);
      ctxRef.current = ctx;
      wiredRef.current = true;
    } catch {
      // Already-wired element, or audio the context refuses. Leave the element
      // untouched — stereo playback beats a silent player.
    }

    return () => {
      // Closing releases the hardware audio thread. Fire-and-forget: a close()
      // on an already-closed context rejects, and we have nothing to do about it.
      void ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    };
  }, [corsBlocked]);

  // Browsers start an AudioContext suspended until a gesture; without this the
  // graph is live but silent on the first click.
  function handlePlay() {
    const ctx = ctxRef.current;
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
  }

  if (corsBlocked) {
    // The bucket refused the cross-origin GET. Plain stereo player = today's
    // behaviour (customer audible on the RIGHT channel only).
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio src={src} controls autoPlay={autoPlay} className={className} />;
  }

  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <audio
      // Remount cleanly if we ever fall back — the old node is permanently
      // bound to its MediaElementSource and can't be reused.
      key="mono"
      ref={elRef}
      src={src}
      // Required for the Web Audio graph to receive real samples instead of
      // silence. Also turns a missing-CORS bucket into an `error` we can catch.
      crossOrigin="anonymous"
      controls
      autoPlay={autoPlay}
      onPlay={handlePlay}
      onError={() => setCorsBlocked(true)}
      className={className}
      title="Both parties are mixed to mono for playback — the recording itself stays 2-channel (agent / customer)."
    />
  );
}
