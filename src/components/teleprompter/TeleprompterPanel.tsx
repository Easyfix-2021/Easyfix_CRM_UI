'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

/*
 * TeleprompterPanel — the guided (AI-assisted) verification call.
 *
 * Flow: opens → POST /admin/teleprompter/start (builds the on-screen question list
 * from the deep-skill catalog) → places the existing browser web-call tagged with
 * the session (so Plivo forks the audio to STT). While the technician answers, the
 * backend suggests the NEXT question; a fixed list is shown with the CURRENT
 * question (being read, locked) highlighted and the NEXT one accented. The Ops mic
 * VAD promotes next→current when the caller starts reading it (gated on the AI
 * having produced a fresh suggestion, so it never jumps ahead while the current
 * question is still being read); a "Next" override is always available.
 *
 * On completion the captured skills + serviceable areas are shown for review and
 * applied to the technician's profile via the existing mapping endpoints. Polling
 * (not SSE) is used for the live state — cross-replica safe + lint-clean.
 */

import * as React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetchOnce } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useWebCall } from '@/components/calls/WebCallContext';
import { Loader2, Phone, PhoneOff, ChevronRight, CheckCircle2, Mic, MicOff, Sparkles } from 'lucide-react';

type Question = { id: string; text: string; type?: string; required?: boolean; meta?: any };
type StartResp = { sessionId: string; flow: string; questionList: Question[] };
type DeepSkillItem = { category_id: number; service_type_id: number; deep_skill_id: number; option_id: number; label?: string };
type Pincode = { pincode_id: number; pincode: string; city_name?: string };
type Coverage = { coverage_pct: number | null; covered: number; required_total: number; missed?: { id: string; text?: string }[] };
type CapturedResult = {
  deep_skill_items?: DeepSkillItem[];
  serviceable_pincode_ids?: number[];
  serviceable_pincodes?: Pincode[];
  unmapped?: { skills?: string[]; areas?: string[] };
} | null;
type Session = {
  sessionId: string; status: string; currentQuestionId: string | null; nextQuestionId: string | null;
  questionList: Question[]; askedSequence: { id: string; ts?: number }[]; transcript: string;
  result: CapturedResult; coverage: Coverage | null; error: string | null;
};

const POLL_MS = 1200;
const PROMOTE_COOLDOWN_MS = 1500;
const AI_FLOW = 'guided_verification';

export function TeleprompterPanel({ open, efrId, onClose, onApplied }: {
  open: boolean; efrId: number; onClose: () => void; onApplied: () => void | Promise<void>;
}) {
  const webCall = useWebCall();
  // QA custom-number mode: the BE requires an explicit "Call To" number and won't
  // dial the real technician. Same config the click-to-call flow reads.
  const cfg = useFetchOnce<{ promptForNumbers?: boolean; qaDefaults?: { to?: string | null } | null }>('/admin/calls/config');
  const needsNumber = cfg.data?.promptForNumbers === true;
  const [callTo, setCallTo] = React.useState('');
  const callToRef = React.useRef('');
  React.useEffect(() => { callToRef.current = callTo; }, [callTo]);
  const [startError, setStartError] = React.useState<string | null>(null);
  const [retryPending, setRetryPending] = React.useState(false);
  // useFetchOnce has no request timeout — a HUNG /config (socket open, no response)
  // would leave cfg.loading true forever and spin the panel. Settle after 5s (same
  // fallback pattern as useUiFlags) so a slow/hung config fetch can't brick it.
  const [cfgTimedOut, setCfgTimedOut] = React.useState(false);
  React.useEffect(() => {
    if (!cfg.loading) return;
    const t = setTimeout(() => setCfgTimedOut(true), 5000);
    return () => clearTimeout(t);
  }, [cfg.loading]);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [questions, setQuestions] = React.useState<Question[]>([]);
  const [session, setSession] = React.useState<Session | null>(null);
  const [currentId, setCurrentId] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [applying, setApplying] = React.useState(false);
  const [micOn, setMicOn] = React.useState(false);
  // Whether the media stream has EVER attached — the relay writes status='streaming'
  // on connect. Latches true; drives the no-stream warning + the fail-fast on hangup
  // (a call that never streamed has nothing to "wrap up", so we don't wait out the
  // backend connect-reaper for minutes).
  const [streamConnected, setStreamConnected] = React.useState(false);
  const [noStreamWarn, setNoStreamWarn] = React.useState(false);

  const askedRef = React.useRef<{ id: string; ts: number }[]>([]);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const genRef = React.useRef(0);
  const lastPromoteAtRef = React.useRef(0);
  const lastPromotedNextRef = React.useRef<string | null>(null);
  const startedRef = React.useRef(false);
  const sessionRef = React.useRef<Session | null>(null);
  const currentIdRef = React.useRef<string | null>(null);
  React.useEffect(() => { sessionRef.current = session; }, [session]);
  React.useEffect(() => { currentIdRef.current = currentId; }, [currentId]);

  // Captured-result review selection (Apply).
  const [pickedSkills, setPickedSkills] = React.useState<Set<number>>(new Set());
  const [pickedPins, setPickedPins] = React.useState<Set<number>>(new Set());

  const status = session?.status || (sessionId ? 'calling' : 'idle');
  const isDone = status === 'done';
  const isFailed = status === 'failed';

  // ── Ordered list + current/next resolution ──
  function seqNextAfter(cid: string | null): string | null {
    if (!questions.length) return null;
    if (!cid) return questions[0].id;
    const i = questions.findIndex((q) => q.id === cid);
    return i >= 0 && i + 1 < questions.length ? questions[i + 1].id : null;
  }
  const serverNext = session?.nextQuestionId && session.nextQuestionId !== currentId ? session.nextQuestionId : null;
  const nextId = serverNext || seqNextAfter(currentId);

  const doPromote = React.useCallback((nid: string | null) => {
    if (!nid || nid === currentIdRef.current) return;
    const now = Date.now();
    if (now - lastPromoteAtRef.current < PROMOTE_COOLDOWN_MS) return;
    lastPromoteAtRef.current = now;
    lastPromotedNextRef.current = nid;
    setCurrentId(nid);
    askedRef.current = [...askedRef.current, { id: nid, ts: now }];
    const sid = sessionRef.current?.sessionId || sessionId;
    if (sid) api.post(`/admin/teleprompter/${sid}/promote`, { questionId: nid, askedSequence: askedRef.current }).catch(() => {});
  }, [sessionId]);

  // VAD-driven promotion: only when the AI has a FRESH next suggestion (i.e. the
  // technician has answered), so we never advance while the current question is
  // still being read. Manual mode (no STT → no serverNext) relies on the override.
  const onCallerSpeechOnset = React.useCallback(() => {
    const s = sessionRef.current;
    const nid = s?.nextQuestionId;
    if (nid && nid !== currentIdRef.current && nid !== lastPromotedNextRef.current) doPromote(nid);
  }, [doPromote]);

  // ── Start: create session + place the web call ──
  const start = React.useCallback(async () => {
    setStarting(true); setStartError(null);
    const gen = (genRef.current += 1);
    try {
      const resp = await api.post<StartResp>('/admin/teleprompter/start', { flow: AI_FLOW, efrId });
      if (gen !== genRef.current) return;
      setSessionId(resp.sessionId);
      setQuestions(resp.questionList || []);
      const first = resp.questionList?.[0]?.id ?? null;
      setCurrentId(first);
      askedRef.current = first ? [{ id: first, ts: Date.now() }] : [];
      try {
        await webCall.placeWebCall({ efrId }, { teleprompterSessionId: resp.sessionId, flow: AI_FLOW, callTo: callToRef.current || undefined });
      } catch { /* web-call errors surface via webCall.error; the session still polls */ }
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => { void pollOnce(resp.sessionId, gen); }, POLL_MS);
      void pollOnce(resp.sessionId, gen);
    } catch (e) {
      if (gen === genRef.current) {
        const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Could not start the guided call.';
        setStartError(msg);
        showToast({ variant: 'error', message: msg });
      }
    } finally {
      if (gen === genRef.current) setStarting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [efrId]);

  async function pollOnce(sid: string, gen: number) {
    if (gen !== genRef.current) return;
    try {
      const s = await api.get<Session>(`/admin/teleprompter/${sid}`);
      if (gen !== genRef.current) return;
      setSession(s);
      // Latch once the media stream has attached (or moved past it). 'calling' means
      // it never connected — that's what the no-stream warning + fail-fast key on.
      if (s.status === 'streaming' || s.status === 'processing' || s.status === 'done') setStreamConnected(true);
      if (s.status === 'done' || s.status === 'failed') { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }
    } catch { /* transient; keep polling */ }
  }

  // Start once when the panel opens; tear down when it closes.
  React.useEffect(() => {
    // Auto-start once config is known — but ONLY when QA custom-number mode is off.
    // In QA mode we wait for the operator to enter the "Call To" number (the BE
    // rejects the call without it), so the panel shows a number form instead.
    if (open && !startedRef.current && cfg.data && !cfg.data.promptForNumbers) {
      startedRef.current = true; void start();
    }
    // Prefill the QA number from env defaults (don't clobber an operator edit).
    if (open && cfg.data?.qaDefaults?.to && !callToRef.current) setCallTo(cfg.data.qaDefaults.to);
    if (!open) {
      startedRef.current = false;
      genRef.current += 1;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      setSessionId(null); setSession(null); setQuestions([]); setCurrentId(null); setCallTo('');
      setPickedSkills(new Set()); setPickedPins(new Set());
      setStartError(null); setRetryPending(false); setCfgTimedOut(false);
      setStreamConnected(false); setNoStreamWarn(false);
      lastPromotedNextRef.current = null; lastPromoteAtRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cfg.data]);

  // Prime the Apply selection once the result lands (pre-check everything).
  React.useEffect(() => {
    if (!isDone || !session?.result) return;
    setPickedSkills(new Set((session.result.deep_skill_items || []).map((_, i) => i)));
    setPickedPins(new Set(session.result.serviceable_pincode_ids || []));
  }, [isDone, session?.result]);

  // No-stream watchdog: once the call is answered, STT should attach within a few
  // seconds. If the session hasn't reached 'streaming' within 15s, warn Ops during
  // the call so they don't burn a full call with nothing captured (usually a
  // wss/nginx/PLIVO_CALLBACK_BASE_URL connectivity issue, not STT itself).
  React.useEffect(() => {
    if (webCall.status !== 'in_progress' || streamConnected) { setNoStreamWarn(false); return; }
    const t = setTimeout(() => setNoStreamWarn(true), 15000);
    return () => clearTimeout(t);
  }, [webCall.status, streamConnected]);

  // ── Ops mic VAD (best-effort) while the call is live ──
  React.useEffect(() => {
    if (webCall.status !== 'in_progress') return;
    let audioCtx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let raf = 0;
    let speaking = false;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        const Ctor: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
        audioCtx = new Ctor();
        const src = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        setMicOn(true);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i += 1) { const v = (buf[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / buf.length);
          if (rms > 0.08) { if (!speaking) { speaking = true; onCallerSpeechOnset(); } }
          else if (rms < 0.04) { speaking = false; }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch { setMicOn(false); /* VAD unavailable → use the Next override */ }
    })();
    return () => {
      cancelled = true;
      setMicOn(false);
      if (raf) cancelAnimationFrame(raf);
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      try { if (audioCtx) void audioCtx.close(); } catch { /* noop */ }
    };
  }, [webCall.status, onCallerSpeechOnset]);

  function handleClose() {
    try { webCall.hangup(); } catch { /* noop */ }
    onClose();
  }
  // Guarded close (Esc / overlay / X): confirm "End Call?" only while a call is
  // live; hang up + close on confirm. Required by the repo's Dialog lint rule.
  const guardedOpenChange = useFormDirtyGuard(handleClose, {
    isDirty: () => webCall.status === 'in_progress' || webCall.status === 'ringing' || webCall.status === 'connecting',
    title: 'End The Guided Call?',
    description: 'The call will be hung up.',
    confirmLabel: 'End Call',
    cancelLabel: 'Keep Talking',
  });

  async function apply() {
    const r = session?.result;
    if (!r) return;
    setApplying(true);
    try {
      const items = (r.deep_skill_items || [])
        .filter((_, i) => pickedSkills.has(i))
        .map((it) => ({ category_id: it.category_id, service_type_id: it.service_type_id, deep_skill_id: it.deep_skill_id, option_id: it.option_id }));
      const pincodeIds = Array.from(pickedPins);
      if (items.length) await api.put(`/admin/easyfixers/${efrId}/option-mappings`, { items });
      if (pincodeIds.length) await api.put(`/admin/easyfixers/${efrId}/serviceable-pincodes`, { pincodeIds });
      showToast({ variant: 'success', message: 'Captured skills and areas applied to the profile.' });
      await onApplied();
      onClose();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Could not apply to the profile.' });
    } finally {
      setApplying(false);
    }
  }

  const askedIds = new Set(askedRef.current.map((a) => a.id));
  const callChip = webCall.status === 'in_progress' ? 'On Call'
    : webCall.status === 'ringing' ? 'Ringing…'
    : webCall.status === 'connecting' ? 'Connecting…'
    : webCall.status === 'ended' ? 'Call Ended'
    : webCall.status === 'failed' ? (webCall.active?.endedReason || 'Call Failed')
    : (webCall.error ? 'Not Connected' : 'Idle');
  // Liveness is the BROWSER call's truth (not the DB session status, which lingers
  // at 'calling' until the connect-reaper). Drives which controls we show.
  const callLive = webCall.status === 'connecting' || webCall.status === 'ringing' || webCall.status === 'in_progress';
  const callProblem = webCall.status === 'failed' || !!webCall.error;
  // Config settled = loaded, errored, OR the 5s timeout fired. cfgFailed = couldn't
  // determine calling mode (error/timeout) — surface it instead of spinning forever.
  const cfgFailed = !cfg.data && (!!cfg.error || cfgTimedOut);
  const cfgSettled = !!cfg.data || cfgFailed;

  // Retry after a web-call FAILURE (the call was placed but failed). The SDK keeps
  // `active` non-null on failure, so placeWebCall's "already in progress" guard would
  // reject an immediate re-place — dismiss() first to clear it, then place once it
  // settles (the effect below fires when webCall goes idle/active-null).
  function retryCall() {
    setStartError(null);
    try { webCall.dismiss(); } catch { /* noop */ }
    setRetryPending(true);
  }
  React.useEffect(() => {
    if (!retryPending) return;
    if (webCall.active || webCall.status !== 'idle') return; // wait for dismiss() to clear the stale call
    setRetryPending(false);
    const sid = sessionRef.current?.sessionId || sessionId;
    if (sid) void webCall.placeWebCall({ efrId }, { teleprompterSessionId: sid, flow: AI_FLOW, callTo: callToRef.current || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryPending, webCall.active, webCall.status]);
  // Pre-start retry (the call was never placed — e.g. POST /start 409'd on STT).
  function retryStart() {
    startedRef.current = true;
    setStartError(null);
    void start();
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-info" /> Guided Verification Call
            <span className="ml-2 rounded-full bg-info-tint px-2 py-0.5 text-xs font-medium text-info-strong">{callChip}</span>
            {micOn && <span className="inline-flex items-center gap-1 text-xs text-success-strong"><Mic className="h-3 w-3" /> Listening</span>}
            {webCall.status === 'in_progress' && !micOn && <span className="inline-flex items-center gap-1 text-xs text-ink-500"><MicOff className="h-3 w-3" /> Manual</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 p-4">
          {/* ── Pre-session states (no session created yet) ── */}
          {!sessionId && (
            <>
              {startError && !starting && (
                <div className="rounded border border-urgent bg-urgent-tint p-3 text-sm text-urgent-strong">{startError}</div>
              )}
              {cfgFailed && !starting && (
                <div className="space-y-2">
                  <div className="rounded border border-urgent bg-urgent-tint p-3 text-sm text-urgent-strong">
                    Could not load call settings — you may not have calling permission. Please close and try again.
                  </div>
                  <div className="flex justify-end"><Button variant="outline" size="sm" onClick={onClose}>Close</Button></div>
                </div>
              )}

              {/* QA custom-number mode: the BE requires a "Call To" (won't dial the
                  real technician), so ask for it before starting. */}
              {!starting && needsNumber && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">QA Mode — Enter The Number To Dial For This Guided Call.</p>
                  <Label>Call To</Label>
                  <Input
                    inputMode="numeric"
                    maxLength={10}
                    value={callTo}
                    onChange={(e) => setCallTo(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    placeholder="10-digit mobile"
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={callTo.length !== 10}
                      onClick={() => { startedRef.current = true; void start(); }}
                      className="bg-primary hover:bg-brand-600 text-white"
                    >
                      <Phone className="mr-2 h-4 w-4" /> Start Guided Call
                    </Button>
                  </div>
                </div>
              )}

              {/* Non-QA pre-start failure (e.g. POST /start 409'd on STT) — offer retry. */}
              {!starting && startError && !needsNumber && (
                <div className="flex items-center justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
                  <Button size="sm" onClick={retryStart} className="bg-primary hover:bg-brand-600 text-white">
                    <Phone className="mr-2 h-4 w-4" /> Retry
                  </Button>
                </div>
              )}

              {/* Spinner: config load + non-QA auto-start (covers the one-frame gap).
                  Stops on cfgFailed (error OR 5s timeout) so it can never spin forever. */}
              {(starting || (!needsNumber && !startError && !cfgFailed)) && (
                <div className="flex items-center gap-2 text-sm text-ink-500"><Loader2 className="h-4 w-4 animate-spin" /> Starting the guided call…</div>
              )}
            </>
          )}

          {/* ── Failed session (STT drop / reaper) — banner + Close, NEVER the live view ── */}
          {sessionId && isFailed && (
            <div className="space-y-2">
              <div className="rounded border border-urgent bg-urgent-tint p-3 text-sm text-urgent-strong">{session?.error || 'The guided call could not be completed.'}</div>
              <div className="flex justify-end"><Button variant="outline" size="sm" onClick={onClose}>Close</Button></div>
            </div>
          )}

          {/* ── Live teleprompter (active, non-failed session) ── */}
          {sessionId && !isDone && !isFailed && !starting && (
            <>
              {callProblem && (
                <div className="rounded border border-urgent bg-urgent-tint p-3 text-sm text-urgent-strong">
                  {webCall.error || webCall.active?.endedReason || 'The call could not be connected. You can retry.'}
                </div>
              )}
              {callLive && !streamConnected && noStreamWarn && (
                <div className="rounded border border-warning bg-warning-tint p-3 text-sm text-warning-strong">
                  STT hasn&apos;t connected — this call won&apos;t be transcribed or analyzed. It&apos;s usually a
                  connectivity issue (the media stream can&apos;t reach the server), not a bad call. You can end and retry.
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Read the highlighted question. As the technician answers, the next question lights up automatically.
              </p>
              <div className="max-h-[46vh] space-y-1.5 overflow-y-auto rounded-md border border-ink-100 p-2">
                {questions.map((q) => {
                  const isCurrent = q.id === currentId;
                  const isNext = q.id === nextId && !isCurrent;
                  const wasAsked = askedIds.has(q.id) && !isCurrent;
                  return (
                    <div
                      key={q.id}
                      className={
                        'rounded-md px-3 py-2 text-sm transition-colors '
                        + (isCurrent ? 'bg-info text-white shadow-sm'
                          : isNext ? 'bg-warning-tint text-warning-strong ring-1 ring-warning'
                          : wasAsked ? 'bg-ink-50 text-ink-500'
                          : 'text-ink-700')
                      }
                    >
                      <div className="flex items-start gap-2">
                        {wasAsked && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />}
                        {isCurrent && <span className="mt-0.5 shrink-0 text-xs font-semibold uppercase tracking-wide">Ask now</span>}
                        {isNext && <span className="mt-0.5 shrink-0 text-xs font-semibold uppercase tracking-wide text-warning-strong">Up next</span>}
                        <span className={isCurrent ? 'font-medium' : ''}>{q.text}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {session?.transcript && (
                <div className="max-h-24 overflow-y-auto rounded-md border border-ink-100 bg-ink-50 p-2 text-xs text-ink-500 whitespace-pre-wrap">
                  {session.transcript.split('\n').slice(-6).join('\n')}
                </div>
              )}

              {callLive ? (
                <div className="flex items-center justify-between gap-2">
                  <Button variant="outline" size="sm" onClick={() => doPromote(nextId)} disabled={!nextId}>
                    Next <ChevronRight className="ml-2 h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleClose} className="text-urgent-strong">
                    <PhoneOff className="mr-2 h-4 w-4" /> End Call
                  </Button>
                </div>
              ) : callProblem ? (
                <div className="flex items-center justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
                  <Button size="sm" onClick={retryCall} className="bg-primary hover:bg-brand-600 text-white">
                    <Phone className="mr-2 h-4 w-4" /> Retry Call
                  </Button>
                </div>
              ) : streamConnected ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 text-xs text-ink-500">
                    <Loader2 className="h-3 w-3 animate-spin" /> Wrapping Up The Call…
                  </span>
                  <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
                </div>
              ) : (
                // Call ended but STT never attached → nothing was captured, so don't sit
                // on the backend connect-reaper for minutes. Fail fast with a retry.
                <div className="space-y-2">
                  <div className="rounded border border-urgent bg-urgent-tint p-3 text-sm text-urgent-strong">
                    The call ended but STT never connected, so nothing was captured. This is a
                    connectivity issue (the media stream couldn&apos;t reach the server) — check the
                    teleprompter stream config, then retry.
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
                    <Button size="sm" onClick={retryCall} className="bg-primary hover:bg-brand-600 text-white">
                      <Phone className="mr-2 h-4 w-4" /> Retry Call
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Completion: review + apply captured skills & areas ── */}
          {isDone && (
            <div className="space-y-3">
              {session?.coverage?.coverage_pct != null && (
                <div className="rounded-md border border-ink-100 bg-ink-50 p-2 text-sm">
                  Coverage: <span className="font-semibold">{session.coverage.coverage_pct}%</span>
                  <span className="text-ink-500"> ({session.coverage.covered}/{session.coverage.required_total} key questions asked)</span>
                </div>
              )}

              <div>
                <div className="mb-1 text-sm font-medium">Captured Deep Skills</div>
                {(session?.result?.deep_skill_items || []).length === 0 && <div className="text-xs text-ink-500">None captured.</div>}
                <div className="flex flex-wrap gap-1.5">
                  {(session?.result?.deep_skill_items || []).map((it, i) => (
                    <label key={i} className={'flex items-center gap-1 rounded-full border px-2 py-1 text-xs cursor-pointer ' + (pickedSkills.has(i) ? 'border-primary bg-brand-50 text-brand-600' : 'border-ink-100 text-ink-500')}>
                      <input
                        type="checkbox"
                        checked={pickedSkills.has(i)}
                        onChange={(e) => setPickedSkills((prev) => { const n = new Set(prev); if (e.target.checked) n.add(i); else n.delete(i); return n; })}
                      />
                      {it.label || `#${it.option_id}`}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1 text-sm font-medium">Serviceable Pincodes</div>
                {(session?.result?.serviceable_pincodes || []).length === 0 && <div className="text-xs text-ink-500">None captured.</div>}
                <div className="flex flex-wrap gap-1.5">
                  {(session?.result?.serviceable_pincodes || []).map((p) => (
                    <label key={p.pincode_id} className={'flex items-center gap-1 rounded-full border px-2 py-1 text-xs cursor-pointer ' + (pickedPins.has(p.pincode_id) ? 'border-primary bg-brand-50 text-brand-600' : 'border-ink-100 text-ink-500')}>
                      <input
                        type="checkbox"
                        checked={pickedPins.has(p.pincode_id)}
                        onChange={(e) => setPickedPins((prev) => { const n = new Set(prev); if (e.target.checked) n.add(p.pincode_id); else n.delete(p.pincode_id); return n; })}
                      />
                      {p.pincode}{p.city_name ? ` · ${p.city_name}` : ''}
                    </label>
                  ))}
                </div>
              </div>

              {(session?.result?.unmapped?.skills?.length || session?.result?.unmapped?.areas?.length) ? (
                <div className="rounded-md border border-warning bg-warning-tint p-2 text-xs text-warning-strong">
                  Could not auto-map: {[...(session?.result?.unmapped?.skills || []), ...(session?.result?.unmapped?.areas || [])].join(', ')}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2 border-t pt-3">
                <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
                <Button size="sm" onClick={apply} disabled={applying} className="bg-success hover:bg-success-strong text-white">
                  {applying ? 'Applying…' : 'Apply To Profile'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
