/*
 * Record every mic stream acquired through `md.getUserMedia` so the end of a
 * web call can stop them all (WebCallContext).
 *
 * Why: plivo-browser-sdk 2.2.21 with the noise filter on (our default) pipes
 * the raw mic through its RNNoise worklet and swaps window.localStream for the
 * PROCESSED stream. Its hangup cleanup stops only that processed stream, and
 * its effect teardown just disconnects nodes — the raw mic track is never
 * stopped, so the browser keeps the mic open (address-bar mic icon) until the
 * tab reloads. Wrapping getUserMedia is SDK-agnostic, so an SDK upgrade cannot
 * silently bring the leak back.
 */
type MediaDevicesLike = { getUserMedia: (c?: MediaStreamConstraints) => Promise<MediaStream> };

export function trackMicStreams(md: MediaDevicesLike) {
  const streams: MediaStream[] = [];
  const orig = md.getUserMedia;
  md.getUserMedia = async (c?: MediaStreamConstraints) => {
    const s = await orig.call(md, c);
    streams.push(s);
    return s;
  };
  return {
    /** Stop every track of every stream acquired since the last release. */
    release() {
      for (const s of streams.splice(0)) {
        try { s.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
      }
    },
    /** Put the original getUserMedia back. */
    restore() { md.getUserMedia = orig; },
  };
}
