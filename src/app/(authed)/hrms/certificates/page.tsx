'use client';

/* ════════════════════════════════════════════════════════════════════════════
 * HRMS → Certificates
 *
 * The company's certificate template, on screen, with a form beside it. Type a
 * name and a title, watch the certificate fill in, download it as PDF, PNG or
 * JPG. That is the entire feature.
 *
 * ─── NOTHING IS STORED, AND THAT IS THE DESIGN ──────────────────────────────
 *
 * There is no certificate table, no issued_on, no revoke, no list. POST
 * /admin/certificates/render turns a request body into bytes and forgets it, so
 * this page has no read side at all — no fetch, no pagination, no row actions.
 * It is a form and a picture of what the form will produce.
 *
 * That is why this replaced two earlier screens rather than joining them: an
 * "LMS → Certificates" register had nothing to register (the LMS generates a
 * technician's certificate on course completion and stores none of it either),
 * and an "Issue Certificate" row action on Manage Users implied a per-user
 * record that does not exist. A recipient need not be in this database at all.
 *
 * ─── THE PREVIEW MUST NOT LIE ───────────────────────────────────────────────
 *
 * This is the whole engineering problem here. The downloaded file is rendered
 * by EasyFix_Backend `utils/pdf-certificate.js`, and a preview that disagrees
 * with it is worse than no preview — the operator would trust the screen and
 * ship the file. So the two are held together three ways:
 *
 *   1. SAME RECTANGLES. `certificate-layout.json` is a Brand Kit artefact,
 *      vendored by scripts/sync-brand-assets.mjs and read by BOTH sides. Text
 *      is never hand-placed here; every run goes in the rectangle the layout
 *      names for it.
 *   2. SAME ALGORITHM. `fitRun` below is a transcription of the backend's
 *      `fitRun`: cap the size to the box height, step down in half-point
 *      increments until the width fits, floor at 6pt, then truncate. The
 *      backend's `certificateSvg` composites its PNG/JPG exactly this way — an
 *      SVG text overlay on the frame — so this is the same construction, not
 *      an approximation of it.
 *   3. SAME VALUES. `certificateValues()` builds one object; the preview plans
 *      from it and the download POSTs it. There is no second place where a
 *      field could be trimmed, defaulted or omitted differently.
 *
 * The units are the artwork's own 3508x2480 canvas. The backend renders the PDF
 * at A4-landscape points and the images at this canvas, and its own comment
 * notes the fit "returns the same decision at 841.89pt and at 3508px" because
 * every length scales together — so SCALE below converts its point-based type
 * sizes once and everything after that is canvas units.
 *
 * ─── WHY AN <img> PLUS AN <svg>, NOT ONE INLINE SVG ─────────────────────────
 *
 * The frame is 32KB of vector artwork with no text in it. Inlining it would put
 * it in the JS bundle and in every render's diff; as an <img> it is a cached
 * static asset and the overlay is the only thing React touches.
 * ════════════════════════════════════════════════════════════════════════════ */

import * as React from 'react';
import { Award, Lock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DownloadButton } from '@/components/ui/download-button';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { downloadXlsx } from '@/lib/download-xlsx';
import { certificateInk } from '@/brand/palette';
import certificateLayout from '@/brand/certificate-layout.json';

/* ─── geometry ──────────────────────────────────────────────────────────── */

const CANVAS_W = certificateLayout.canvas.width;
const CANVAS_H = certificateLayout.canvas.height;

/*
 * A4 landscape is 841.89pt wide, which is the page the backend's PDF path uses.
 * Its type sizes are quoted in points against that page, so one multiplication
 * moves the whole style table onto this canvas and nothing downstream has to
 * know that points were ever involved.
 */
const SCALE = CANVAS_W / 841.89;
const MIN_SIZE = 6 * SCALE; // the backend's MIN_PT floor
const STEP = 0.5 * SCALE; // and its half-point shrink step

/*
 * Helvetica's own metrics, the two the backend reads off the embedded font:
 * ascender 718/1000 for the baseline, and (ascender + |descender|)/1000 =
 * (718 + 207)/1000 for pdfkit's currentLineHeight(). They are constants here
 * because the browser exposes no equivalent for an arbitrary font, and getting
 * them wrong shifts every run vertically by a percent or so — visible only when
 * the preview is held next to the PDF, which is precisely when it matters.
 */
const ASCENDER = 0.718;
const LINE_HEIGHT = 0.925;

/* The backend's SVG_FONT_STACK, so a glyph that falls back falls back the same
 * way on both sides. Helvetica first; Arial is metric-compatible with it. */
const FONT_STACK = "Helvetica, 'Liberation Sans', 'Nimbus Sans', Arial, sans-serif";

type RegionName = keyof typeof certificateLayout.regions;

/*
 * Per-region typography, transcribed from the backend's STYLE table with its
 * point sizes converted once. `bold` stands in for its Helvetica-Bold, and the
 * colours come from the brand module because this file may not hold a literal.
 */
const STYLE: Record<RegionName, { size: number; bold: boolean; color: string; tracking: number }> = {
  heading: { size: 15 * SCALE, bold: false, color: certificateInk.muted, tracking: 3 * SCALE },
  eyebrowPresentedTo: { size: 11 * SCALE, bold: false, color: certificateInk.muted, tracking: 2 * SCALE },
  recipientName: { size: 38 * SCALE, bold: true, color: certificateInk.ink, tracking: 0 },
  eyebrowFor: { size: 11 * SCALE, bold: false, color: certificateInk.muted, tracking: 1 * SCALE },
  title: { size: 22 * SCALE, bold: true, color: certificateInk.navy, tracking: 0 },
  dateLabel: { size: 8 * SCALE, bold: false, color: certificateInk.muted, tracking: 2 * SCALE },
  dateValue: { size: 12 * SCALE, bold: false, color: certificateInk.ink, tracking: 0 },
  signatoryName: { size: 12 * SCALE, bold: true, color: certificateInk.ink, tracking: 0 },
  signatoryTitle: { size: 8 * SCALE, bold: false, color: certificateInk.muted, tracking: 2 * SCALE },
  certificateIdLine: { size: 8 * SCALE, bold: false, color: certificateInk.muted, tracking: 1 * SCALE },
};

/* The fixed runs. The operator never types these — the renderer supplies them,
 * so the preview has to supply exactly the same strings. */
const DEFAULT_HEADING = 'CERTIFICATE OF COMPLETION';
const DEFAULT_EYEBROW = 'FOR SUCCESSFULLY COMPLETING THE TRAINING';
const PRESENTED_TO = 'PRESENTED TO';
const DATE_LABEL = 'DATE';

/* ─── values ────────────────────────────────────────────────────────────── */

type FormState = {
  recipientName: string;
  title: string;
  heading: string;
  dateYmd: string;
  certificateId: string;
  signatoryName: string;
  signatoryTitle: string;
};

const EMPTY_FORM: FormState = {
  recipientName: '', title: '', heading: '', dateYmd: '',
  certificateId: '', signatoryName: '', signatoryTitle: '',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/*
 * '2026-08-13' → '13 August 2026', read CHARACTER-WISE out of the input's value.
 *
 * Never `new Date('2026-08-13')`: that parses as UTC midnight and renders as the
 * previous day for anyone west of Greenwich. The value is a bare calendar day
 * the operator picked — it has no timezone, and giving it one is how a printed
 * certificate ends up dated a day early. Same output shape as the backend's
 * `formatDate`, because a date typed here and a date defaulted there must not
 * look like two different conventions on the same document.
 */
function formatCertificateDate(ymd: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return undefined;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month || Number(m[3]) < 1 || Number(m[3]) > 31) return undefined;
  return `${m[3]} ${month} ${m[1]}`;
}

/*
 * Today in IST, as the backend's `todayIst()` computes it: shift the epoch by
 * +5:30 and read the UTC calendar day off the result. Deliberately NOT the
 * browser's local date — an operator in another timezone must see the date the
 * server will actually print, and this arithmetic gives the same answer from
 * any clock.
 */
function todayIstYmd(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/*
 * THE one conversion from form to wire. Both the preview and the POST body come
 * from here, which is what makes "what you see is what downloads" structural
 * rather than something two code paths have to agree about by hand.
 *
 * A blank optional field becomes `undefined`, never `''`. The distinction is
 * load-bearing at both ends: JSON.stringify drops an undefined key entirely, so
 * the renderer falls back to its own default (or omits the run), whereas `''`
 * for dateText specifically means "print no date at all" — a different request.
 */
function certificateValues(f: FormState) {
  const opt = (s: string) => (s.trim() === '' ? undefined : s.trim());
  return {
    recipientName: f.recipientName.trim(),
    title: f.title.trim(),
    heading: opt(f.heading),
    dateText: f.dateYmd ? formatCertificateDate(f.dateYmd) : undefined,
    certificateId: opt(f.certificateId),
    signatoryName: opt(f.signatoryName),
    signatoryTitle: opt(f.signatoryTitle),
  };
}

type CertificateValues = ReturnType<typeof certificateValues>;

type PlannedRun = {
  name: RegionName;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
};

/*
 * Which runs exist, and with what text — the backend's `wanted` list and its
 * omission rule, in the same order and with the same dependencies:
 *
 *   - an absent dateText means TODAY, not "no date"; only an explicit '' would
 *     suppress the pair, and this page has no control that produces one;
 *   - the DATE label appears only when there is a date under it;
 *   - the signatory title appears only when there is a name above it, so a
 *     stray "Head Of Training" can never float under a blank rule;
 *   - a blank value draws nothing, which is why an untouched form previews as
 *     an empty template rather than as sample text. Showing a placeholder name
 *     here would be the preview telling a lie the download cannot honour.
 */
function planRuns(v: CertificateValues): PlannedRun[] {
  const date = v.dateText === undefined ? formatCertificateDate(todayIstYmd()) : v.dateText;
  const wanted: [RegionName, string | undefined][] = [
    ['heading', v.heading || DEFAULT_HEADING],
    ['eyebrowPresentedTo', PRESENTED_TO],
    ['recipientName', v.recipientName],
    ['eyebrowFor', DEFAULT_EYEBROW],
    ['title', v.title],
    ['dateValue', date],
    ['dateLabel', date ? DATE_LABEL : ''],
    ['signatoryName', v.signatoryName],
    ['signatoryTitle', v.signatoryName ? v.signatoryTitle : ''],
    ['certificateIdLine', v.certificateId],
  ];

  const runs: PlannedRun[] = [];
  for (const [name, value] of wanted) {
    if (value === undefined || value.trim() === '') continue;
    const r = certificateLayout.regions[name];
    runs.push({
      name,
      text: value.trim(),
      rect: { x: r.x * CANVAS_W, y: r.y * CANVAS_H, w: r.w * CANVAS_W, h: r.h * CANVAS_H },
    });
  }
  return runs;
}

/* ─── fitting ───────────────────────────────────────────────────────────── */

/*
 * Size one <text> to its rectangle and set its baseline. The backend's `fitRun`,
 * measured against the browser instead of pdfkit.
 *
 * WHY TWO PROBES AND NOT A LOOP. The backend can afford to step the size down
 * half a point at a time because pdfkit measures from a font table in memory;
 * here every measurement is a synchronous layout flush, and 64 of them per run
 * across ten runs on every keystroke is not a preview, it is a stutter. Width is
 * AFFINE in font size — `w(s) = a·s + b`, where b is the tracking, which is a
 * fixed length and does not scale — so two measurements determine the line
 * exactly and the fitting size is solved rather than searched. Two probes, not
 * one, precisely because b is not zero for the tracked runs.
 *
 * The result is then snapped BACK onto the backend's half-point grid, walking
 * down from the same starting size, so both sides land on the identical value
 * rather than on two numbers that merely round to the same picture.
 */
function fitRun(el: SVGTextElement, run: PlannedRun) {
  const st = STYLE[run.name];
  const maxW = run.rect.w;

  el.textContent = run.text;
  /* Height first: a size taller than the box can never fit, so it is capped
   * before a single width measurement is taken. */
  const cap = Math.min(st.size, run.rect.h / 1.25);
  el.setAttribute('font-size', String(cap));

  let size = cap;
  const natural = el.getComputedTextLength();
  if (natural > maxW) {
    const probe = cap / 2;
    el.setAttribute('font-size', String(probe));
    const halved = el.getComputedTextLength();
    const a = (natural - halved) / (cap - probe);
    const b = natural - a * cap;
    const exact = a > 0 ? (maxW - b) / a : cap;
    const steps = Math.ceil((cap - exact) / STEP);
    size = Math.max(MIN_SIZE, cap - steps * STEP);
    el.setAttribute('font-size', String(size));

    /*
     * The backstop, and the reason it is here rather than assumed away: the
     * inputs cap LENGTH to match the endpoint's Joi limits, but 120 characters
     * of 'W' still overruns the name box at the 6pt floor. The backend
     * truncates with an ellipsis at exactly this point, so this does too —
     * otherwise the one case where the two could differ is the one where the
     * operator most needs to see what they are about to send.
     */
    if (el.getComputedTextLength() > maxW) {
      let out = run.text;
      while (out.length > 1) {
        el.textContent = `${out}…`;
        if (el.getComputedTextLength() <= maxW) break;
        out = out.slice(0, -1);
      }
    }
  }

  /* Vertically centred by LINE BOX, not by cap height — pdfkit places the line
   * box and this has to place the same one, or short and tall runs drift apart
   * in opposite directions. */
  const top = run.rect.y + Math.max(0, (run.rect.h - LINE_HEIGHT * size) / 2);
  el.setAttribute('y', String(top + ASCENDER * size));
}

function CertificatePreview({ values }: { values: CertificateValues }) {
  const runs = planRuns(values);
  const svgRef = React.useRef<SVGSVGElement>(null);

  /*
   * No dependency array on purpose. Every render of this component is a change
   * to what the runs say, and the fit depends on measurements only the browser
   * can take once the text is committed to the DOM — so the pass belongs after
   * every commit. `useLayoutEffect` rather than `useEffect` so the sized text is
   * what paints; with the latter the preview flickers through the unfitted size
   * on each keystroke.
   */
  React.useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const nodes = svg.querySelectorAll<SVGTextElement>('text[data-region]');
    for (const el of Array.from(nodes)) {
      const run = runs.find((r) => r.name === el.dataset.region);
      if (run) fitRun(el, run);
    }
  });

  return (
    <div
      className="relative w-full overflow-hidden rounded-md border border-border bg-card"
      style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
    >
      {/*
        * The artwork, vendored from the Brand Kit by scripts/sync-brand-assets.mjs.
        * Empty of text by design — every word on the certificate is placed by the
        * overlay below. Decorative, so it carries no alt text: the certificate's
        * content is the <text> runs, which a screen reader reads directly.
        */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/easyfix-certificate-frame.svg"
        alt=""
        className="absolute inset-0 h-full w-full"
      />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label="Certificate Preview"
      >
        {runs.map((r) => (
          <text
            key={r.name}
            data-region={r.name}
            /* x and the anchor are the whole of the horizontal placement: every
               run on this document is centred in its own rectangle. `y` and
               `font-size` are deliberately absent — fitRun owns them, because
               both depend on a measurement that only exists after paint. */
            x={r.rect.x + r.rect.w / 2}
            textAnchor="middle"
            fill={STYLE[r.name].color}
            fontFamily={FONT_STACK}
            fontWeight={STYLE[r.name].bold ? 700 : 400}
            letterSpacing={STYLE[r.name].tracking || undefined}
          >
            {r.text}
          </text>
        ))}
      </svg>
    </div>
  );
}

/* ─── page ──────────────────────────────────────────────────────────────── */

function PageHeading() {
  return (
    <div>
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <Award className="size-6" /> Certificates
      </h1>
      <p className="text-sm text-muted-foreground">
        Fill in the certificate and download it. Nothing is stored — the file is generated on
        each download and never saved, so keep the copy you download.
      </p>
    </div>
  );
}

type Format = 'pdf' | 'png' | 'jpg';

export default function CertificatesPage() {
  const { me } = useMe();
  /*
   * isCertificateIssue, the key POST /admin/certificates/render enforces. One
   * key, not a view/act pair: the page has no read side to grant separately —
   * everything on it is in service of producing a file.
   */
  const can = actionFlags(me, ['isCertificateIssue']);

  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = React.useState<Format | null>(null);

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const values = certificateValues(form);
  /* The endpoint requires both, so the download buttons stay disabled until it
   * would accept the body — a 400 for a field the operator can see is empty is
   * a round trip that teaches them nothing. */
  const ready = values.recipientName !== '' && values.title !== '';

  async function download(format: Format) {
    setBusy(format);
    const toastId = showToast({ variant: 'loading', message: 'Generating Certificate…' });
    try {
      /*
       * downloadXlsx, not api.post: this response is a byte stream, and the api
       * wrapper parses JSON, which corrupts it. The helper does the authed
       * fetch, the blob, the object URL and the anchor — the same recipe every
       * other download in the CRM uses.
       */
      await downloadXlsx({
        url: '/admin/certificates/render',
        filename: `${certificateFilename(values)}.${format}`,
        body: { ...values, format },
      });
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Certificate Downloaded' });
    } catch (e) {
      dismissToast(toastId);
      const msg = e instanceof Error ? e.message : String(e);
      showToast({ variant: 'error', message: `Certificate Download Failed — ${msg}` });
    } finally {
      setBusy(null);
    }
  }

  if (!can.isCertificateIssue) {
    return (
      <div className="space-y-4">
        <PageHeading />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-warning-tint text-warning-strong">
              <Lock className="size-6" />
            </span>
            <div className="space-y-1">
              <div className="text-base font-semibold">Access Denied</div>
              <p className="max-w-md text-sm text-muted-foreground">
                You don’t have permission to issue certificates. Ask an admin to grant you
                Certificate Issue
                (<code className="mx-0.5">isCertificateIssue</code>) in Settings → Manage Roles.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeading />

      {/* Preview first on a narrow screen, beside the form from lg up — the
          point of the screen is watching the document change as you type. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardContent className="p-4">
            <CertificatePreview values={values} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="text-base font-semibold">Certificate Details</div>

            <div>
              <Label className="mb-1 block">Recipient Name *</Label>
              {/* maxLength mirrors the endpoint's Joi cap on every field: the
                  limit is reached at the keyboard rather than as a 400 after
                  the operator has finished typing. */}
              <Input
                value={form.recipientName}
                onChange={set('recipientName')}
                maxLength={120}
                placeholder="Full Name As It Should Print"
              />
            </div>

            <div>
              <Label className="mb-1 block">Title *</Label>
              <Input
                value={form.title}
                onChange={set('title')}
                maxLength={160}
                placeholder="Training Or Event Name"
              />
            </div>

            <div>
              <Label className="mb-1 block">Heading</Label>
              {/* The placeholder is the renderer's own default, so leaving this
                  empty is visibly a choice rather than an empty banner. */}
              <Input
                value={form.heading}
                onChange={set('heading')}
                maxLength={80}
                placeholder="Certificate Of Completion"
              />
            </div>

            <div>
              <Label className="mb-1 block">Date</Label>
              {/* Native date input — the platform already ships the picker, the
                  locale handling and the keyboard entry. Left empty the
                  certificate carries today's date in IST, which is what the
                  preview is already showing. */}
              <Input type="date" value={form.dateYmd} onChange={set('dateYmd')} />
            </div>

            <div>
              <Label className="mb-1 block">Certificate ID</Label>
              <Input
                value={form.certificateId}
                onChange={set('certificateId')}
                maxLength={40}
                placeholder="Optional Reference"
              />
            </div>

            <div>
              <Label className="mb-1 block">Signatory Name</Label>
              <Input
                value={form.signatoryName}
                onChange={set('signatoryName')}
                maxLength={80}
                placeholder="Who Signs It"
              />
            </div>

            <div>
              <Label className="mb-1 block">Signatory Title</Label>
              <Input
                value={form.signatoryTitle}
                onChange={set('signatoryTitle')}
                maxLength={80}
                placeholder="Head Of Training"
              />
            </div>

            <div className="space-y-2 pt-1">
              {(['pdf', 'png', 'jpg'] as const).map((f) => (
                <DownloadButton
                  key={f}
                  onClick={() => void download(f)}
                  disabled={!ready}
                  downloading={busy === f}
                  label={`Download ${f.toUpperCase()}`}
                  loadingLabel="Generating…"
                  title={ready ? undefined : 'Enter A Recipient Name And A Title First'}
                  className="md:w-full"
                />
              ))}
              <p className="text-xs text-muted-foreground">
                PDF prints; PNG and JPG are for sharing on screen. All three are the same
                artwork at full quality.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* A blob download takes its name from the anchor's `download` attribute, so
 * without this the file saves under an opaque object-URL id. */
function certificateFilename(v: CertificateValues): string {
  const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `EasyFix-Certificate-${slug(v.recipientName) || 'recipient'}-${slug(v.title) || 'certificate'}`;
}
