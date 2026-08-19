'use client';

/*
 * ComposeWizard — two-step authoring flow for a notice, rendered as a
 * modal dialog (matches the rest of the CRM's modal pattern — Job
 * Modal, Confirm Dialog etc.).
 *
 * Open/close is driven by the parent. The All Notices list page
 * provides state-driven open for "+ New Notice" and per-row Edit; the
 * /notice-board/new and /notice-board/[id] page wrappers auto-open
 * the modal and navigate back to /notice-board on close.
 *
 * Step 1 (Compose) — title, message, category (with inline +Add),
 *   action link, audience surfaces (multi-select CRM / Client /
 *   Technician), expires, pin to top.
 *   Buttons: Cancel · Save as Draft · Review →
 *
 * Step 2 (Review & Send) — read-only summary of settings + a live
 *   preview of how the notice appears in the consuming surface.
 *   Buttons: ← Back · Schedule · Publish
 *     - "Schedule" reveals an inline datetime picker; confirming sets
 *       publish_at to that future moment and submits.
 *     - "Publish" submits immediately (publish_at = NOW).
 *   This replaces the older "Publish mode dropdown on Step 1" pattern
 *   — operator review changed 2026-05-22 so the publish decision lives
 *   at the moment of publishing, not at composition time.
 *
 * Edit mode hydrates from GET /admin/notices/:id, and the BE rejects
 * edits on published/archived rows — we mirror that by disabling the
 * form + showing a banner when status is locked.
 */

import * as React from 'react';
import {
  ArrowLeft, ArrowRight, Plus, Save, Send, Pin, AlertTriangle,
  Megaphone, CalendarClock, ImagePlus, X as XIcon, Loader2, Lock,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SearchSelect } from '@/components/ui/search-select';
import { useFetchOnce, useFetch, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { api } from '@/lib/api';
import { showToast, dismissToast } from '@/components/ui/toast';
import { NoticeCategoryTag } from './NoticeChip';
import { CategoryQuickAdd } from './CategoryQuickAdd';
import {
  parseSurfaces, SURFACE_OPTIONS,
  type Notice, type NoticeCategory, type NoticeSurface,
} from '@/lib/notice-types';

type CatResp = { items: NoticeCategory[] };

type Form = {
  title: string;
  body: string;
  category_id: number | '';
  target_surfaces: NoticeSurface[];
  action_url: string;
  /*
   * Image attachments — TWO parallel arrays (aligned by index).
   *
   *   image_keys — stored values (S3 keys / local paths). Sent to the
   *                BE on Save under `images:` in the payload. These
   *                are what survive across edit-load cycles.
   *   image_urls — the URL the <img> tag uses for preview. For S3-
   *                stored keys this is a presigned URL (5-min TTL);
   *                for local-disk values it's identical to the key.
   *
   * Both arrays stay in lockstep — upload appends to both; remove
   * filters both by the same index.
   */
  image_keys: string[];
  image_urls: string[];
  is_pinned: boolean;
  publish_at: string;       // local datetime-local (YYYY-MM-DDTHH:mm); '' when Publish Now
  expire_at: string;        // local datetime-local; '' when no expiry
  /*
   * The day the notice is ABOUT — a celebration, a maintenance window. Plain
   * date input ('YYYY-MM-DD'), NOT datetime-local: ops announce the day, and a
   * time field would force them to invent 00:00. Setting it also lists the
   * notice in the dashboard's Upcoming Events rail.
   */
  event_date: string;
  /* Push intent per app. Both only NARROW — the matching surface must also be
   * selected above for anything to send. */
  push_technician: boolean;
  push_client: boolean;
};

const EMPTY: Form = {
  title: '',
  body: '',
  category_id: '',
  target_surfaces: ['crm'],
  action_url: '',
  image_keys: [],
  image_urls: [],
  is_pinned: false,
  publish_at: '',
  expire_at: '',
  event_date: '',
  // Matches the BE default: publishing to the technician surface has always
  // pushed, so the box starts checked and ops opts OUT rather than in.
  push_technician: true,
  push_client: false,
};

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;  // matches BE multer limit

/* datetime-local string → ISO. Empty/invalid → null. */
function toBeDate(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/* ISO → datetime-local string (server tz → local tz). Empty/invalid → ''. */
function fromBeDate(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const tzOffsetMin = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tzOffsetMin * 60_000);
  return local.toISOString().slice(0, 16);
}

export function ComposeWizard({
  open, onClose, mode, noticeId, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  noticeId?: number;
  /*
   * Fired after a successful save. invalidateFetch below clears the module
   * cache but never reaches a MOUNTED useFetch, so the list behind this modal
   * kept its pre-save rows until a page reload. The owner wires this to refetch.
   */
  onSaved?: () => void;
}) {
  const { me } = useMe();
  const canManage = hasAction(me, 'isNoticeManage');

  const catsFetch = useFetchOnce<CatResp>('/admin/notice-categories');
  const existingFetch = useFetch<{ success: boolean; data: Notice } | Notice>(
    mode === 'edit' && noticeId && open ? `/admin/notices/${noticeId}` : null,
  );
  // API helper returns the parsed envelope or the unwrapped data depending
  // on whether the request layer auto-unwraps. Guard both shapes.
  const existing: Notice | null = React.useMemo(() => {
    const d = existingFetch.data as unknown;
    if (!d) return null;
    if ((d as { data?: Notice }).data) return (d as { data: Notice }).data;
    return d as Notice;
  }, [existingFetch.data]);

  const [step, setStep] = React.useState<1 | 2>(1);
  const [form, setForm] = React.useState<Form>(EMPTY);
  const [showCatAdd, setShowCatAdd] = React.useState(false);
  const [showSchedulePanel, setShowSchedulePanel] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  // Number of image uploads currently in-flight. Disables the file
  // input + the wizard Next/Publish buttons while > 0 so we never
  // submit a payload that's missing an in-progress URL.
  const [uploadingCount, setUploadingCount] = React.useState(0);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // Reset on open. Without this, navigating from Edit → close → New
  // would leak the previous notice's state into the fresh form.
  React.useEffect(() => {
    if (open) {
      setStep(1);
      setForm(EMPTY);
      setShowSchedulePanel(false);
    }
  }, [open]);

  // Hydrate from existing notice on edit
  React.useEffect(() => {
    if (mode !== 'edit' || !existing) return;
    setForm({
      title: existing.title || '',
      body: existing.body || '',
      category_id: existing.category_id,
      target_surfaces: parseSurfaces(existing.target_surfaces),
      action_url: existing.action_url || '',
      // Pull both parallel arrays — keys for round-trip, URLs for preview.
      // Defaults to empty arrays if the BE response shape predates the
      // 2-array contract (i.e. images present but image_keys missing).
      image_keys: Array.isArray(existing.image_keys)
        ? existing.image_keys
        : (Array.isArray(existing.images) ? existing.images : []),
      image_urls: Array.isArray(existing.images) ? existing.images : [],
      is_pinned: Boolean(existing.is_pinned),
      publish_at: fromBeDate(existing.publish_at),
      expire_at: fromBeDate(existing.expire_at),
      // DATE column — slice to YYYY-MM-DD. The BE may hand back a full
      // datetime/ISO string depending on driver settings, and feeding that to a
      // <input type="date"> silently blanks it.
      event_date: existing.event_date ? String(existing.event_date).slice(0, 10) : '',
      // Absent (pre-migration row) reads as TRUE for technician — same
      // back-compat rule the BE applies — and FALSE for client.
      push_technician: existing.push_technician == null ? true : Boolean(existing.push_technician),
      push_client: Boolean(existing.push_client),
    });
  }, [mode, existing]);

  const locked = mode === 'edit'
    && existing
    && (existing.status === 'published' || existing.status === 'archived');

  function update<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleSurface(s: NoticeSurface) {
    setForm((f) => ({
      ...f,
      target_surfaces: f.target_surfaces.includes(s)
        ? f.target_surfaces.filter((x) => x !== s)
        : [...f.target_surfaces, s],
    }));
  }

  /*
   * Image upload — fires one POST /shared/upload per picked file.
   * Files queue sequentially via Promise.all on the picked list so a
   * 5-file pick doesn't stall on a single slow upload.
   *
   * Storage strategy: we use the 'general' file-storage category
   * (mounted at /easydoc/<filename>). Notice images don't need their
   * own category — the existing CATEGORIES allowlist on the BE
   * doesn't include 'notice_images' and adding it would require an
   * env-var + Nginx mapping change. 'general' works today and the
   * filenames are already unique-by-construction (timestamp + random
   * suffix) so cross-feature collisions aren't a concern.
   *
   * Errors surface as a toast; the file is just dropped (no half-
   * uploaded URL leaks into form.images).
   */
  async function handleImagePick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    // Respect MAX_IMAGES — total = already-in-form + newly picked.
    const available = MAX_IMAGES - form.image_keys.length;
    if (available <= 0) {
      showToast({ variant: 'error', message: `Maximum ${MAX_IMAGES} images allowed` });
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    const toUpload = picked.slice(0, available);
    if (picked.length > available) {
      showToast({
        variant: 'error',
        message: `Only ${available} of ${picked.length} added (cap is ${MAX_IMAGES})`,
      });
    }

    setUploadingCount((c) => c + toUpload.length);
    // Two parallel arrays — keys + presigned URLs, kept in lockstep
    // by always appending to both at the same index.
    const uploaded: Array<{ key: string; url: string }> = [];

    await Promise.all(toUpload.map(async (file) => {
      try {
        if (file.size > MAX_IMAGE_BYTES) {
          throw new Error(`${file.name} exceeds 10MB`);
        }
        if (!file.type.startsWith('image/')) {
          throw new Error(`${file.name} is not an image`);
        }
        const fd = new FormData();
        fd.append('file', file);
        // New endpoint (2026-05-22) — uploads to S3 under Notices/
        // when configured, local-disk fallback otherwise. Returns
        // { key, url } where url is presigned (5-min TTL) for the
        // immediate preview and key is what we round-trip on Save.
        const res = await api.post<
          { success: boolean; data: { key: string; url: string } } | { key: string; url: string }
        >('/admin/notices/upload-image', fd);
        const data = (res as { data?: { key: string; url: string } })?.data
                  ?? (res as { key?: string; url?: string });
        const key = data?.key;
        const url = data?.url;
        if (!key || !url) throw new Error(`upload returned no key/url for ${file.name}`);
        uploaded.push({ key, url });
      } catch (e) {
        showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Upload failed' });
      } finally {
        setUploadingCount((c) => c - 1);
      }
    }));

    if (uploaded.length) {
      setForm((f) => ({
        ...f,
        image_keys: [...f.image_keys, ...uploaded.map((u) => u.key)],
        image_urls: [...f.image_urls, ...uploaded.map((u) => u.url)],
      }));
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeImage(idx: number) {
    setForm((f) => ({
      ...f,
      // Filter BOTH arrays by the same index to keep them aligned.
      image_keys: f.image_keys.filter((_, i) => i !== idx),
      image_urls: f.image_urls.filter((_, i) => i !== idx),
    }));
    // We intentionally don't DELETE the underlying object from S3 —
    // a draft could recover the URL on a back-and-forth, and orphaned
    // objects are cheap. A lifecycle rule on the Notices/ prefix can
    // sweep older-than-N-days un-referenced objects later if storage
    // hygiene matters.
  }

  function validateStep1(): string | null {
    if (!form.title.trim())                       return 'Title is required';
    if (!form.body.trim())                        return 'Message is required';
    if (!form.category_id)                        return 'Category is required';
    if (form.target_surfaces.length === 0)        return 'Pick at least one audience surface';
    if (form.expire_at && form.publish_at) {
      const p = new Date(form.publish_at).getTime();
      const e = new Date(form.expire_at).getTime();
      if (!(p < e)) return 'Expire date must be after the publish date';
    }
    return null;
  }

  // Build the payload for create or update. `publishWhen` controls the
  // status_intent:
  //   - 'draft'    → status_intent='draft', publish_at ignored
  //   - 'now'      → status_intent='publish', publish_at=null (BE sets NOW)
  //   - 'schedule' → status_intent='publish', publish_at=form.publish_at
  function buildPayload(publishWhen: 'draft' | 'now' | 'schedule') {
    const publishAt =
        publishWhen === 'draft'     ? null
      : publishWhen === 'now'       ? null
      : /* schedule */                toBeDate(form.publish_at);
    return {
      title:           form.title.trim(),
      body:            form.body.trim(),
      category_id:     Number(form.category_id),
      target_surfaces: form.target_surfaces.join(','),
      audience_scope:  'all' as const,
      action_url:      form.action_url.trim() || null,
      // Send KEYS, not presigned URLs. The BE normalises either, but
      // sending keys avoids any "what if the signature expired between
      // load and save" edge case.
      images:          form.image_keys,
      is_pinned:       form.is_pinned,
      publish_at:      publishAt,
      expire_at:       toBeDate(form.expire_at),
      // Date-only; '' must become null so the BE writes SQL NULL rather than
      // MySQL's zero-date. NOT run through toBeDate — that produces a datetime.
      event_date:      form.event_date || null,
      // Push intent is only meaningful for a surface that is actually targeted;
      // sending false for an untargeted surface keeps the stored row honest.
      push_technician: form.push_technician && form.target_surfaces.includes('technician'),
      push_client:     form.push_client && form.target_surfaces.includes('client'),
      status_intent:   publishWhen === 'draft' ? 'draft' : 'publish',
    };
  }

  async function handleSave(publishWhen: 'draft' | 'now' | 'schedule') {
    if (publishWhen === 'schedule' && !form.publish_at) {
      showToast({ variant: 'error', message: 'Pick a publish date and time to schedule' });
      return;
    }
    if (publishWhen === 'schedule') {
      const pubMs = new Date(form.publish_at).getTime();
      if (!Number.isFinite(pubMs) || pubMs <= Date.now()) {
        showToast({ variant: 'error', message: 'Schedule must be a future date and time' });
        return;
      }
    }

    const err = validateStep1();
    if (err) { showToast({ variant: 'error', message: err }); return; }

    setSubmitting(true);
    const labels = {
      draft:    { loading: 'Saving draft…',     success: 'Draft saved' },
      now:      { loading: 'Publishing notice…', success: 'Notice published' },
      schedule: { loading: 'Scheduling notice…', success: 'Notice scheduled' },
    } as const;
    const toastId = showToast({ variant: 'loading', message: labels[publishWhen].loading });
    try {
      if (mode === 'create') {
        await api.post('/admin/notices', buildPayload(publishWhen));
      } else if (mode === 'edit' && noticeId) {
        // Edit doesn't take status_intent; PATCH the field edits first,
        // then call /publish if the operator chose publish/schedule.
        const patchBody: Record<string, unknown> = buildPayload(publishWhen);
        delete patchBody.status_intent;
        await api.patch(`/admin/notices/${noticeId}`, patchBody);
        if (publishWhen !== 'draft') {
          await api.post(`/admin/notices/${noticeId}/publish`, {
            publish_at: publishWhen === 'schedule' ? toBeDate(form.publish_at) : null,
            expire_at:  toBeDate(form.expire_at),
          });
        }
      }
      dismissToast(toastId);
      showToast({ variant: 'success', message: labels[publishWhen].success });
      invalidateFetch((k) => k.startsWith('/admin/notices'));
      onSaved?.();
      onClose();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Save failed' });
    } finally {
      setSubmitting(false);
    }
  }

  // Guard: closing the dialog mid-submission could orphan a request.
  // We allow close while NOT submitting; otherwise we ignore the
  // outside-click / Esc.
  function handleOpenChange(o: boolean) {
    if (!o && !submitting) onClose();
  }

  if (!canManage) {
    // Defence in depth — list-page route guard already blocks access,
    // but if some other surface mounts this dialog without checking
    // we shouldn't render compose controls.
    return null;
  }

  const selectedCat = (catsFetch.data?.items ?? []).find((c) => c.category_id === form.category_id);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4" />
            {mode === 'create' ? 'New Notice' : `Edit Notice #${noticeId}`}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex items-center gap-2 pt-1 text-xs">
              <span className={`px-2 py-0.5 rounded-full ${step === 1 ? 'bg-info text-white' : 'bg-success-tint text-success-strong'}`}>
                1. Compose
              </span>
              <span className="h-px w-6 bg-ink-500/40" />
              <span className={`px-2 py-0.5 rounded-full ${step === 2 ? 'bg-info text-white' : 'bg-ink-700/40 text-ink-100/80'}`}>
                2. Review &amp; Send
              </span>
            </div>
          </DialogDescription>
        </DialogHeader>

        {locked && (
          <div className="mx-6 mt-3 rounded-md p-3 flex items-center gap-2 text-sm text-warning-strong bg-warning-tint border border-warning">
            <AlertTriangle className="size-4" />
            This notice is {existing!.status}. Published or archived notices cannot be edited — archive and recreate to make changes.
          </div>
        )}

        {step === 1 && (
          /* space-y-3 (was -4): with eight stacked fields the looser rhythm
             pushed the footer below the fold and read as gappy. */
          <div className="px-6 py-4 space-y-3">
            {/* Title + Pin share a row: Pin is a property OF the title/notice
                and needs far less width than a full-bleed row gave it. */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <Label htmlFor="title">Title <span className="text-urgent">*</span></Label>
                <Input
                  id="title"
                  value={form.title}
                  onChange={(e) => update('title', e.target.value)}
                  placeholder="e.g. Festive bonus is live"
                  maxLength={255}
                  disabled={!!locked}
                />
              </div>
              {/* mt-[1.625rem] on sm+ aligns the pill with the INPUT rather than
                  the Label above it, so the two controls sit on one baseline.
                  The helper text is nowrap + the pill is sized to fit it, so the
                  label never wraps onto a second line and the block stays the
                  same height as the input beside it. */}
              <div className="flex h-9 shrink-0 items-center justify-between gap-3 rounded-md bg-muted/30 px-3 sm:mt-[1.625rem]">
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <Pin className="h-4 w-4 shrink-0 text-warning" />
                  <Label htmlFor="is_pinned" className="cursor-pointer">Pin to Top</Label>
                  <span className="text-xs text-muted-foreground">Keeps it above others</span>
                </div>
                <Switch
                  id="is_pinned"
                  checked={form.is_pinned}
                  onCheckedChange={(v: boolean) => update('is_pinned', v)}
                  disabled={!!locked}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="body">Message <span className="text-urgent">*</span></Label>
              <textarea
                id="body"
                value={form.body}
                onChange={(e) => update('body', e.target.value)}
                placeholder="Earn ₹200 extra for every 5 jobs completed this week. Runs till Sunday 11:59 PM."
                rows={5}
                disabled={!!locked}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Both columns open with a fixed-height label row so the two
                  inputs share a baseline. Without it the "Add Category" action
                  made this column's header taller and pushed its select a row
                  below the Action Link input. */}
              <div>
                <div className="flex h-6 items-center justify-between">
                  <Label htmlFor="category_id">Category <span className="text-urgent">*</span></Label>
                  <button
                    type="button"
                    onClick={() => setShowCatAdd(true)}
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                    disabled={!!locked}
                  >
                    <Plus className="h-3 w-3" /> Add Category
                  </button>
                </div>
                {/* Shared SearchSelect — type-to-filter, same control the rest of
                    the CRM uses for long pick-lists. Categories grow over time
                    and a bare <select> gets unusable. */}
                <SearchSelect
                  value={form.category_id}
                  onChange={(v) => update('category_id', v ? Number(v) : '')}
                  options={(catsFetch.data?.items ?? []).map((c) => ({
                    value: c.category_id,
                    label: c.name,
                  }))}
                  placeholder="Pick a category…"
                  disabled={!!locked}
                />
                {selectedCat && (
                  <div className="pt-1">
                    <NoticeCategoryTag name={selectedCat.name} color={selectedCat.color} />
                  </div>
                )}
              </div>

              <div>
                <div className="flex h-6 items-center">
                  <Label htmlFor="action_url">Action Link</Label>
                </div>
                <Input
                  id="action_url"
                  value={form.action_url}
                  onChange={(e) => update('action_url', e.target.value)}
                  placeholder="https://…"
                  type="url"
                  disabled={!!locked}
                />
              </div>
            </div>

            <div>
              <Label>Audience Surfaces</Label>
              <div className="flex flex-wrap gap-2 pt-1">
                {SURFACE_OPTIONS.map((s) => {
                  const active = form.target_surfaces.includes(s.key);
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => toggleSurface(s.key)}
                      disabled={!!locked}
                      className={`rounded-full border px-3 py-1 text-sm transition-colors disabled:opacity-50 ${active ? 'bg-primary border-brand-600 text-white' : 'bg-background border-input hover:bg-muted'}`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground pt-1">
                Pick where this notice should appear. v1 broadcasts to everyone within each picked surface.
              </p>
            </div>

            {/*
              * Push notification opt-in. Only shown for surfaces the notice
              * actually targets — a push checkbox for an untargeted app is a
              * promise the publish path will not keep.
              */}
            {(form.target_surfaces.includes('technician') || form.target_surfaces.includes('client')) && (
              <div>
                <Label>Send Push Notification</Label>
                <div className="flex flex-col gap-2 pt-1.5">
                  {form.target_surfaces.includes('technician') && (
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.push_technician}
                        disabled={!!locked}
                        onChange={(e) => setForm((f) => ({ ...f, push_technician: e.target.checked }))}
                        className="mt-0.5 h-4 w-4 rounded border-input accent-primary disabled:opacity-50"
                      />
                      <span>
                        Technician App
                        <span className="block text-xs text-muted-foreground">
                          Sends on publish to every active, verified technician. Tapping it opens
                          the app&apos;s Notices screen (older app builds open the home screen).
                        </span>
                      </span>
                    </label>
                  )}
                  {/*
                    * Client App push is a DISABLED chip, not a checkbox: it
                    * cannot be delivered today. The Client App registers a
                    * locally-generated UUID as its "device id", not an FCM
                    * token, and ships no Firebase Messaging — so a checked box
                    * would promise a notification that never arrives. Kept
                    * visible (rather than hidden) so the capability is
                    * discoverable and the column/flag are already wired for the
                    * day the app adds push. Reason shows on hover.
                    */}
                  {form.target_surfaces.includes('client') && (
                    <span
                      className="inline-flex w-fit cursor-not-allowed items-center gap-1.5 rounded-full border border-dashed border-warning bg-warning-tint px-3 py-1 text-xs font-medium text-warning-strong"
                      title={
                        'Client App push is not available yet — the Client App does not register '
                        + 'push tokens, so nothing can be delivered to it. The notice still reaches '
                        + 'clients in the app’s in-app Notice Board. This unlocks once the app '
                        + 'ships push support.'
                      }
                    >
                      <Lock className="h-3 w-3" />
                      Client App — push unavailable
                    </span>
                  )}
                </div>
              </div>
            )}

            {/*
             * Image attachments — multi-file picker with inline preview.
             * Uploads fire on pick (no separate "Upload" button) so the
             * UX matches operator expectation of "click → see thumbnail".
             * Each tile has its own remove × button. Disabled while
             * locked (edit-on-published) or while uploads in-flight.
             */}
            <div>
              <div className="flex items-center justify-between">
                <Label>Images <span className="text-muted-foreground text-xs">(up to {MAX_IMAGES})</span></Label>
                {uploadingCount > 0 && (
                  <span className="text-xs text-info-strong flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> Uploading {uploadingCount}…
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {/* Thumbnails render from image_urls (presigned, for
                    direct rendering); the row identifier is the key
                    so React's reconciler stays stable when a
                    signature refreshes mid-session. */}
                {form.image_urls.map((url, i) => (
                  <div key={form.image_keys[i] ?? `${url}-${i}`} className="relative h-20 w-20 rounded border bg-muted overflow-hidden group">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt={`Attachment ${i + 1}`} className="h-full w-full object-cover" />
                    {!locked && (
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        className="absolute top-0.5 right-0.5 rounded-full bg-black/60 text-white p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label="Remove image"
                      >
                        <XIcon className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
                {!locked && form.image_keys.length < MAX_IMAGES && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingCount > 0}
                    className="h-20 w-20 rounded border-2 border-dashed border-input flex flex-col items-center justify-center text-muted-foreground hover:border-foreground/40 hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    <ImagePlus className="h-5 w-5" />
                    <span className="text-xs mt-0.5">Add</span>
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => handleImagePick(e.target.files)}
                  className="hidden"
                />
              </div>
            </div>

            {/* Both date pickers on one row — they are the same kind of control
                and reading them side by side makes the distinction obvious:
                Expires is when the notice STOPS showing, Event Date is the day
                it is ABOUT. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="expire_at">Expires</Label>
                <Input
                  id="expire_at"
                  type="datetime-local"
                  value={form.expire_at}
                  onChange={(e) => update('expire_at', e.target.value)}
                  disabled={!!locked}
                />
                <p className="text-xs text-muted-foreground pt-1">
                  Notice auto-hides after this date. Leave blank for no expiry.
                </p>
              </div>
              {/*
                * Event date — the day the notice is ABOUT, which is NOT the same
                * as when it publishes or expires. Filling it promotes the notice
                * into the dashboard's Upcoming Events rail. Explicit rather than
                * parsed out of the title: "Friday, 14th August" carries no year,
                * and a wrong guess would put an event on the wrong day in a rail
                * ops plan around.
                */}
              <div>
                <Label htmlFor="event_date">Event Date</Label>
                <Input
                  id="event_date"
                  type="date"
                  value={form.event_date}
                  onChange={(e) => update('event_date', e.target.value)}
                  disabled={!!locked}
                />
                <p className="text-xs text-muted-foreground pt-1">
                  Set this when the notice is about a specific day — it then also
                  appears in the dashboard&apos;s Upcoming Events.
                </p>
              </div>
            </div>

            {/* Step 1 footer */}
            <div className="flex items-center justify-between pt-2 border-t mt-4 -mx-6 px-6 pt-4">
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleSave('draft')}
                  disabled={submitting || !!locked || uploadingCount > 0}
                  title={uploadingCount > 0 ? 'Wait for image uploads to finish' : ''}
                >
                  <Save className="size-4 mr-1" /> Save As Draft
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    const err = validateStep1();
                    if (err) { showToast({ variant: 'error', message: err }); return; }
                    setStep(2);
                  }}
                  disabled={submitting || !!locked || uploadingCount > 0}
                  title={uploadingCount > 0 ? 'Wait for image uploads to finish' : ''}
                >
                  Review <ArrowRight className="size-4 ml-1" />
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
            {/* Settings summary */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Review Settings</h3>
              <dl className="text-sm divide-y border rounded-md">
                <DlRow label="Title"      value={form.title} />
                <DlRow label="Category"   value={selectedCat ? <NoticeCategoryTag name={selectedCat.name} color={selectedCat.color} /> : '—'} />
                <DlRow label="Audience"   value={form.target_surfaces.map((s) => SURFACE_OPTIONS.find((o) => o.key === s)?.label).join(', ')} />
                <DlRow label="Expires"    value={form.expire_at ? new Date(form.expire_at).toLocaleString('en-IN') : 'No expiry'} />
                <DlRow label="Pinned"     value={form.is_pinned ? 'Yes' : 'No'} />
                {form.action_url && <DlRow label="Action Link" value={form.action_url} />}
              </dl>
            </div>

            {/* Live preview */}
            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">
                Preview
              </h3>
              <div className="rounded-md border bg-background p-3 space-y-2 shadow-sm">
                {selectedCat && <NoticeCategoryTag name={selectedCat.name} color={selectedCat.color} />}
                <div className="font-semibold text-sm">{form.title || '(Title preview)'}</div>
                <div className="text-xs text-muted-foreground whitespace-pre-line">
                  {form.body || '(Message preview)'}
                </div>
                {form.action_url && (
                  <div className="text-xs text-info-strong truncate">{form.action_url}</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/*
         * Step 2 footer — stepped publish.
         *   Schedule: clicking shows an inline datetime panel; the
         *     Confirm button submits with the chosen future date.
         *     Lets ops pick a date without leaving the modal.
         *   Publish:  submits immediately with publish_at=NOW (server-side).
         *
         * Both buttons share submit-pending state to prevent double-
         * clicks while the BE round-trips.
         */}
        {step === 2 && (
          <div className="px-6 pb-4 -mt-1">
            {showSchedulePanel && (
              <div className="rounded-md border border-info bg-info-tint p-3 mb-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-info-strong">
                  <CalendarClock className="h-4 w-4" /> Schedule For Future Publish
                </div>
                <Input
                  type="datetime-local"
                  value={form.publish_at}
                  onChange={(e) => update('publish_at', e.target.value)}
                  min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                />
                <div className="flex items-center justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => { update('publish_at', ''); setShowSchedulePanel(false); }}
                    disabled={submitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleSave('schedule')}
                    disabled={submitting || !form.publish_at}
                  >
                    Confirm Schedule
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between border-t pt-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => { setStep(1); setShowSchedulePanel(false); }}
                disabled={submitting}
              >
                <ArrowLeft className="size-4 mr-1" /> Back
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowSchedulePanel((v) => !v)}
                  disabled={submitting || !!locked}
                >
                  <CalendarClock className="size-4 mr-1" /> Schedule
                </Button>
                <Button
                  type="button"
                  onClick={() => handleSave('now')}
                  disabled={submitting || !!locked}
                >
                  <Send className="size-4 mr-1" /> Publish
                </Button>
              </div>
            </div>
          </div>
        )}

        <CategoryQuickAdd
          open={showCatAdd}
          onClose={() => setShowCatAdd(false)}
          onAdded={(c) => update('category_id', c.category_id)}
        />
      </DialogContent>
    </Dialog>
  );
}

function DlRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 px-3">
      <dt className="text-muted-foreground text-xs uppercase tracking-wide">{label}</dt>
      <dd className="text-sm text-right max-w-[60%] truncate">{value || '—'}</dd>
    </div>
  );
}
