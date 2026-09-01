'use client';

/*
 * Settings → Theme & Branding.
 *
 * One screen over two very different backends, both behind /api/admin/branding
 * (routes/admin/branding.js · services/branding.service.js):
 *
 *   1. SETTINGS — chrome copy stored in `easyfix_properties`, read through
 *      GET /admin/branding and written with PUT /admin/branding/settings.
 *      Three switches' worth of text an operator flips during an incident:
 *      the environment banner, the maintenance banner and the login tagline.
 *      `''` is a MEANINGFUL value on every text field — it is how a banner is
 *      cleared — so the form always PUTs all five keys rather than pruning
 *      blanks.
 *
 *   2. VARIANTS — rows in `easyfix_theme_variant`: a dated window during which
 *      the login page wears a festival ornament. Columns map 1:1 to the table:
 *        name         display name, 2–80 chars
 *        starts_on /  DATE-only window, inclusive at both ends. Sent as literal
 *        ends_on      'YYYY-MM-DD' strings, never Date objects — a timezone-
 *                     bearing ISO instant round-trips through UTC and can land
 *                     a window a day early (the Joi schema rejects anything
 *                     that is not YYYY-MM-DD for exactly this reason).
 *        ornament_key S3 object under the `Branding/` prefix, or NULL for a
 *                     plain logo. Written ONLY by the upload endpoint.
 *        anchor_x /   PERCENTAGES of the logo box (not pixels). Values outside
 *        anchor_y     0–100 are legal — that is how an ornament is bled off the
 *                     edge of the frame.
 *        scale        percentage; 100 = the ornament's natural size.
 *        animated     whether the asset's own motion is allowed to play.
 *        render_mode  'overlay' (default) draws the ornament OVER the lockup at
 *                     the anchor/scale above; 'replace' shows the uploaded asset
 *                     ON ITS OWN with no lockup beneath it, which is what a
 *                     client-specific or fully-redrawn festival logo needs.
 *                     Geometry is meaningless in 'replace' — there is no logo
 *                     box for a percentage to be a percentage OF — so the inputs
 *                     are disabled rather than hidden (hiding them makes the
 *                     form jump) and their stored values are still round-tripped
 *                     so flipping back to 'overlay' restores the old placement.
 *        enabled      soft-delete flag. DELETE disables, it never removes —
 *                     a festival window is reference data that gets re-enabled
 *                     next year, so the row must survive.
 *
 * PERMISSIONS — ordinary RBAC, no property gate:
 *   isBrandingView  read everything on this page
 *   isBrandingEdit  every write, including the ornament upload
 * The ONE property-gated thing here is the AI art generator
 * (FEATURES.canGenerateBrandArt → branding.ai.emails), read per-user from
 * GET /admin/access/features. It spends model credits and publishes an image
 * to the UNAUTHENTICATED login page, so it follows a person, not a role, and
 * never appears on the Manage Role screen.
 *
 * "NO CHANGE" ON EDIT — deliberate asymmetry. On CREATE the option means
 * ornament_key = null (there is nothing to keep). On EDIT it omits the field
 * from the PATCH entirely, so re-saving a variant to fix a typo in its name
 * cannot silently wipe an ornament that took a designer an afternoon. PATCH is
 * partial by contract (`.min(1)`), so omitting the key is a first-class move.
 *
 * PREVIEW FIDELITY — the admin has no way to know an ornament's natural pixel
 * size, so the preview normalises it to the logo's height first and applies
 * `scale` on top of that. Geometry is therefore directionally right (anchor and
 * relative size behave exactly as on the login page) but not pixel-exact.
 *
 * PREVIEWING A STORED ORNAMENT — GET /admin/branding hands back the ornament
 * KEY, never a URL, because an S3 object under `Branding/` is private and needs
 * signing. Until this page had a way to ask for that signature it could only
 * show the ONE variant whose window brackets today (the unauthenticated
 * /public/branding/active read), so scheduling Diwali in August meant editing
 * an ornament sight-unseen. GET /admin/branding/variants/:id/ornament-url now
 * signs any variant on demand — see useOrnamentUrl() below for the three
 * no-network fast paths it tries first.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Palette, Plus, Pencil, XCircle, CheckCircle2, AlertTriangle, Lock,
  UploadCloud, Sparkles, Ban, Info, Layers, Image as ImageIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { IconButton } from '@/components/ui/icon-button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { Logo } from '@/components/brand/Logo';
import { festivalById } from '@/components/brand/festivals';
import { api, ApiError } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useFetch, useFetchOnce, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

/* ─── shapes ─────────────────────────────────────────────────────────── */

type BrandingSettings = {
  envBannerText: string;
  envBannerEnabled: boolean;
  maintenanceBannerText: string;
  maintenanceBannerEnabled: boolean;
  loginTagline: string;
  /* Read-only here. The kill switch lives in easyfix_properties and is flipped
   * by ops directly, so the API exposes it but accepts no write for it. */
  festivalEnabled: boolean;
};

/*
 * How the ornament relates to the EasyFix lockup.
 *
 * Rows written before the column existed come back NULL/undefined and the
 * backend defaults them to 'overlay'; renderModeOf() mirrors that default so an
 * old row reads on this screen exactly as it renders on the login page.
 */
type RenderMode = 'overlay' | 'replace';

const renderModeOf = (v: { render_mode?: RenderMode | null } | null | undefined): RenderMode =>
  v?.render_mode === 'replace' ? 'replace' : 'overlay';

/* `animated` / `enabled` are TINYINT(1). The pool's typeCast returns booleans,
 * but a hand-written row or an older driver can still surface 1/0 — so they are
 * typed as the union and read through isOn() rather than trusted as booleans. */
type Variant = {
  id: number;
  name: string;
  starts_on: string;
  ends_on: string;
  ornament_key: string | null;
  anchor_x: number | null;
  anchor_y: number | null;
  scale: number | null;
  render_mode?: RenderMode | null;
  animated: boolean | number;
  enabled: boolean | number;
  created_by: number | null;
  created_at: string | null;
};

type BrandingResponse = { settings: BrandingSettings; variants: Variant[] };
type ActiveVariantResponse = { variant: (Variant & { ornament_url: string | null }) | null };
type FeatureFlags = { canGenerateBrandArt?: boolean };
type OrnamentUpload = { key: string; url: string };
/* `url` is null for a variant with no ornament, and for a stored key the backend
 * refused to sign (anything outside the `Branding/` prefix). Both are ordinary
 * display states, which is why the endpoint 200s on them rather than erroring.
 * `expiresIn` is null for the local-dev /easydoc path, which never expires. */
type OrnamentUrlResponse = { url: string | null; expiresIn: number | null };

/* ─── constants ──────────────────────────────────────────────────────── */

const BRANDING_KEY = '/admin/branding';
/* Joi caps, mirrored so the operator is stopped by a maxLength rather than a
 * 400. Drifting from validators/branding.validator.js only costs a round trip. */
const ENV_TEXT_MAX = 200;
const MAINT_TEXT_MAX = 300;
const TAGLINE_MAX = 160;
const NAME_MAX = 80;
/* Preview logo height in px; also the ornament's 100%-scale reference height. */
const LOGO_PX = 44;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ─── helpers ────────────────────────────────────────────────────────── */

const isOn = (v: boolean | number | null | undefined) => v === true || v === 1;

/* 'YYYY-MM-DD' → '18 Aug 2026', by string surgery rather than `new Date()`.
 * Parsing a date-only string yields UTC midnight, which renders as the previous
 * day in any timezone west of Greenwich and is a bug waiting for a traveller. */
function dateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  return `${m[3]} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/* `<input type="date">` only accepts YYYY-MM-DD. */
const dateValue = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : '');

/* Today in IST as YYYY-MM-DD. en-CA is the one common locale whose short date
 * format IS ISO, which makes it the cheapest correct way to ask "what is the
 * date in Asia/Kolkata right now" without pulling in a date library. */
function todayInIst(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

const isLive = (v: Variant, today: string) =>
  isOn(v.enabled) && dateValue(v.starts_on) <= today && today <= dateValue(v.ends_on);

/*
 * Built-in ornaments (src/components/brand/festivals.ts) ship in `public/` and
 * are stored in ornament_key as their own public path — a legal value under the
 * validator's LOCAL branch (`^/[A-Za-z0-9._\-/]+$`), which is also why the
 * resolver hands them back unsigned. Recognising one lets the table print
 * "Diwali" instead of a file path and lets the preview render it with no upload.
 *
 * FAILS SOFT, matching festivalById's own contract: an unrecognised path is an
 * ordinary custom ornament, never an error.
 */
function builtInFestival(key: string | null | undefined) {
  if (!key) return null;
  const m = /^\/brand\/festivals\/([a-z0-9-]+)\.svg$/.exec(String(key));
  return m ? festivalById(m[1]) : null;
}

/* Numeric field → number, tolerating the empty string a cleared input produces. */
const numOr = (raw: string, fallback: number) => {
  const n = Number(raw);
  return raw.trim() === '' || Number.isNaN(n) ? fallback : n;
};

/* ─── ornament preview resolution ────────────────────────────────────── */

type OrnamentPreview = { src: string | null; loading: boolean; error: string | null };

/*
 * Resolve ONE variant's ornament to something an <img> can actually load.
 *
 * Three fast paths first, all free — no request is made unless every one misses:
 *   1. an upload made in THIS session, whose response already carried a signed
 *      URL (`sessionUrl`);
 *   2. a built-in ornament, which ships in public/ and is served unsigned;
 *   3. the local-dev /easydoc path writeBuffer() stores, likewise unsigned.
 * Only a private `Branding/…` S3 key reaches the network, and then it costs one
 * GET /admin/branding/variants/:id/ornament-url.
 *
 * LAZY BY CONSTRUCTION. `useFetch(null)` is a no-op, so passing `v = null` — as
 * the modal does while it is closed — means the row that is not on screen never
 * fetches. The page therefore signs at most the ONE variant in the preview card
 * plus the ONE being edited, not all hundred in the table.
 *
 * The presigned URL goes onto <img src> raw. Do NOT route it through api.get or
 * anything that attaches the CRM bearer: S3 rejects a request carrying both a
 * signature and an Authorization header with a 400, and the symptom is a broken
 * image with a completely unrelated-looking error.
 */
function useOrnamentUrl(v: Variant | null, sessionUrl: string | null): OrnamentPreview {
  const immediate = useMemo(() => {
    if (!v) return null;
    if (sessionUrl) return sessionUrl;
    const builtIn = builtInFestival(v.ornament_key);
    if (builtIn) return builtIn.src;
    if (v.ornament_key && v.ornament_key.startsWith('/')) return v.ornament_key;
    return null;
  }, [v, sessionUrl]);

  const needsSigning = !!v && !immediate && !!v.ornament_key;
  const { data, loading, error } = useFetch<OrnamentUrlResponse>(
    needsSigning ? `${BRANDING_KEY}/variants/${v!.id}/ornament-url` : null,
  );

  return {
    src: immediate ?? data?.url ?? null,
    /* Only ever "loading" when a request is genuinely in flight — useFetch
     * reports loading:false for a null key, but guarding here keeps the caller
     * from having to know that. */
    loading: needsSigning && loading,
    error: needsSigning ? error : null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
 * Page
 * ═══════════════════════════════════════════════════════════════════════ */

export default function ThemeBrandingPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isBrandingView', 'isBrandingEdit']);

  /* Per-user property-gated capability, same call the Admin Actions page makes.
   * Fails CLOSED: until the flag lands, the AI option does not exist. */
  const featureAccess = useFetchOnce<FeatureFlags>('/admin/access/features');
  const canGenerateBrandArt = featureAccess.data?.canGenerateBrandArt === true;

  const { data, loading, error, refetch } = useFetch<BrandingResponse>(
    can.isBrandingView ? BRANDING_KEY : null,
  );

  /* Read purely to answer "what is the login page wearing RIGHT NOW", which is
   * what the preview card defaults to. It is the authoritative answer because it
   * applies the festival kill switch as well as the dates, which a client-side
   * isLive() cannot see. Its `ornament_url` is deliberately NOT used as an image
   * source any more: /admin/branding/variants/:id/ornament-url signs every
   * variant uniformly and with a TTL sized for an editing session, so having one
   * variant resolve through a different, shorter-lived URL would just be a
   * special case waiting to expire mid-edit. */
  const activeResp = useFetchOnce<ActiveVariantResponse>('/public/branding/active');
  const activeVariant = activeResp.data?.variant ?? null;

  const variants = useMemo(() => data?.variants ?? [], [data]);
  const today = todayInIst();

  /* Presigned URLs handed back by uploads made in THIS session, keyed by
   * variant id. Without them a just-uploaded ornament would show as "no
   * preview" until the operator reloaded onto a festival day. */
  const [sessionOrnaments, setSessionOrnaments] = useState<Record<number, string>>({});

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Variant | null>(null);
  const [previewId, setPreviewId] = useState<number | ''>('');

  function refreshBranding() {
    invalidateFetch((k) => k.startsWith(BRANDING_KEY));
    refetch();
  }

  /* ─── settings form ─────────────────────────────────────────────── */

  const [form, setForm] = useState<BrandingSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  useEffect(() => { if (data?.settings) setForm(data.settings); }, [data?.settings]);

  const patchForm = (p: Partial<BrandingSettings>) =>
    setForm((f) => (f ? { ...f, ...p } : f));

  async function handleSaveSettings() {
    if (!form) return;
    setSavingSettings(true);
    try {
      /* All five keys, always. A blank string is how a banner is cleared, so
       * pruning empties here would make "clear the banner" impossible. */
      await api.put(`${BRANDING_KEY}/settings`, {
        envBannerText: form.envBannerText ?? '',
        envBannerEnabled: !!form.envBannerEnabled,
        maintenanceBannerText: form.maintenanceBannerText ?? '',
        maintenanceBannerEnabled: !!form.maintenanceBannerEnabled,
        loginTagline: form.loginTagline ?? '',
      });
      showToast({ variant: 'success', message: 'Branding Settings Saved' });
      refreshBranding();
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not save branding settings' }) });
    } finally {
      setSavingSettings(false);
    }
  }

  /* ─── variant row actions ───────────────────────────────────────── */

  async function handleDisable(v: Variant) {
    const ok = await confirm({
      title: 'Deactivate Festival Window?',
      description:
        `"${v.name}" will stop appearing on the login page immediately. The row is kept — ` +
        'nothing is deleted - so you can reactivate the same window next year.',
      confirmLabel: 'Deactivate',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.delete(`${BRANDING_KEY}/variants/${v.id}`);
      showToast({ variant: 'success', message: 'Festival Window Deactivated' });
      refreshBranding();
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 404
        ? 'That festival window no longer exists — reloading the list.'
        : formatApiError(e, { fallback: 'Deactivate failed' });
      showToast({ variant: 'error', message: msg });
      refreshBranding();
    }
  }

  async function handleReactivate(v: Variant) {
    try {
      await api.patch(`${BRANDING_KEY}/variants/${v.id}`, { enabled: true });
      showToast({ variant: 'success', message: 'Festival Window Reactivated' });
      refreshBranding();
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Reactivate failed' }) });
    }
  }

  /* ─── preview selection ─────────────────────────────────────────── */

  /* Default the preview to whatever the login page is wearing today, falling
   * back to the newest row so the card is never empty on an ordinary Tuesday. */
  const effectivePreviewId: number | '' = previewId !== '' ? previewId
    : activeVariant ? activeVariant.id
    : variants.length ? variants[0].id
    : '';
  const previewVariant = variants.find((v) => v.id === effectivePreviewId) ?? null;

  /* Exactly two ornaments are ever on screen: the one in the preview card and
   * the one in the open modal. Each gets its own signed URL, and the modal's is
   * gated on `modalOpen` so a closed dialog costs nothing. */
  const previewOrnament = useOrnamentUrl(
    previewVariant,
    previewVariant ? sessionOrnaments[previewVariant.id] ?? null : null,
  );
  const editingVariant = modalOpen ? editing : null;
  const editingOrnament = useOrnamentUrl(
    editingVariant,
    editingVariant ? sessionOrnaments[editingVariant.id] ?? null : null,
  );

  /* ─── render ────────────────────────────────────────────────────── */

  if (!can.isBrandingView) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Palette className="size-6" /> Theme &amp; Branding
        </h1>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-warning-tint text-warning-strong">
              <Lock className="size-6" />
            </span>
            <div className="space-y-1">
              <div className="text-base font-semibold">Access Denied</div>
              <p className="max-w-md text-sm text-muted-foreground">
                You don&rsquo;t have permission to view Theme &amp; Branding. Ask an admin to grant
                you <code className="mx-0.5">isBrandingView</code> in Settings &rarr; Manage Roles.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Palette className="size-6" /> Theme &amp; Branding
          </h1>
          <p className="text-sm text-muted-foreground">
            Banner copy, the login tagline, and the festival ornament calendar the login page wears.
          </p>
        </div>
      </div>

      {error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4 shrink-0" /> {error}
          </CardContent>
        </Card>
      )}

      {!can.isBrandingEdit && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Info className="size-4 shrink-0 text-info" />
            View-only. Editing needs the <code className="mx-0.5">isBrandingEdit</code> permission.
          </CardContent>
        </Card>
      )}

      {/* ─── 1. Branding Settings ─────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div>
            <h2 className="text-base font-semibold">Branding Settings</h2>
            <p className="text-sm text-muted-foreground">
              Saved to <code className="mx-0.5">easyfix_properties</code> and live within seconds of
              saving. Clearing a text box and saving removes that banner.
            </p>
          </div>

          {loading && !form && (
            <div className="text-sm text-muted-foreground py-4">Loading&hellip;</div>
          )}

          {form && (
            <div className="space-y-4">
              {/* Environment banner */}
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label htmlFor="env-enabled">Environment Banner</Label>
                    <p className="text-xs text-muted-foreground">
                      A persistent strip warning that this is not production.
                    </p>
                  </div>
                  <Switch
                    id="env-enabled"
                    ariaLabel="Environment Banner Enabled"
                    checked={!!form.envBannerEnabled}
                    disabled={!can.isBrandingEdit}
                    onCheckedChange={(next) => patchForm({ envBannerEnabled: next })}
                  />
                </div>
                <Input
                  value={form.envBannerText ?? ''}
                  maxLength={ENV_TEXT_MAX}
                  disabled={!can.isBrandingEdit}
                  placeholder="QA environment — not production"
                  onChange={(e) => patchForm({ envBannerText: e.target.value })}
                />
              </div>

              {/* Maintenance banner */}
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label htmlFor="maint-enabled">Maintenance Banner</Label>
                    <p className="text-xs text-muted-foreground">
                      Scheduled-downtime notice shown above the login form.
                    </p>
                  </div>
                  <Switch
                    id="maint-enabled"
                    ariaLabel="Maintenance Banner Enabled"
                    checked={!!form.maintenanceBannerEnabled}
                    disabled={!can.isBrandingEdit}
                    onCheckedChange={(next) => patchForm({ maintenanceBannerEnabled: next })}
                  />
                </div>
                <Input
                  value={form.maintenanceBannerText ?? ''}
                  maxLength={MAINT_TEXT_MAX}
                  disabled={!can.isBrandingEdit}
                  placeholder="Planned maintenance on Sunday 02:00–04:00 IST"
                  onChange={(e) => patchForm({ maintenanceBannerText: e.target.value })}
                />
              </div>

              {/* Login tagline */}
              <div className="rounded-md border p-3 space-y-2">
                <Label htmlFor="login-tagline">Login Page Tagline</Label>
                {/* The placeholder is PREFIXED so the grey text cannot be misread as a
                  * SAVED tagline — unprefixed it was plausible enough that operators
                  * believed the field was already populated and left it blank, then
                  * wondered why the login page had no tagline. What follows the dash
                  * is still a real, valid tagline, so it doubles as the example. */}
                <Input
                  id="login-tagline"
                  value={form.loginTagline ?? ''}
                  maxLength={TAGLINE_MAX}
                  disabled={!can.isBrandingEdit}
                  placeholder="Example — India's trusted home services network"
                  onChange={(e) => patchForm({ loginTagline: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Sits under the logo on the sign-in screen. Up to {TAGLINE_MAX} characters.
                  Leave it blank for no tagline.
                </p>
              </div>

              {can.isBrandingEdit && (
                <div className="flex justify-end">
                  <Button onClick={handleSaveSettings} disabled={savingSettings}>
                    {savingSettings ? 'Saving…' : 'Save Branding Settings'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── 2. Festival Logo Schedule ────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          <div className="p-4 pb-3 flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-base font-semibold">Festival Logo Schedule</h2>
              <p className="text-sm text-muted-foreground">
                Dated windows, inclusive of both dates. When two overlap, the one that starts later wins.
              </p>
            </div>
            {/*
              * The Add button lives HERE, not in the page header. It creates a
              * festival window and nothing else, so it belongs beside the table
              * it writes to — a page-level action implies it acts on the page,
              * which would be wrong next to the Branding Settings form above.
              */}
            <div className="flex items-center gap-2">
              {form && (
                <span className={`text-xs rounded-full px-2 py-1 ${form.festivalEnabled ? 'bg-success-tint text-success-strong' : 'bg-neutral-tint text-neutral-strong'}`}>
                  {form.festivalEnabled ? 'Ornaments On' : 'Ornaments Off (Kill Switch)'}
                </span>
              )}
              {can.isBrandingEdit && (
                <Button size="sm" onClick={() => { setEditing(null); setModalOpen(true); }}>
                  <Plus className="size-4 mr-1" /> Add Festival Window
                </Button>
              )}
            </div>
          </div>

          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '22%' }} />{/* Name */}
              <col style={{ width: '22%' }} />{/* Window */}
              <col style={{ width: '22%' }} />{/* Ornament */}
              <col style={{ width: '10%' }} />{/* Animated */}
              <col style={{ width: '10%' }} />{/* Status */}
              <col style={{ width: '14%' }} />{/* Actions */}
            </colgroup>
            <thead>
              <tr>
                <th className="!text-left whitespace-nowrap">Name</th>
                <th className="!text-left whitespace-nowrap">Window</th>
                <th className="!text-left whitespace-nowrap">Ornament</th>
                <th className="!text-center whitespace-nowrap">Animated</th>
                <th className="!text-center whitespace-nowrap">Status</th>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && variants.length === 0 && (
                <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">Loading&hellip;</td></tr>
              )}
              {!loading && variants.length === 0 && (
                <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">No festival windows scheduled yet.</td></tr>
              )}
              {variants.map((v) => (
                <tr key={v.id}>
                  <td className="!text-left truncate" title={v.name}>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="truncate font-medium">{v.name}</span>
                      {isLive(v, today) && (
                        <span className="text-xs rounded-full bg-success-tint text-success-strong px-1.5 py-0.5 shrink-0">Live</span>
                      )}
                    </span>
                  </td>
                  <td className="!text-left whitespace-nowrap text-muted-foreground">
                    {dateLabel(v.starts_on)} – {dateLabel(v.ends_on)}
                  </td>
                  {/* The mode is only meaningful once there IS an asset, so a
                    * window with no ornament shows no chip rather than an
                    * "Overlay" that describes nothing. */}
                  <td className="!text-left text-muted-foreground" title={v.ornament_key ?? 'None'}>
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate">
                        {builtInFestival(v.ornament_key)?.label ?? v.ornament_key ?? 'None'}
                      </span>
                      {v.ornament_key && (
                        <span className={`text-xs rounded-full px-1.5 py-0.5 shrink-0 ${
                          renderModeOf(v) === 'replace'
                            ? 'bg-info-tint text-info-strong'
                            : 'bg-neutral-tint text-neutral-strong'
                        }`}>
                          {renderModeOf(v) === 'replace' ? 'Replace' : 'Overlay'}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="!text-center whitespace-nowrap text-xs">
                    {isOn(v.animated)
                      ? <span className="text-foreground">Yes</span>
                      : <span className="text-muted-foreground">No</span>}
                  </td>
                  <td className="!text-center whitespace-nowrap text-xs">
                    {isOn(v.enabled)
                      ? <span className="text-success-strong">Active</span>
                      : <span className="text-muted-foreground">Disabled</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-0.5">
                      {can.isBrandingEdit && (
                        <IconButton
                          icon={Pencil}
                          label="Edit Festival Window"
                          intent="primary"
                          onClick={() => { setEditing(v); setModalOpen(true); }}
                        />
                      )}
                      {can.isBrandingEdit && isOn(v.enabled) && (
                        <IconButton
                          icon={XCircle}
                          label="Deactivate Festival Window"
                          intent="danger"
                          onClick={() => handleDisable(v)}
                        />
                      )}
                      {can.isBrandingEdit && !isOn(v.enabled) && (
                        <IconButton
                          icon={CheckCircle2}
                          label="Reactivate Festival Window"
                          intent="success"
                          onClick={() => handleReactivate(v)}
                        />
                      )}
                      {!can.isBrandingEdit && <span className="text-xs text-muted-foreground">view-only</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* ─── 3. Live Preview ──────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-base font-semibold">Live Preview</h2>
              <p className="text-sm text-muted-foreground">
                The selected window as the login page renders it &mdash; the ornament over the lockup
                at its anchor and scale, or the asset on its own in Replace Logo mode.
              </p>
            </div>
            <select
              value={effectivePreviewId}
              onChange={(e) => setPreviewId(e.target.value ? Number(e.target.value) : '')}
              className="border rounded h-9 px-2 text-sm bg-background"
              aria-label="Preview Festival Window"
            >
              <option value="">No Ornament</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>

          <LoginPreview
            ornamentUrl={previewOrnament.src}
            anchorX={previewVariant?.anchor_x ?? 50}
            anchorY={previewVariant?.anchor_y ?? 0}
            scale={previewVariant?.scale ?? 100}
            animated={isOn(previewVariant?.animated)}
            tagline={form?.loginTagline ?? ''}
            renderMode={renderModeOf(previewVariant)}
          />

          {/* Only reachable once the signing request has settled without producing
            * a URL — which now means something is genuinely wrong with the stored
            * key, not merely that this window is out of season. */}
          {previewVariant && previewVariant.ornament_key && !previewOrnament.src && (
            <p className="text-xs text-muted-foreground flex items-start gap-1.5">
              <Info className="size-3.5 shrink-0 text-info" />
              {previewOrnament.loading
                ? 'Fetching a signed preview link for this ornament…'
                : previewOrnament.error
                  ? `Could not sign a preview link — ${previewOrnament.error}`
                  : 'The stored ornament could not be loaded. Either the object is no longer in S3, or its key sits outside the Branding folder the preview is allowed to sign — re-upload the image to fix it.'}
            </p>
          )}
        </CardContent>
      </Card>

      <VariantFormModal
        open={modalOpen}
        editing={editing}
        canGenerateBrandArt={canGenerateBrandArt}
        tagline={form?.loginTagline ?? ''}
        existingOrnamentUrl={editingOrnament.src}
        existingOrnamentLoading={editingOrnament.loading}
        onClose={() => setModalOpen(false)}
        onSaved={(variantId, uploadedUrl) => {
          setModalOpen(false);
          if (variantId && uploadedUrl) {
            setSessionOrnaments((m) => ({ ...m, [variantId]: uploadedUrl }));
            setPreviewId(variantId);
          }
          refreshBranding();
        }}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Login preview — what the sign-in screen wears, in both render modes.
 *
 * OVERLAY. The `relative` wrapper is the logo box itself, so anchor 50/0 (the
 * create defaults) reads as "top-centre of the logo" exactly as it does on the
 * login page. Anchors outside 0–100 push the ornament off the box on purpose;
 * the surrounding card has enough padding that a modest bleed stays visible.
 *
 * REPLACE. The asset IS the logo, so the lockup is not rendered at all and the
 * ornament is NOT absolutely positioned — anchor and scale have no box to be
 * relative to, and applying them anyway would show the operator a placement the
 * login page will not reproduce. It is sized to the lockup's own height so the
 * swap stays comparable at a glance; that is the same normalisation the overlay
 * path uses, and for the same reason (the natural pixel size is unknowable
 * here). With no ornament resolved yet the card would otherwise be empty, so it
 * says so rather than rendering a lockup this mode does not use.
 * ═══════════════════════════════════════════════════════════════════════ */

function LoginPreview({ ornamentUrl, anchorX, anchorY, scale, animated, tagline, renderMode }: {
  ornamentUrl: string | null;
  anchorX: number;
  anchorY: number;
  scale: number;
  animated: boolean;
  tagline: string;
  renderMode: RenderMode;
}) {
  return (
    <div className="rounded-lg border bg-ink-50 px-6 py-10 flex flex-col items-center gap-3 overflow-hidden">
      {renderMode === 'replace' ? (
        ornamentUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={ornamentUrl}
            alt=""
            aria-hidden="true"
            className={`pointer-events-none w-auto max-w-full select-none ${animated ? 'animate-pulse' : ''}`}
            style={{ height: `${LOGO_PX}px` }}
          />
        ) : (
          <div
            className="flex items-center rounded-md border border-dashed border-input px-3 text-xs text-ink-500"
            style={{ height: `${LOGO_PX}px` }}
          >
            No ornament yet — in Replace Logo mode the uploaded asset is the whole logo.
          </div>
        )
      ) : (
        <div className="relative w-fit">
          <Logo variant="tagline" surface="light" height={LOGO_PX} />
          {ornamentUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={ornamentUrl}
              alt=""
              aria-hidden="true"
              className={`pointer-events-none absolute select-none ${animated ? 'animate-pulse' : ''}`}
              style={{
                left: `${anchorX}%`,
                top: `${anchorY}%`,
                height: `${(LOGO_PX * scale) / 100}px`,
                width: 'auto',
                transform: 'translate(-50%, -50%)',
              }}
            />
          )}
        </div>
      )}
      {tagline.trim()
        ? <p className="text-sm text-ink-700">{tagline}</p>
        : (
          /* Points at the field rather than merely reporting the absence: this
           * preview also renders INSIDE the variant modal, which covers the
           * Branding Settings card, so "not set" on its own reads as "there is
           * nowhere to set it". */
          <p className="text-xs text-ink-500">No tagline set — add one in Branding Settings above</p>
        )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Add / Edit modal
 * ═══════════════════════════════════════════════════════════════════════ */

type OrnamentSource = 'generate' | 'upload' | 'none';

function VariantFormModal({
  open, editing, canGenerateBrandArt, tagline,
  existingOrnamentUrl, existingOrnamentLoading, onClose, onSaved,
}: {
  open: boolean;
  editing: Variant | null;
  canGenerateBrandArt: boolean;
  tagline: string;
  /* Already resolved by the page — signed if it needed signing. Null means the
   * window has no ornament, or one that could not be signed. */
  existingOrnamentUrl: string | null;
  existingOrnamentLoading: boolean;
  onClose: () => void;
  onSaved: (variantId: number | null, uploadedUrl: string | null) => void;
}) {
  const isEdit = !!editing;

  const [name, setName] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [source, setSource] = useState<OrnamentSource>('none');
  const [renderMode, setRenderMode] = useState<RenderMode>('overlay');
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [anchorX, setAnchorX] = useState('50');
  const [anchorY, setAnchorY] = useState('0');
  const [scale, setScale] = useState('100');
  const [animated, setAnimated] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setStartsOn(dateValue(editing?.starts_on));
    setEndsOn(dateValue(editing?.ends_on));
    setAnchorX(String(editing?.anchor_x ?? 50));
    setAnchorY(String(editing?.anchor_y ?? 0));
    setScale(String(editing?.scale ?? 100));
    /* Defaults to 'overlay' on create AND for any pre-column row — see
     * renderModeOf(). */
    setRenderMode(renderModeOf(editing));
    setAnimated(editing ? isOn(editing.animated) : true);
    /* "No Change" is the safe landing state in both directions: on create it
     * means no ornament, on edit it means leave the stored key alone. */
    setSource('none');
    setFile(null);
    setError(null);
  }, [open, editing]);

  /* Object URLs must be revoked or the blob leaks for the tab's lifetime. */
  useEffect(() => {
    if (!file) { setFilePreview(null); return; }
    const url = URL.createObjectURL(file);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const previewUrl = source === 'upload' && filePreview ? filePreview
    : source === 'none' ? existingOrnamentUrl
    : null;

  /* Anchor/scale describe a position INSIDE the logo box. In Replace Logo mode
   * there is no logo box, so the three inputs are inert. */
  const geometryOff = renderMode === 'replace';

  async function handleSubmit() {
    setError(null);
    const trimmed = name.trim();
    if (trimmed.length < 2) { setError('Name must be at least 2 characters.'); return; }
    if (!startsOn || !endsOn) { setError('Both start and end dates are required.'); return; }
    if (endsOn < startsOn) { setError('End date must not be before the start date.'); return; }
    if (source === 'upload' && !file) { setError('Choose an image, or pick another ornament source.'); return; }

    /* Geometry is sent even in Replace Logo mode. It is inert there, but keeping
     * the stored values intact is what lets an operator flip back to Overlay and
     * find their placement still where they left it. */
    const placement = {
      anchor_x: numOr(anchorX, 50),
      anchor_y: numOr(anchorY, 0),
      scale: numOr(scale, 100),
      render_mode: renderMode,
      animated,
    };

    setSubmitting(true);
    try {
      let variantId = editing?.id ?? null;

      if (isEdit && variantId) {
        /* PATCH is partial. `ornament_key` is deliberately ABSENT — see the
         * "No Change" note in the page docblock. The upload below is what
         * changes the key on an edit. */
        await api.patch(`${BRANDING_KEY}/variants/${variantId}`, {
          name: trimmed, starts_on: startsOn, ends_on: endsOn, ...placement,
        });
      } else {
        const created = await api.post<Variant>(`${BRANDING_KEY}/variants`, {
          name: trimmed,
          starts_on: startsOn,
          ends_on: endsOn,
          /* Nothing to preserve on a brand-new row, so "No Change" is null. */
          ornament_key: null,
          ...placement,
          enabled: true,
        });
        variantId = created?.id ?? null;
      }

      /* The upload IS the save for the ornament — it writes the key onto the
       * row itself, which is why it can only run once the row exists. */
      let uploadedUrl: string | null = null;
      if (source === 'upload' && file && variantId) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await api.post<OrnamentUpload>(`${BRANDING_KEY}/variants/${variantId}/ornament`, fd);
        uploadedUrl = res?.url ?? null;
      }

      showToast({
        variant: 'success',
        message: isEdit ? 'Festival Window Updated' : 'Festival Window Created',
      });
      onSaved(variantId, uploadedUrl);
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 404
        ? 'That festival window no longer exists — close and reload the list.'
        : formatApiError(e, { fallback: 'Save failed' });
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.name}"` : 'Add Festival Window'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <Label className="block mb-1" required>Name</Label>
            <Input
              value={name}
              maxLength={NAME_MAX}
              placeholder='e.g. "Diwali 2026"'
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="block mb-1" required>Starts On</Label>
              <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
            </div>
            <div>
              <Label className="block mb-1" required>Ends On</Label>
              <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
            </div>
          </div>

          {/* ── Ornament source ── */}
          <div className="rounded-md border p-3 space-y-2">
            <Label className="block">Ornament Source</Label>

            {/*
              * Generate With AI is property-gated (canGenerateBrandArt →
              * branding.ai.emails). Flag off → the option does not render at
              * all. Flag on → it renders DISABLED, because the backend has no
              * generate route yet; offering a control that 404s is worse than
              * showing an honest "not configured" state.
              */}
            {canGenerateBrandArt && (
              <label className="flex items-start gap-2 text-sm opacity-60 cursor-not-allowed">
                <input
                  type="radio"
                  name="ornament-source"
                  className="mt-1"
                  disabled
                  checked={source === 'generate'}
                  onChange={() => setSource('generate')}
                />
                <span>
                  <span className="inline-flex items-center gap-1.5">
                    <Sparkles className="size-3.5 text-gold-strong" /> Generate With AI
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Not configured — no generator endpoint in this environment yet.
                  </span>
                </span>
              </label>
            )}

            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="ornament-source"
                className="mt-1"
                checked={source === 'upload'}
                onChange={() => setSource('upload')}
              />
              <span>
                <span className="inline-flex items-center gap-1.5">
                  <UploadCloud className="size-3.5 text-muted-foreground" /> Upload
                </span>
                <span className="block text-xs text-muted-foreground">
                  PNG, JPEG, WEBP or GIF, up to 10 MB. Saved as soon as the window is saved.
                </span>
              </span>
            </label>

            {source === 'upload' && (
              <div className="pl-6">
                <label className="flex items-center justify-center gap-2 h-9 rounded-md border border-dashed border-input bg-background px-3 text-sm cursor-pointer hover:bg-muted/40 transition-colors">
                  <UploadCloud className="size-4 text-muted-foreground" />
                  <span className="text-muted-foreground truncate">{file ? file.name : 'Select File'}</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
            )}

            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="ornament-source"
                className="mt-1"
                checked={source === 'none'}
                onChange={() => { setSource('none'); setFile(null); }}
              />
              <span>
                <span className="inline-flex items-center gap-1.5">
                  <Ban className="size-3.5 text-muted-foreground" /> No Change
                </span>
                <span className="block text-xs text-muted-foreground">
                  {isEdit
                    ? 'Keeps the ornament already stored on this window.'
                    : 'No ornament — the logo renders plain for this window.'}
                </span>
              </span>
            </label>
          </div>

          {/*
            * ── Ornament Placement ──
            *
            * Radios rather than a segmented control, to match the Ornament Source
            * group directly above it: two adjacent single-choice controls that
            * look different read as two different KINDS of control, and a
            * segmented control also has nowhere to put the one-line explanation
            * each option needs. Both options are always enabled — unlike the
            * disabled "Generate With AI" source, neither depends on a backend
            * capability that may be missing.
            */}
          <div className="rounded-md border p-3 space-y-2">
            <Label className="block">Ornament Placement</Label>

            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="ornament-render-mode"
                className="mt-1"
                checked={renderMode === 'overlay'}
                onChange={() => setRenderMode('overlay')}
              />
              <span>
                <span className="inline-flex items-center gap-1.5">
                  <Layers className="size-3.5 text-muted-foreground" /> Overlay On Logo
                </span>
                <span className="block text-xs text-muted-foreground">
                  The ornament is drawn over the EasyFix lockup, placed by the anchor and scale below.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="ornament-render-mode"
                className="mt-1"
                checked={renderMode === 'replace'}
                onChange={() => setRenderMode('replace')}
              />
              <span>
                <span className="inline-flex items-center gap-1.5">
                  <ImageIcon className="size-3.5 text-muted-foreground" /> Replace Logo
                </span>
                <span className="block text-xs text-muted-foreground">
                  The ornament stands alone as the whole logo — the EasyFix lockup is not drawn.
                </span>
              </span>
            </label>
          </div>

          {/* ── Geometry ──
            * DISABLED, not hidden, in Replace Logo mode: hiding three inputs
            * makes the dialog jump under the pointer every time the mode is
            * toggled. The values keep their state and are still submitted, so
            * flipping back to Overlay restores the placement rather than
            * silently resetting it to 50/0/100.
            */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="block mb-1">Anchor X (%)</Label>
              <Input type="number" step="0.01" min={-500} max={500} value={anchorX}
                disabled={geometryOff}
                onChange={(e) => setAnchorX(e.target.value)} />
            </div>
            <div>
              <Label className="block mb-1">Anchor Y (%)</Label>
              <Input type="number" step="0.01" min={-500} max={500} value={anchorY}
                disabled={geometryOff}
                onChange={(e) => setAnchorY(e.target.value)} />
            </div>
            <div>
              <Label className="block mb-1">Scale (%)</Label>
              <Input type="number" step="0.01" min={1} max={1000} value={scale}
                disabled={geometryOff}
                onChange={(e) => setScale(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {geometryOff
              ? 'Anchor and scale apply to Overlay On Logo only — a replacement logo has no lockup to be positioned against. Switch back to Overlay On Logo to edit them.'
              : 'Anchors are percentages of the logo box, measured from its top-left. Values outside 0–100 bleed the ornament off the edge on purpose.'}
          </p>

          <label className="flex items-center justify-between gap-3 rounded-md border p-3">
            <span>
              <span className="text-sm font-medium">Animated</span>
              <span className="block text-xs text-muted-foreground">
                Let the asset&rsquo;s own motion play on the login page.
              </span>
            </span>
            <Switch checked={animated} ariaLabel="Animated" onCheckedChange={setAnimated} />
          </label>

          {/* ── Preview ── */}
          <div>
            <Label className="block mb-1">Live Preview</Label>
            <LoginPreview
              ornamentUrl={previewUrl}
              anchorX={numOr(anchorX, 50)}
              anchorY={numOr(anchorY, 0)}
              scale={numOr(scale, 100)}
              animated={animated}
              tagline={tagline}
              renderMode={renderMode}
            />
            {source === 'none' && existingOrnamentLoading && (
              <p className="mt-1 text-xs text-muted-foreground">
                Loading the stored ornament&hellip;
              </p>
            )}
          </div>

          {error && (
            <div className="text-sm text-urgent flex items-start gap-1">
              <AlertTriangle className="size-4 shrink-0" /> {error}
            </div>
          )}

          {/*
            Pinned to the bottom of THIS scroller, not DialogContent's. The
            actions live inside the same `max-h-[70vh] overflow-y-auto` band as
            the fields, so DialogFooter's sticky footer never applied to them —
            the buttons simply scrolled off with the content. No negative
            margins here, so a plain `bottom-0` pins flush (measured: `-bottom-6`
            would hang the row 24px BELOW the scrollport and clip it).
          */}
          <div className="sticky bottom-0 z-10 flex justify-end gap-2 border-t bg-background pt-3 pb-1">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Festival Window'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
