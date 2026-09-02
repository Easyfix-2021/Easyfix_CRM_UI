'use client';

/*
 * Manage Users — Settings page.
 *
 * Lists internal CRM staff (tbl_user where user_type_id = 5). Operates on
 * /api/admin/users (services/user.service.js). Columns:
 *   Photo | User ID | Employee Code | Name | Email | Personal Email | Mobile |
 *   Role | Regions | Job Stages | Status | Actions.
 *
 * Soft-delete only — tbl_user rows are referenced by tbl_job audit columns
 * and historical assignments. Deactivation flips user_status to 0; the row
 * stays. Reactivation toggles it back via the edit modal.
 *
 * Auth model note (carried over from legacy CRM): tbl_user has no password
 * column. Login is OTP-only (email or mobile). This form therefore has no
 * password field — the create form is just identity + role + city.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { invalidateFetch, useDebouncedValue, useFetch } from '@/lib/hooks';
import { EMP_CODE_PREFIX, formatEmpCode, padEmpCount, parseEmpCodeCount, sanitiseEmpCount } from '@/lib/emp-code';
import { INDIAN_MOBILE_REGEX, INDIAN_MOBILE_ERROR } from '@/lib/format';
import {
  UserCog, Users, Search, Plus, Pencil, Trash2, MailWarning,
  AlertTriangle, ChevronDown, ChevronRight, Info, Layers, KeyRound,
} from 'lucide-react';
import { BulkUpdateUsersDialog } from '@/components/users/BulkUpdateUsersDialog';
/*
 * The CRM's one image lightbox — a `{ url, name }` panel with a title bar and
 * the standard guarded close. Its NAME says skill because that was its first
 * caller; nothing in it is skill-specific, and a second hand-rolled zoom Dialog
 * on this page would be the fourth in the repo. Reused rather than copied.
 */
import { SkillImageLightbox } from '@/components/easyfixer/SkillImageLightbox';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { CitySelect } from '@/components/ui/city-select';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { SortHeader, cycleSort } from '@/lib/use-sort';
import { Switch } from '@/components/ui/switch';
import { useCancelConfirm } from '@/lib/use-cancel-confirm';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useLookup } from '@/lib/use-lookup';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { STAGE_OPTIONS, STAGES } from '@/lib/job-stages';

type User = {
  user_id: number;
  user_code: string | null;
  user_name: string;
  official_email: string;
  /*
   * Personal (non-company) email. Lives in the EasyFix-owned side table
   * tbl_user_personal_contact, NOT on tbl_user — that table is legacy and
   * shared by five services, so it must not gain columns.
   *
   * Optional on the type, and genuinely absent in two normal cases:
   *   - the caller is an admin-GROUP role other than Admin. Only Admin can
   *     create or edit a user, so only Admin gets the address on the LIST
   *     projection; the other nine roles would otherwise be able to page out
   *     the home address of every member of staff with no feature to use it
   *     for. The column simply reads "—" for them.
   *   - the user predates the field (or the backend has not run the migration).
   * Either way the "—" placeholder renders and nothing crashes.
   */
  personal_email?: string | null;
  /*
   * HR master data, present ONLY on the detail response (GET /admin/users/:id)
   * and only for the Admin role — never on the list projection. Optional here
   * because the list rows genuinely lack them.
   *
   * pan and aadhaar appear as MASKED strings and there is no unmasked variant
   * on this type on purpose: nothing in the CRM has a use for the full value,
   * so nothing should be able to hold one.
   */
  date_of_joining?: string | null;
  uan?: string | null;
  address?: string | null;
  pan_masked?: string | null;
  aadhaar_masked?: string | null;
  mobile_no: string;
  alternate_no: string | null;
  user_role: number | null;
  role_name: string | null;
  city_id: number | null;
  city_name: string | null;
  manage_clients: string | null;
  manage_cities: string | null;
  manage_states: string | null;
  manage_verticals: string | null;
  reporting_manager: number | null;
  user_status: number;
  insert_date: string | null;
  update_date: string | null;
  /*
   * Job Stage Access — the user's allowed lifecycle stages (STAGE_KEYS from
   * lib/job-stages.ts). Returned by BOTH the list endpoint (batched, one query
   * per page) and the GET user detail endpoint. NULL / absent = unrestricted
   * (all stages); [] = explicit no access; non-empty = restricted to those keys.
   */
  allowed_stages?: string[] | null;
  /*
   * Profile photo — a PRESIGNED S3 URL, not a key, so a plain <img src> loads
   * it with no auth header (the navbar's identity block does exactly this).
   * Optional because it is short-lived and only present for users who have
   * actually uploaded one: most rows carry null and render the monogram
   * instead. Presigned means expiring, which is why <UserAvatar> also handles
   * a URL that 404s rather than assuming "present" means "loadable".
   */
  photo_url?: string | null;
};

type ListResponse = { items: User[]; total: number };

// Must mirror SORTABLE_COLUMNS in services/user.service.js.
/*
 * POST /admin/users response — the new user PLUS the Microsoft 365 mailbox
 * outcome. The two are independent: `accountStatus:'created'` with
 * `licenceStatus:'no_seats_available'` is an Entra account with NO mailbox, so
 * `mailboxReady` (not accountStatus) is the field that answers "can this person
 * receive email?". All fields optional — an older backend, or the feature
 * switched off, simply omits them.
 */
/*
 * Outcome of the sign-in-details email sent to the new user's PERSONAL address
 * (CC'd to the ops mailbox resolved from easyfix_properties).
 *
 * Mirrors MAIL_STATUS in services/user-welcome-mail.service.js:
 *   'sent'    → Graph accepted it for delivery.
 *   'skipped' → deliberately NOT sent, `reason` says why. The main case is a
 *               mailbox that never provisioned: mailing "here are your Outlook
 *               credentials" for an account with no mailbox is actively
 *               misleading, so the send is suppressed by design. Also covers
 *               NOTIFICATIONS_DISABLE on a QA host.
 *   'failed'  → we tried and it did not go out. THIS is the one that needs a
 *               human: the account and mailbox are fine, but nobody has been
 *               told the password.
 *   'pending' → provisioning outran the inline deadline and is still running,
 *               so the mail decision hasn't been made yet.
 *
 * The service never puts the temporary password on this object — it is not a
 * field here, and must never become one: this outcome rides back on the HTTP
 * create response, so anything on it is published to the browser.
 */
type MailOutcome = {
  status?: 'sent' | 'skipped' | 'failed' | 'pending';
  /** Operator-facing explanation, e.g. the Graph sendMail error. */
  reason?: string;
};

type CreatedUser = {
  user_id?: number;
  provisioning?: {
    attempted?: boolean;
    /** Finished BOTH steps — the only value that means a usable mailbox. */
    mailboxReady?: boolean;
    /** Outran the inline deadline and is completing in the background. */
    pending?: boolean;
    /** Operator-facing explanation, e.g. the "no free seats (67/67 used)" text. */
    reason?: string;
    accountStatus?: string;
    licenceStatus?: string;
  };
  /*
   * The credential-mail outcome, sibling of `provisioning`.
   *
   * ⚠ THE KEY IS `welcome_mail` — snake_case, like every other field on this
   * payload. The backend attaches it as `row.welcome_mail`
   * (services/user.service.js) and its route reads `created.welcome_mail`
   * (routes/admin/users.js); this file previously read only camelCase aliases,
   * so the lookup ALWAYS returned undefined and a FAILED send fell through to
   * the plain green "User Created" toast — the account and mailbox existed, the
   * password had been minted and discarded, and nobody was told. That is the
   * precise regression these aliases were meant to prevent, so the real key now
   * leads and the aliases stay behind it as the cheap backstop they were
   * intended to be.
   */
  welcome_mail?: MailOutcome;
  welcomeMail?: MailOutcome;
  credentialMail?: MailOutcome;
  mail?: MailOutcome;
};

/** First present of the accepted key spellings; undefined when none is sent. */
function readMailOutcome(created: CreatedUser | null): MailOutcome | undefined {
  return created?.welcome_mail ?? created?.welcomeMail ?? created?.credentialMail ?? created?.mail;
}

/*
 * POST /admin/users/:id/reset-mailbox-password → { ok, welcomeMail }.
 *
 * Structurally a CreatedUser (it carries the same mail outcome, under the
 * camelCase key), so `readMailOutcome` reads it unchanged rather than growing a
 * second near-identical reader that could drift from the aliases above.
 *
 * As everywhere else on this page: the new temporary password is NOT on this
 * payload and must never be put on it — it rides back over HTTP to the browser.
 */
type ResetMailboxPasswordResult = CreatedUser & { ok?: boolean };

/*
 * POST /admin/users/check-official-email → the DIRECTORY pre-flight.
 *
 * Distinct from the `/admin/users/check-email` probe further down, and they
 * answer different questions — keep both:
 *   check-email          → is this address free in tbl_user (our own CRM DB)?
 *   check-official-email → does a Microsoft 365 account already exist at this
 *                          UPN? An address nobody in the CRM holds can still be
 *                          occupied in the directory (a leaver whose account was
 *                          never removed, a namesake in another business unit).
 *
 * `suggested` is the next free numbered UPN (mohit.kumar2@, mohit.kumar3@, …)
 * or null when the backend could not find one inside its probe bound.
 *
 * `taken` splits the two very different reasons `available` comes back false:
 *   taken:true  → the directory definitively answered "this UPN exists".
 *   taken:false → the probe was INCONCLUSIVE (403 / 429 / 5xx / network), so
 *                 availability is unknown. Graph consent being absent makes
 *                 EVERY address land here, which is why it must never be worded
 *                 as "this name is taken".
 * Optional because a backend that predates the flag omits it — absent is read as
 * unknown, never as taken (see resolveOfficialEmail).
 *
 * WHY THIS RUNS BEFORE THE USER ROW IS WRITTEN: a collision discovered
 * mid-create would leave a tbl_user row whose official_email no longer matches
 * any directory account we can provision, so the pre-flight has to settle the
 * address first and the create then carries the settled one.
 */
type OfficialEmailCheck = {
  available: boolean;
  taken?: boolean;
  email: string;
  suggested?: string | null;
  reason?: string;
};

/*
 * Shared email-shape check. Deliberately loose (the same expression the
 * Official Email probe already uses): the authoritative validation is the
 * backend's Joi schema, and a strict RFC regex here would reject valid
 * addresses that Joi accepts.
 */
const EMAIL_RE = /^\S+@\S+\.\S+$/;
/*
 * Inline hint only — the authority is normalisePan() in the backend's
 * user.service.js, which rejects the same shapes with the message the footer
 * shows. Deliberately NOT /g: a global regex carries lastIndex between .test()
 * calls, so the second keystroke against the same pattern can return false on
 * a valid value.
 */
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/*
 * Must stay a subset of user.service.js's SORTABLE_COLUMNS keys. The BACKEND
 * pair cannot drift — routes/admin/users.js derives its Joi whitelist from that
 * object — but this list is hand-kept, and a key here that the server does not
 * know is rejected by Joi with a 400. Adding `user_code` without adding it there
 * first is the mistake this comment exists to prevent.
 */
type SortKey =
  | 'user_id' | 'user_code' | 'user_name' | 'official_email' | 'mobile_no'
  | 'role_name' | 'city_name' | 'user_status' | 'insert_date';
type SortDir = 'asc' | 'desc';

// PAGE_SIZE is now operator-controlled via the TablePagination footer
// dropdown. Default 10 matches the new spec.

export default function ManageUsersPage() {
  const confirm = useConfirm();
  const lookup = useLookup();
  // `refresh` re-reads /auth/me — used after a SELF-edit so a permission the
  // operator just granted themselves applies immediately (see onSaved below).
  const { me, refresh: refreshMe } = useMe();
  // Permission gating mirrors legacy CRM Constants.actionPermissions:
  //   - isUserEdit  : controls the Edit + Deactivate buttons on each row.
  //                   Legacy doesn't have a separate "isUserAddNew" — the
  //                   Add User button is open to any admin-role user, and
  //                   we keep that behaviour. If ops wants finer control,
  //                   add a new menu_action row with action_name=isUserAddNew
  //                   and re-gate the Add button here.
  const can = actionFlags(me, ['isUserEdit']);

  // ID → Name map for expanding manage_states CSV in the list. Built from
  // the lookup cache (already loaded by useLookup). The list shows
  // "Manage Regions" as a comma-joined list of region (state) names.
  // (Manage Clients is form-only in legacy; not shown in the list, so no
  // clientNameById map is needed.)
  const stateNameById = useMemo(
    () => new Map(lookup.states.map((s) => [s.state_id, s.state_name])),
    [lookup.states]
  );

  const [items, setItems] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [roleFilter, setRoleFilter] = useState<number | ''>('');
  const [cityFilter, setCityFilter] = useState<number | ''>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<User | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  /*
   * sortBy is nullable so the 3rd click on a column can clear sort
   * entirely (canonical cycle from `cycleSort` in `lib/use-sort`).
   * When null, fetchList omits the sortBy/sortDir params so the BE
   * falls back to its default order.
   */
  const [sortBy,  setSortBy]  = useState<SortKey | null>('user_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function onSort(col: SortKey) {
    const next = cycleSort<SortKey>(col, { sortBy, sortDir });
    setSortBy(next.sortBy);
    setSortDir(next.sortDir);
    setPage(0);
  }

  const [howOpen, setHowOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('users-help-collapsed') === '0';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('users-help-collapsed', howOpen ? '0' : '1');
  }, [howOpen]);

  /*
   * Unified list-fetch effect — replaces the previous pair of effects
   * (one debounced for filter changes + one immediate for pagination)
   * that double-fired the request on mount. Now a single effect builds
   * the query string from all dependencies; `lastQueryRef` skips a
   * duplicate fire within 100ms (the Strict-Mode double-mount window
   * in dev) so two effects with the same effective key emit one HTTP
   * request, not two.
   *
   * Mutations (post-save / post-bulk-apply / post-toggle) call
   * `fetchList()` directly — that's the explicit refresh path. It
   * also invalidates the module-level fetch cache so any in-flight
   * dedupe doesn't return stale data.
   */
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef<{ key: string; at: number } | null>(null);
  const inflightAbortRef = useRef<AbortController | null>(null);

  function buildQuery(): string {
    const params = new URLSearchParams();
    if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
    if (roleFilter)    params.set('roleId', String(roleFilter));
    if (cityFilter)    params.set('cityId', String(cityFilter));
    if (includeInactive) params.set('includeInactive', 'true');
    const limit = pageSizeToLimit(pageSize);
    params.set('limit',  String(limit));
    params.set('offset', String(page * limit));
    if (sortBy) { params.set('sortBy', sortBy); params.set('sortDir', sortDir); }
    return params.toString();
  }

  async function fetchList() {
    // Cancel any in-flight request before starting a new one — kills
    // races where a slow earlier fetch lands after a faster later one.
    inflightAbortRef.current?.abort();
    const ac = new AbortController();
    inflightAbortRef.current = ac;

    setLoading(true);
    setError(null);
    try {
      const qs = buildQuery();
      const data = await api.get<ListResponse>(`/admin/users?${qs}`);
      if (ac.signal.aborted) return;
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(e instanceof ApiError ? e.message : 'Failed to load users');
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }

  // Single source of truth for list refresh. The search input is
  // debounced 300ms via useDebouncedValue upstream of this effect;
  // pagination/sort/select-filter changes fire immediately. The
  // 100ms dedupe window catches React Strict Mode's double-mount in
  // dev — without it, every page load triggers `users?…` twice.
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const fire = () => {
      const key = buildQuery();
      const now = Date.now();
      const last = lastQueryRef.current;
      if (last && last.key === key && now - last.at < 100) return;
      lastQueryRef.current = { key, at: now };
      void fetchList();
    };
    // setTimeout(0) batches same-tick dep changes into one fire.
    searchTimerRef.current = setTimeout(fire, 0);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, roleFilter, cityFilter, includeInactive, page, pageSize, sortBy, sortDir]);

  /*
   * RETRY MAILBOX CREATION — for a user whose Microsoft 365 provisioning did not
   * land (no licence seat at the time, Graph consent missing, the feature was
   * off when they were created, …). Hits the idempotent repair endpoint.
   *
   * ⚠ THE "IT ALREADY MADE IT BY HAND" CASE IS HANDLED SERVER-SIDE, not here.
   * provisionUserMailbox() looks the account up by UPN BEFORE creating, so a
   * mailbox someone created manually in the M365 admin centre in the meantime
   * resolves as `already_exists` — no duplicate account, and the licence step
   * reads assignedLicenses off that same lookup so it reports `already_licensed`
   * without spending a second seat. An inconclusive lookup (Graph 5xx/timeout)
   * aborts rather than creating blind. So this button is safe to press at any
   * time, including twice.
   *
   * On success the backend also sends the credential mail, so a user rescued by
   * a retry still receives their sign-in details rather than being silently
   * fixed but never told.
   */
  async function handleRetryMailbox(u: User) {
    const ok = await confirm({
      title: 'Retry Mailbox Creation?',
      description:
        `Re-run Microsoft 365 provisioning for ${u.user_name} (${u.official_email}). `
        + 'If the mailbox was already created manually it will be detected and reused — '
        + 'no duplicate account, no extra licence seat. On success the sign-in details '
        + 'are emailed to their personal address.',
      confirmLabel: 'Retry',
    });
    if (!ok) return;
    const toastId = showToast({ variant: 'loading', message: 'Retrying Mailbox Creation…' });
    try {
      const res = await api.post<CreatedUser>(`/admin/users/${u.user_id}/provision-mailbox`, {});
      dismissToast(toastId);
      const prov = res?.provisioning;
      // Via the shared reader, not res.welcome_mail directly — it tolerates the
      // key-spelling aliases, which is exactly the mismatch that once reported a
      // FAILED credential send as a green success.
      const mail = readMailOutcome(res ?? null);
      if (prov?.mailboxReady) {
        showToast({
          variant: mail && mail.status === 'failed' ? 'warning' : 'success',
          message: mail && mail.status === 'failed'
            ? `Mailbox Ready — but the credential email failed: ${mail.reason || 'see the provisioning record'}`
            : 'Mailbox Ready — sign-in details emailed',
        });
      } else {
        // Still not ready: show the SERVER's reason verbatim (e.g. the
        // "no free seats (67/67 used)" text) — it names the exact next action.
        showToast({
          variant: 'warning',
          message: `Mailbox Still Not Ready: ${prov?.reason || 'see the provisioning record'}`,
        });
      }
      invalidateFetch((k) => k.startsWith('/admin/users'));
      void fetchList();
    } catch (e) {
      dismissToast(toastId);
      showToast({
        variant: 'error',
        message: e instanceof ApiError ? e.message : 'Retry failed',
      });
    }
  }

  /*
   * RESET PASSWORD & SEND WELCOME MAIL — the rescue for a STRANDED user.
   *
   * The stranding is structural, not a transient failure, so no amount of
   * pressing "Retry Mailbox Creation" fixes it. When the first provisioning
   * attempt creates the Entra account but the licence step does not confirm,
   * that run holds a temporary password and no mailbox — so the credential mail
   * is suppressed by design (mailing Outlook sign-in details for an account
   * with no mailbox is worse than sending nothing), and the password is
   * discarded, never stored. Every LATER run takes the reuse path: it finds the
   * account already there and mints no password at all, so the mail is skipped
   * again for the opposite reason. The only run with a credential had no
   * mailbox; the only runs with a mailbox have no credential. Something must
   * mint a fresh password, and that is this action.
   *
   * ⚠ WHY IT IS A SEPARATE, DELIBERATE CLICK and never a side effect of the
   * retry: this REPLACES the account's Microsoft 365 password. If the account
   * is in fact working and in use, everyone signed in to it is signed out. That
   * is an acceptable price to rescue somebody who has never been able to sign
   * in, and an unacceptable one to pay silently on a healthy account — so the
   * operator states the intent explicitly, on a confirm that says exactly what
   * it does.
   */
  async function handleResetMailboxPassword(u: User) {
    const ok = await confirm({
      title: 'Reset Password & Send Welcome Mail?',
      description:
        `This CHANGES the Microsoft 365 password for ${u.user_name} (${u.official_email}). `
        + 'Anyone currently signed in to that account will be signed out. A new temporary '
        + 'password is generated and the sign-in details are emailed to their personal address. '
        + 'Use this only when the first provisioning attempt failed after the account was '
        + 'created, so this user never received their credentials — a plain Retry cannot fix '
        + 'that case, because the reuse path generates no password to share.',
      confirmLabel: 'Reset Password & Send Mail',
      cancelLabel: 'Cancel',
      variant: 'destructive',
    });
    if (!ok) return;
    const toastId = showToast({ variant: 'loading', message: 'Resetting Password…' });
    try {
      const res = await api.post<ResetMailboxPasswordResult>(
        `/admin/users/${u.user_id}/reset-mailbox-password`, {},
      );
      dismissToast(toastId);
      /*
       * Same treatment the create flow gives a mail outcome, and read through
       * the same alias-tolerant helper. The point of the action is the EMAIL,
       * so a reset whose mail did not go out must never read as a flat success:
       * the password has just been changed and nobody has been told the new one,
       * which is strictly worse than the state we started from.
       */
      const mail = readMailOutcome(res ?? null);
      if (mail?.status === 'sent') {
        showToast({ variant: 'success', message: 'Password Reset — Sign-In Details Emailed' });
      } else if (mail?.status === 'failed') {
        showToast({
          variant: 'warning',
          message: `Password Reset — but the sign-in details email FAILED to send: ${mail.reason || 'see the mail outcome'}. Share the credentials with them directly.`,
        });
      } else if (mail?.status === 'pending') {
        showToast({
          variant: 'warning',
          message: 'Password Reset — the sign-in details email is still sending. Check the provisioning record shortly.',
        });
      } else if (mail?.status === 'skipped') {
        showToast({
          variant: 'warning',
          message: `Password Reset — but NO email was sent: ${mail.reason || 'see the mail outcome'}. Share the credentials with them directly.`,
        });
      } else {
        // Backend reported no mail outcome at all (older build). Don't claim an
        // email went out when nothing said one did.
        showToast({ variant: 'success', message: 'Password Reset' });
      }
      invalidateFetch((k) => k.startsWith('/admin/users'));
      void fetchList();
    } catch (e) {
      dismissToast(toastId);
      showToast({
        variant: 'error',
        message: e instanceof ApiError ? e.message : 'Password reset failed',
      });
    }
  }

  async function handleDeactivate(u: User) {
    const ok = await confirm({
      title: 'Deactivate user?',
      description:
        `${u.user_name} will be marked inactive and won't be able to log in. Their historical records (job ownership, assignments, audit trail) stay intact. You can reactivate by editing and toggling Active.`,
      confirmLabel: 'Deactivate',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.delete(`/admin/users/${u.user_id}`);
      // Drop the module fetch cache for /admin/users keys so subsequent
      // useFetch consumers (or this page's next refetch) don't see the
      // stale row. See lib/hooks.ts module-level cache.
      invalidateFetch((k) => k.startsWith('/admin/users'));
      void fetchList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Deactivate failed');
    }
  }

  // totalPages now computed inside <TablePagination>; no local mirror needed.

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <UserCog className="size-6" /> Manage Users
          </h1>
          <p className="text-sm text-muted-foreground">
            Internal CRM staff. Auth is OTP-only — there are no passwords to manage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/settings/manage-users/hierarchy" className="inline-flex">
            <Button variant="outline">
              <Users className="size-4 mr-1" /> Hierarchy
            </Button>
          </a>
          <Button variant="outline" onClick={() => setBulkOpen(true)}>
            <Layers className="size-4 mr-1" /> Bulk Update Users
          </Button>
          <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
            <Plus className="size-4 mr-1" /> Add User
          </Button>
        </div>
      </div>

      {/* Bulk Update modal — opens to a full-viewport dialog with two
          tabs (Select & Apply | Upload File). Refreshes the user list
          on close so the just-edited rows show their new scope. */}
      {/* allUsers is no longer passed — the dialog now fetches the full
          active user set from /admin/users/bulk-lookups so it isn't
          constrained by this page's current page-size. onApplied
          refreshes the visible list (which IS paged) after a mutation. */}
      <BulkUpdateUsersDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onApplied={() => {
          // Drop the module fetch cache for any /admin/users key so a
          // subsequent useFetch consumer doesn't see stale rows from
          // before the bulk mutation. Then refire the visible page.
          invalidateFetch((k) => k.startsWith('/admin/users'));
          void fetchList();
        }}
      />

      <Card>
        <CardContent className="p-0">
          <button
            type="button"
            onClick={() => setHowOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
            aria-expanded={howOpen}
          >
            {howOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
            <Info className="size-4 shrink-0 text-info" />
            <span className="font-medium">How User management works</span>
            <span className="ml-auto text-xs text-muted-foreground">{howOpen ? 'Hide' : 'Show'}</span>
          </button>
          {howOpen && (
            <div className="px-4 pb-4 pt-1 text-sm text-muted-foreground space-y-3 border-t">
              <section>
                <h3 className="font-semibold text-foreground mb-1">1. Who shows up here</h3>
                <p>
                  Internal CRM staff only (clients and technicians have their own portals).
                  Each row is identified by User ID; name + email are set once at create
                  time and not editable afterwards because OTPs are delivered against
                  those identifiers.
                </p>
              </section>
              <section>
                <h3 className="font-semibold text-foreground mb-1">2. Login flow</h3>
                <p>
                  Users log in with their email or mobile + a 4-digit OTP. No passwords
                  are stored or set from this screen.
                </p>
              </section>
              <section>
                <h3 className="font-semibold text-foreground mb-1">3. Role assignment</h3>
                <p>
                  A user holds exactly one role from <code>tbl_role</code>. The role
                  decides which CRM screens they can reach (see Manage Roles for the
                  list). Only admin-group roles are selectable here — client and
                  technician roles live in their own modules.
                </p>
              </section>
              <section>
                <h3 className="font-semibold text-foreground mb-1">4. Deactivating a user</h3>
                <p>
                  Soft-delete only. The row stays in the database; default lists hide
                  it. Use &ldquo;Include inactive&rdquo; to bring it back and reactivate
                  via the edit form. Historical records remain intact.
                </p>
              </section>
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {error}
          </CardContent>
        </Card>
      )}

      {/*
        * Unified table card — filter row, table, and pagination all
        * live inside the same Card with internal borders so they read
        * as one cohesive table instead of three stacked sections.
        *   ┌─────────────────────────────────────────────────┐
        *   │  search · role · city · include inactive        │  ← thead-like
        *   ├─────────────────────────────────────────────────┤
        *   │  <table>                                        │
        *   ├─────────────────────────────────────────────────┤
        *   │  Show: 10 · « ‹ 6 / 8 › »                       │  ← tfoot-like
        *   └─────────────────────────────────────────────────┘
        */}
      <Card>
        <CardContent className="p-0">
          {/* Filter band — acts as the table's visual header row. */}
          <div className="p-3 flex items-center gap-2 flex-wrap border-b">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name, email, mobile, or code…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            {/* Filters use the shared SearchSelect (typeahead + keyboard nav)
                rather than native <select> so large role/city lists are
                filterable by typing. Empty value = "All roles" / "All cities". */}
            <div className="min-w-[180px]">
              <SearchSelect
                value={roleFilter === '' ? '' : roleFilter}
                onChange={(v) => setRoleFilter(v ? Number(v) : '')}
                options={lookup.roles.map((r) => ({ value: r.role_id, label: r.role_name }))}
                placeholder="All roles"
              />
            </div>
            <div className="min-w-[180px]">
              <CitySelect
                value={cityFilter}
                onChange={(id) => setCityFilter(id ? Number(id) : '')}
                placeholder="All cities"
              />
            </div>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
              Include inactive
            </label>
          </div>
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            {/*
                Column widths (must match the th/td sequence below):
                  72px       Photo    <- FIXED, not a percentage
                   7 percent User ID
                   7 percent Employee Code
                  13 percent Name
                  13 percent Email
                  17 percent Personal Email
                  10 percent Mobile
                  11 percent Role
                  11 percent Manage Regions
                   8 percent Job Stages
                   7 percent Status
                  128px      Actions  <- FIXED, not a percentage

                THE TWO PIXEL COLUMNS ARE THE ONES WHOSE CONTENT DOES NOT SCALE.
                Actions is four 20px icon buttons plus 24px of cell padding.
                Photo is a 32px circle plus that same 24px: 56px of content in a
                72px column. 72 rather than 56 because the HEADER, not the
                avatar, is the wider of the two — the word "Photo" measures
                39.7px, so a 64px column left it 0.3px of slack, which is
                rounding noise rather than a margin. At 72 it has 8.3px.

                THE PERCENTAGES SUM TO 104 AND THAT IS CORRECT. With
                table-layout: fixed and a mixed colgroup, Chrome scales the
                percentage columns to fill whatever the two pixel columns leave
                (measured: at a 1006px table each 1 percent resolved to 7.75px,
                i.e. (1006 - 72 - 128)/104). Only the RATIOS matter — do NOT
                "correct" them back to 100.

                RE-MEASURED 2026-09-02, when the Photo column was added, because
                a twelfth column narrows every percentage column and a header
                that fitted with 2px to spare stops fitting. Method: the page's
                shell (240px sidebar + main's 32px of px-4 + the Card's 2px of
                border, so table width = viewport - 274) rendered in headless
                Chrome against BOTH compiled CSS chunks and the real IBM Plex
                faces; each header label wrapped in an inline <span> and its
                getBoundingClientRect().width compared against the th's
                clientWidth minus its 24px of padding. NOT scrollWidth >
                clientWidth — table cells do not scroll, so that test can never
                fire and reports "no clipping" for a header that is visibly cut.
                Controls: starving Name (the largest-slack column) to 1 percent
                flagged it at all four viewports, so the detector can fail.

                MEASURED LABEL WIDTHS (semibold 14px, including the sort arrow
                on sortable columns, since any column can be the active sort)
                and the column each one gets:

                  label            needs |  @1180  @1280  @1440  @1920
                  Photo             39.7 |     72     72     72     72
                  User ID           65.6 |   47.5   54.2     65   97.3
                  Employee Code    120.5 |   47.5   54.2     65   97.3
                  Name              55.2 |   88.3  100.8  120.8  180.8
                  Email             52.5 |   88.3  100.8  120.8  180.8
                  Personal Email    98.7 |  115.4  131.8  157.9  236.4
                  Mobile            61.2 |   67.9   77.5   92.9  139.0
                  Role              45.5 |   74.7   85.2  102.2  152.9
                  Manage Regions    54.1 |   74.7   85.2  102.2  152.9
                  Job Stages        75.5 |   54.3   62.0   74.3  111.2
                  Status            59.9 |   47.6   54.3   65.1   97.4
                  Actions           50.9 |    128    128    128    128

                THE HEADERS CLIP BELOW 1920 AND DID BEFORE THIS COLUMN EXISTED.
                Every label above needs its width PLUS 24px of padding, and the
                titles want 928px of a table that is 1006px wide at 1280 with
                200px of it already committed to the two pixel columns. Measured
                clipped sets, before and after adding Photo, are IDENTICAL:
                  1180  User ID, Employee Code, Personal Email, Mobile,
                        Manage Regions, Job Stages, Status
                  1280  User ID, Employee Code, Mobile, Job Stages, Status
                  1440  User ID, Employee Code, Job Stages, Status
                  1920  Employee Code
                That parity is the whole reason the percentages moved. Holding
                the old 7/8/12/12/13/8/10/9/8/6 and simply inserting a 12th
                column pushed Personal Email over at 1280 and Mobile at 1440;
                the set above puts the freed points where the labels actually
                are. Tightest surviving margin is Role at +3.5px, at 1180 with
                a classic always-on scrollbar — the pessimistic case, since
                macOS Chrome uses overlay scrollbars. In that same case the new
                set is strictly BETTER than the old one at 1280: Personal Email
                clipped there before and does not now.

                THE 139px FIGURE IN THE PREVIOUS VERSION OF THIS COMMENT DOES
                NOT REPRODUCE. "User ID" plus its arrow measures 65.6px, so the
                column needs 89.6px, not 139. Nor do the headers wrap: SortHeader
                pins `whitespace-nowrap` on both the th AND its inner span, so
                the two-line-header design this comment used to describe is not
                what ships. Employee Code needs 120.5px on one line and clips at
                every viewport including 1920 — a live, PRE-EXISTING defect that
                only a shorter label or a wrappable SortHeader can fix, and
                neither is in this file.

                Inline JSX expression comments are illegal inside colgroup
                (they introduce single-space text nodes that fail
                hydration). See manage-roles for the full backstory.
            */}
            <colgroup>
              <col style={{ width: '72px' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '17%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '128px' }} />
            </colgroup>
            <thead>
              <tr>
                {/*
                  * Photo. Not sortable — there is nothing to order by, and a
                  * clickable header over a column of faces would only invite a
                  * click that does nothing.
                  */}
                <th className="!text-center whitespace-nowrap">Photo</th>
                <SortHeader col="user_id"        align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>User ID</SortHeader>
                {/*
                  * Employee Code (tbl_user.user_code) — already on the list
                  * projection, just never rendered. Ops identify people by it
                  * on every other screen, so its absence here meant reading a
                  * user's code off their profile page one at a time.
                  *
                  * Sortable: `user_code` is in user.service.js's
                  * SORTABLE_COLUMNS, and routes/admin/users.js derives its Joi
                  * whitelist from those same keys, so the two sides agree by
                  * construction rather than by anyone remembering. It sorts as
                  * TEXT — codes are E-prefixed and zero-padded, so lexical order
                  * is numeric order — and users with no code yet sort to the top
                  * ascending, which is the end you want them at.
                  */}
                <SortHeader col="user_code" align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Employee Code</SortHeader>
                <SortHeader col="user_name"      align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Name</SortHeader>
                <SortHeader col="official_email" align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Email</SortHeader>
                {/*
                  * Personal Email. Surfaced so ops can see at a glance who
                  * still lacks one — the field is mandatory going forward but
                  * every pre-existing user was created without it, so this
                  * column IS the backfill worklist.
                  *
                  * Deliberately NOT a <SortHeader>: sortBy values are
                  * whitelisted against SORTABLE_COLUMNS in
                  * services/user.service.js, and personal_email lives in a
                  * joined side table rather than on tbl_user. Offering the
                  * sort before the backend whitelists it would send a param
                  * the API rejects. Same reasoning as Regions / Job Stages.
                  */}
                <th className="!text-left whitespace-nowrap" title="Personal (non-company) email — where sign-in details are sent (tbl_user_personal_contact)">Personal Email</th>
                <SortHeader col="mobile_no"      align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Mobile</SortHeader>
                <SortHeader col="role_name"      align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Role</SortHeader>
                {/*
                  * "Manage Regions" = expanded names from tbl_user.manage_states CSV.
                  * The list shows this as a comma-joined string of region (state)
                  * names. Not sortable because the underlying column is a CSV —
                  * sorting it would order rows by the raw "1,5,12" string, which
                  * is meaningless to operators.
                  */}
                <th className="!text-left whitespace-nowrap" title="Regions this user is allowed to manage (tbl_user.manage_states)">Regions</th>
                {/*
                  * Job Stage Access. Surfaced in the list because a restrictive
                  * grant is invisible otherwise yet has real blast radius — a
                  * "No Access" user sees no job pages at all. Not sortable: the
                  * value lives in tbl_user_allowed_stages, not on the row.
                  */}
                <th className="!text-left whitespace-nowrap" title="Job lifecycle stages this user can see and act on (tbl_user_allowed_stages)">Job Stages</th>
                <SortHeader col="user_status"    align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/*
                * Loading row appears ONLY when there's no existing data
                * to keep visible. On refetch (filter / page-size /
                * sort changes), we keep the previously-loaded rows
                * rendered so the table doesn't flash empty during the
                * 200ms server round-trip. Page-size changes especially
                * benefit — operators see the existing 10 rows stay
                * put, then the additional rows append on response.
                */}
              {loading && items.length === 0 && (
                <tr><td colSpan={12} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={12} className="!text-center text-muted-foreground py-6">No users match the current filters.</td></tr>
              )}
              {items.map((u) => (
                <tr key={u.user_id}>
                  {/* No `truncate` here, unlike every other cell: the content is
                      a fixed 32px circle inside a 64px column, so there is
                      nothing to overflow and `overflow:hidden` would only risk
                      clipping the focus ring. */}
                  <td className="!text-center">
                    <div className="flex items-center justify-center">
                      <UserAvatar name={u.user_name} photoUrl={u.photo_url} />
                    </div>
                  </td>
                  <td className="!text-center font-mono text-xs truncate">{u.user_id}</td>
                  {/* Monospace like User ID — both are identifiers people read
                      digit by digit and compare down a column. "—" when unset,
                      matching Personal Email below. */}
                  <td className="!text-center font-mono text-xs truncate" title={u.user_code ?? ''}>
                    {u.user_code || <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left font-medium truncate" title={u.user_name}>{u.user_name}</td>
                  <td className="!text-left truncate" title={u.official_email}>{u.official_email}</td>
                  {/* Same treatment as Email above (left, truncate, full value
                      in the title tooltip); "—" when the user predates the
                      field so the gap is visible rather than looking blank. */}
                  <td className="!text-left truncate" title={u.personal_email ?? ''}>
                    {u.personal_email || <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left font-mono text-xs truncate" title={u.mobile_no}>{u.mobile_no}</td>
                  <td className="!text-left truncate" title={u.role_name ?? ''}>
                    {u.role_name ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left truncate">
                    <ManageRegionsCell csv={u.manage_states} nameById={stateNameById} />
                  </td>
                  <td className="!text-left truncate">
                    <JobStagesCell stages={u.allowed_stages} />
                  </td>
                  <td className="!text-center whitespace-nowrap">
                    {u.user_status === 1
                      ? <span className="text-success-strong text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    {/*
                      * Icon-only row actions via the shared <IconButton>
                      * (src/components/ui/icon-button.tsx) — the single
                      * canonical per-row action icon for the CRM. It owns
                      * the uniform size/padding/intent-colour + subtle
                      * hover tint; this cell just owns the right-aligned
                      * flex wrapper. Edit → intent="primary" (blue),
                      * Deactivate → intent="danger" (red).
                      */}
                    <div className="inline-flex items-center justify-end">
                      {can.isUserEdit && (
                        <IconButton
                          icon={Pencil}
                          intent="primary"
                          label="Edit user"
                          onClick={async () => {
                            // The list row's `alternate_no` is BE-masked
                            // ("9876••••••"). Pre-filling the edit form
                            // with that would either show bullets in an
                            // input (confusing) or corrupt the record on
                            // save (Joi rejects). Refetch the user with
                            // ?unmasked=true so the edit modal pre-fills
                            // with the actual digits. Same pattern as
                            // JobModal / EasyfixerModal use for their
                            // edit modes.
                            try {
                              const fresh = await api.get<typeof u>(
                                `/admin/users/${u.user_id}`,
                                { unmasked: 'true' },
                              );
                              setEditing(fresh);
                            } catch {
                              // Fallback to the list row if the unmasked
                              // fetch fails — operator can still save by
                              // clearing the mobile field manually.
                              setEditing(u);
                            }
                            setModalOpen(true);
                          }}
                        />
                      )}
                      {can.isUserEdit && u.user_status === 1 && (
                        <IconButton
                          icon={Trash2}
                          intent="danger"
                          label="Deactivate user"
                          onClick={() => handleDeactivate(u)}
                        />
                      )}
                      {/* Retry Mailbox Creation — only for ACTIVE users, and
                          only for Admins (the repair route is Admin-guarded, so
                          showing it to anyone else would just produce a 403). */}
                      {can.isUserEdit && u.user_status === 1 && (
                        <IconButton
                          icon={MailWarning}
                          intent="primary"
                          label="Retry Mailbox Creation"
                          onClick={() => handleRetryMailbox(u)}
                        />
                      )}
                      {/*
                        * Reset Password & Send Welcome Mail — the rescue for a
                        * user stranded with an account but no credentials (see
                        * handleResetMailboxPassword for why a retry can never
                        * fix that). Deliberately UNLIKE its neighbour: a key,
                        * not an envelope, and red rather than blue, because it
                        * rewrites a live Microsoft password and signs the
                        * account out. Two adjacent blue envelopes would invite
                        * exactly the mis-click this action must not receive.
                        */}
                      {can.isUserEdit && u.user_status === 1 && (
                        <IconButton
                          icon={KeyRound}
                          intent="danger"
                          label="Reset Password & Send Welcome Mail"
                          onClick={() => handleResetMailboxPassword(u)}
                        />
                      )}
                      {!can.isUserEdit && (
                        <span className="text-xs text-muted-foreground">view-only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Pagination band — acts as the table's visual footer row,
              sharing the same Card boundary as the filter band + table. */}
          <div className="px-3 py-2 border-t">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </div>
        </CardContent>
      </Card>

      <UserFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        roles={lookup.roles}
        cities={lookup.cities}
        clients={lookup.clients}
        states={lookup.states}
        verticals={lookup.verticals}
        adminUsers={lookup.adminUsers}
        onSaved={() => {
          const editedSelf = !!editing && me?.user?.user_id === editing.user_id;
          setModalOpen(false);
          // Drop the module fetch cache so any consumer reading
          // /admin/users keys sees the fresh row after a save.
          invalidateFetch((k) => k.startsWith('/admin/users'));
          void fetchList();
          /*
           * Editing YOURSELF changes your own identity payload — Job Stage
           * Access, menu permissions and scope all ride on `me`, which is
           * cached and otherwise only revalidates on window focus (throttled
           * to 30s). Without this, granting yourself a stage leaves the
           * sidebar stale for several seconds before it silently corrects
           * itself, which reads as a bug rather than a permission taking
           * effect. Only fires on a self-edit; editing someone else can't
           * touch our own `me`.
           */
          if (editedSelf) void refreshMe();
        }}
      />
    </div>
  );
}

// ─── Manage-Regions cell ─────────────────────────────────────────────
/*
 * Expands a CSV string of IDs to a comma-joined list of names. Truncates
 * gracefully with a "+N more" suffix when the row has many entries; the
 * full list is exposed in the title tooltip so operators can still read
 * everything without scrolling the cell.
 *
 * Used by the list table to show manage_states (regions) as a
 * comma-separated display. Returns "—" placeholder when the CSV is empty
 * or null.
 */
function expandCsvToNames(csv: string | null | undefined, nameById: Map<number, string>): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .map((id) => nameById.get(id))
    .filter((name): name is string => !!name);
}

/*
 * ─── Profile photo, list + modal ────────────────────────────────────────────
 *
 * Same three-state avatar the navbar's identity block renders
 * (components/layout/Navbar.tsx), lifted here so a row and the Add/Edit modal
 * can share one implementation:
 *
 *   1. photo   — <img> straight off the presigned `photo_url`.
 *   2. INITIALS — and this is the COMMON case, not a failure state. Almost
 *      nobody on tbl_user has uploaded a photo, so the monogram is what this
 *      column mostly IS; it gets the solid `bg-primary` plate and
 *      `text-primary-foreground` lettering so it reads as a deliberate
 *      identity chip rather than an empty hole. Both tokens are stable across
 *      :root/.dark, which is what local/no-inverting-surface-with-fixed-
 *      foreground requires of a plate carrying pinned lettering.
 *   3. the URL 404s — the third state nobody designs for. `photo_url` is
 *      presigned and short-lived, so a list left open past its TTL would
 *      otherwise paint a row of broken-image glyphs. onError drops back to the
 *      monogram, which is indistinguishable from having no photo — correct,
 *      because to the viewer it is.
 *
 * ONLY A REAL PHOTO IS CLICKABLE. With no photo there is nothing to enlarge, so
 * the monogram renders as a plain <span> and cannot open an empty lightbox; the
 * button (and its pointer cursor) appears only when a click would show
 * something. `failed` participates in that test, so a 404 removes the
 * affordance too rather than opening a dialog onto the same broken image.
 */
function UserAvatar({ name, photoUrl }: { name: string; photoUrl?: string | null }) {
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  /* Reset on URL change, or a refreshed list (new presigned URL for the same
     user) would stay stuck on the monogram for the rest of the session. */
  useEffect(() => { setFailed(false); setZoomed(false); }, [photoUrl]);

  /* First letter of the first and last words, so "Priyanka Balasubramaniam"
     reads PB and a single-word name reads one letter rather than a doubled
     one. Uppercased — a lowercased login name would render a lowercase
     monogram. Identical rule to the navbar, deliberately. */
  const initials = useMemo(() => {
    const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    const first = parts[0][0] ?? '';
    const last  = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
    return (first + last).toUpperCase();
  }, [name]);

  const hasPhoto = !!photoUrl && !failed;
  const face = (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-xs font-semibold text-primary-foreground"
    >
      {hasPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoUrl!}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : initials}
    </span>
  );

  if (!hasPhoto) return face;

  return (
    <>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        title="Click To Enlarge"
        aria-label={`Enlarge Photo Of ${name}`}
        className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {face}
      </button>
      {/* Closed lightbox costs nothing: DialogContent sits inside Radix's
          DialogPortal, which renders null until `open`, so the per-row
          instances never reach the DOM until one is clicked. */}
      <SkillImageLightbox
        value={zoomed ? { url: photoUrl!, name } : null}
        onClose={() => setZoomed(false)}
      />
    </>
  );
}

function ManageRegionsCell({ csv, nameById }: { csv: string | null | undefined; nameById: Map<number, string> }) {
  // '0' is the legacy "All" sentinel (lib/scope.js — mode === 'all').
  // Render it as a green pill so ops can see at a glance which users
  // have unrestricted scope.
  if (String(csv ?? '').trim() === '0') {
    return (
      <span className="inline-flex items-center rounded-full bg-success-tint text-success-strong px-2 py-0.5 text-xs font-medium">
        All
      </span>
    );
  }
  const names = expandCsvToNames(csv, nameById);
  if (names.length === 0) return <span className="text-muted-foreground">—</span>;
  // Show first 2 + "+N more" — keeps the column readable even for users
  // who manage many regions. Hover reveals the full list.
  const visible = names.slice(0, 2);
  const overflow = names.length - visible.length;
  return (
    <span title={names.join(', ')} className="text-xs">
      {visible.join(', ')}
      {overflow > 0 && <span className="text-muted-foreground"> +{overflow} more</span>}
    </span>
  );
}

// ─── Job-Stage-Access cell ───────────────────────────────────────────
/*
 * Renders the tri-state Job Stage Access grant. The two ends are pills rather
 * than text because they are the states an operator scans for:
 *
 *   null / undefined → "All"        green  — unrestricted (no rows; the default)
 *   []               → "No Access"  red    — explicitly granted nothing; this
 *                                            user sees NO job pages at all
 *   ['unconfirmed',…]→ stage labels        — restricted to those stages
 *
 * "All" is green to match ManageRegionsCell above, so the two scope columns
 * read the same way. "No Access" is the only red pill in the table — it is the
 * one setting that silently empties the CRM for someone.
 */
function JobStagesCell({ stages }: { stages?: string[] | null }) {
  if (stages == null) {
    return (
      <span className="inline-flex items-center rounded-full bg-success-tint text-success-strong px-2 py-0.5 text-xs font-medium">
        All
      </span>
    );
  }
  if (stages.length === 0) {
    return (
      <span
        title="This user has been granted no lifecycle stages — they cannot see or act on any job."
        className="inline-flex items-center rounded-full bg-urgent-tint text-urgent-strong px-2 py-0.5 text-xs font-medium"
      >
        No Access
      </span>
    );
  }
  // Same first-2 + "+N more" treatment as Regions — hover reveals the rest.
  const labels = stages.map((k) => STAGES[k as keyof typeof STAGES]?.label ?? k);
  const visible = labels.slice(0, 2);
  const overflow = labels.length - visible.length;
  return (
    <span title={labels.join(', ')} className="text-xs">
      {visible.join(', ')}
      {overflow > 0 && <span className="text-muted-foreground"> +{overflow} more</span>}
    </span>
  );
}

// Local SortHeader removed 2026-05-15 — migrated to the shared
// component in `lib/use-sort.tsx` (3-state cycle + icon only on
// active column). See `cycleSort` + `<SortHeader>` import above.

// ─── Add/Edit modal ─────────────────────────────────────────────────
/*
 * Create form: name + email + mobile + role + Manage Regions (multi) +
 * Manage Clients (multi) + Manage Verticals.
 * Edit form:   name + email shown read-only (OTP is keyed off these);
 *              everything else editable.
 *
 * Geo scope is REGION (state) level: a user is assigned Regions (the
 * `tbl_user.manage_states` CSV, labelled "Manage Regions") and handles ALL
 * cities in them. This REPLACES the legacy addEditUser.vm "Manages Cities"
 * picker — `manage_cities` is now always saved as "0" (all) and the backend
 * derives the effective city scope from the user's Regions (see
 * EasyFix_Backend/lib/scope.js `expandStatesToCities`).
 *
 * Fields:
 *   - User Name        (read-only on edit)
 *   - Email            (read-only on edit)
 *   - Personal Email   * on Add and on editing an ACTIVE user; optional when
 *                        the user is inactive or is being deactivated.
 *                        See `personalEmailRequired` — the asterisk and the
 *                        submit guard both read that one constant.
 *   - Mobile Number    *
 *   - User Role        *
 *   - Manage Regions   (multi-select, CSV in tbl_user.manage_states)
 *   - Manage Clients   (multi-select, CSV in tbl_user.manage_clients)
 *   - Status           (edit only)
 *
 * The "home City" picker (tbl_user.city_id) is a new-app addition kept for
 * other flows that key off it; it sits below the scope pickers.
 */
function UserFormModal({
  open, onClose, editing, roles, cities, clients, states, verticals, adminUsers, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: User | null;
  roles: Array<{ role_id: number; role_name: string }>;
  /*
   * Cities/clients now carry their parent FK (state_id / vertical_id)
   * so the Manages Cities / Manages Clients pickers can cascade off
   * Manages States / Manages Verticals. Both fields default to null
   * for orphan rows — those are excluded from the cascaded view since
   * they belong to no parent.
   */
  cities: Array<{ city_id: number; city_name: string; state_id: number | null }>;
  clients: Array<{ client_id: number; client_name: string; vertical_id: number | null }>;
  states: Array<{ state_id: number; state_name: string }>;
  verticals: Array<{ vertical_id: number; vertical_name: string }>;
  adminUsers: Array<{ user_id: number; user_name: string; role_name?: string }>;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  // Used by the official-email pre-flight below. The repo forbids native
  // confirm(); this is the same hook the row actions use, and it already
  // stacks correctly over this modal (see useCancelConfirm, same pattern).
  const confirm = useConfirm();
  const [name,    setName]    = useState('');
  const [email,   setEmail]   = useState('');
  const [personalEmail, setPersonalEmail] = useState('');
  /*
   * ── HR MASTER DATA ────────────────────────────────────────────────
   * All five are optional. doj / uan / address round-trip normally: the stored
   * value is prefilled, and clearing the box clears the column.
   *
   * pan and aadhaar do NOT round-trip, and cannot. The backend returns them
   * MASKED (XXXXXX234F) because a full PAN on every user load is a PAN in the
   * browser cache — so there is no stored value to prefill with. Prefilling the
   * MASK would be worse than useless: an untouched Save would post the literal
   * X's back and overwrite the real number. Both boxes therefore start EMPTY on
   * every open, the current value is shown as text beside them, and they are
   * submitted ONLY when the operator has typed something.
   */
  const [doj, setDoj] = useState('');
  const [uan, setUan] = useState('');
  const [pan, setPan] = useState('');
  const [aadhaar, setAadhaar] = useState('');
  const [address, setAddress] = useState('');
  const [mobile,  setMobile]  = useState('');
  const [altMob,  setAltMob]  = useState('');
  /*
   * Real-time mobile-uniqueness check.
   *   mobileCheck.state — 'idle' (no probe in flight), 'checking' (probe
   *     in flight), 'available' (mobile is free), 'taken' (taken by another
   *     active internal user), 'invalid' (not 10 digits — UI shows the
   *     existing length warning instead, so we render nothing for this).
   *   Cached in a Map so re-typing the same number doesn't refetch and the
   *   debounce delay (450ms) is the only wait on first probe.
   */
  const [mobileCheck, setMobileCheck] = useState<{
    state: 'idle' | 'checking' | 'available' | 'taken' | 'invalid';
    takenByName?: string;
  }>({ state: 'idle' });
  const mobileCacheRef = useRef<Map<string, { available: boolean; takenBy?: { user_id: number; user_name: string } }>>(new Map());
  /*
   * Real-time email-uniqueness check — parallel to mobileCheck.
   * `suggestion` is filled in by the backend when the typed email is
   * taken AND the form has a non-empty Name (so the suggestion can be
   * derived from <first>.<last>). One-click "Use suggestion" calls
   * setEmail() to adopt it.
   */
  const [emailCheck, setEmailCheck] = useState<{
    state: 'idle' | 'checking' | 'available' | 'taken' | 'invalid';
    takenByName?: string;
    suggestion?: string;
  }>({ state: 'idle' });
  const emailCacheRef = useRef<Map<string, {
    available: boolean;
    takenBy?: { user_id: number; user_name: string };
    suggestion?: string;
  }>>(new Map());
  const [roleId,  setRoleId]  = useState<number | ''>('');
  const [cityId,  setCityId]  = useState<number | ''>('');
  const [active,  setActive]  = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // Prompt before discarding the form on Cancel — applies to every Add
  // / Edit User open. See `useCancelConfirm` for the standard copy.
  const cancelWithConfirm = useCancelConfirm(onClose);
  const [error, setError] = useState<string | null>(null);

  // Manages Clients / States / Verticals — Sets for O(1) toggle. Persisted
  // as CSV strings on save to match legacy `tbl_user.manage_*` storage.
  // Hydrated from the editing row's CSV by parsing the comma-separated id
  // list. Cities are no longer collected here — the form always saves
  // manage_cities='0' and the backend derives the effective city scope
  // from the user's states (regions).
  /*
   * Employee code. State holds the COUNT ONLY — the prefix is a fixed affix
   * beside the input and is added back by formatEmpCode() on save, so a foreign
   * prefix cannot be typed and the stored value can never be half a code.
   *
   * Named, never spelt out. This comment and the one on the affix below both
   * said `EF` until 2026-09-01 — the prefix the codes have not used since the
   * format was corrected to E + 6 — while the JSX three lines down rendered
   * EMP_CODE_PREFIX correctly. A comment that contradicts the line it annotates
   * is worse than no comment: the next reader trusts it over the code.
   *
   * On Add it is prefilled with the next free count from the backend. That is a
   * SUGGESTION, not a reservation: nothing is held, so two admins who open this
   * form at the same moment are handed the same number, and the backend's
   * duplicate check inside the create transaction is what actually prevents a
   * collision. The operator can overwrite it, which is the point of the field.
   */
  const [empCount, setEmpCount] = useState('');
  const empSeededRef = useRef(false);
  /*
   * Fetched for a NEW user and equally for an EXISTING one that has no code
   * yet. user_code is NULL for every row on production until ops seed real
   * codes, so an Edit form that only prefilled on Add would confront an admin
   * with a mandatory empty field every time they touched a legacy user — and
   * they came to flip a status, not to allocate an employee code. Suggesting
   * the next free one turns that block into a single confirming click, and the
   * backend leaves user_code optional on PATCH so nothing forces the issue.
   */
  const needsEmpSuggestion = open && !parseEmpCodeCount(editing?.user_code);
  const nextEmpCode = useFetch<{ count: number; code: string }>(
    needsEmpSuggestion ? '/admin/users/next-emp-code' : null,
  );

  /*
   * The five identifiers come from GET /admin/users/:id, NOT from the list row.
   * The list deliberately does not carry them: it would put a PAN, an Aadhaar
   * and a home address for every member of staff into one pageable response,
   * and the backend gates them behind the Admin ROLE on the detail endpoint for
   * that reason. One extra request, opened only when the modal is.
   *
   * A non-Admin caller gets a row without the keys, so every read below falls
   * back to '' and the section renders empty rather than breaking.
   */
  const userDetail = useFetch<Partial<User> & {
    date_of_joining?: string | null; uan?: string | null; address?: string | null;
    pan_masked?: string | null; aadhaar_masked?: string | null;
  }>(open && editing ? `/admin/users/${editing.user_id}` : null);

  const [manageClients,   setManageClients]   = useState<Set<number>>(new Set());
  const [manageStates,    setManageStates]    = useState<Set<number>>(new Set());
  const [manageVerticals, setManageVerticals] = useState<Set<number>>(new Set());
  // "All" toggles — when ON the corresponding multi-select is disabled
  // and we save '0' as the CSV (matches lib/scope.js's mode==='all').
  // Hydrated on edit-mode by detecting CSV === '0' on the editing row.
  const [verticalsAll, setVerticalsAll] = useState(false);
  const [clientsAll,   setClientsAll]   = useState(false);
  const [statesAll,    setStatesAll]    = useState(false);
  const [reportingManager, setReportingManager] = useState<number | ''>('');
  /*
   * Job Stage Access — restrict this user to a subset of job lifecycle STAGES
   * (STAGE_KEYS from lib/job-stages.ts). `allowedStages` holds the picked
   * stage_keys; `stagesAll` is the "All stages" toggle. Default = All ON
   * (unrestricted) so a new user is never accidentally locked out.
   *
   * Save semantics (see handleSubmit): the backend contract is NULL = ALL
   * (unrestricted), EMPTY ARRAY [] = explicit NO ACCESS, non-empty = restricted.
   * So All-ON → null; a specific pick → that array; All-OFF with no picks → []
   * (the operator deliberately granted nothing — the user sees no jobs).
   */
  const [allowedStages, setAllowedStages] = useState<Set<string>>(new Set());
  const [stagesAll,     setStagesAll]     = useState(true);

  // Reporting Manager + Home City + Role + all 4 scope multi-selects now
  // use `SearchSelect`/`SearchMultiSelect`, which own their own internal
  // filter + selected-label state. The previous module-local
  // `managerQuery` / `cityQuery` / `filtered*` / `selected*Name` memos
  // were therefore removed — leaving them would have been dead state.

  // Helper to convert a CSV string to a Set<number>. Tolerant of nulls,
  // whitespace, junk — matches the backend's parseMenuIdsCsv.
  function csvToSet(csv: string | null | undefined): Set<number> {
    if (!csv) return new Set();
    return new Set(
      String(csv)
        .split(',')
        .map((s) => Number(String(s).trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    );
  }

  /* Seeded ONCE per open. Without the ref the suggestion would land again on
   * every refetch and overwrite a count the operator had already edited. */
  useEffect(() => {
    if (needsEmpSuggestion && !empSeededRef.current && nextEmpCode.data?.count) {
      setEmpCount(padEmpCount(String(nextEmpCode.data.count)));
      empSeededRef.current = true;
    }
  }, [needsEmpSuggestion, nextEmpCode.data]);

  useEffect(() => {
    if (open) {
      setName(editing?.user_name ?? '');
      // Edit hydrates the existing code; Add waits for the suggestion above.
      setEmpCount(parseEmpCodeCount(editing?.user_code));
      empSeededRef.current = !!parseEmpCodeCount(editing?.user_code);
      setEmail(editing?.official_email ?? '');
      setPersonalEmail(editing?.personal_email ?? '');
      setMobile(editing?.mobile_no ?? '');
      setAltMob(editing?.alternate_no ?? '');
      setRoleId(editing?.user_role ?? '');
      setCityId(editing?.city_id ?? '');
      setActive(editing ? editing.user_status === 1 : true);
      // '0' is the legacy "All" sentinel — hydrate the All toggle ON
      // and leave the Set empty. The picker is disabled while All is
      // on; save() re-serialises '0' regardless of the Set state.
      const isAll = (csv: string | null | undefined) => String(csv ?? '').trim() === '0';
      setVerticalsAll(isAll(editing?.manage_verticals));
      setClientsAll(isAll(editing?.manage_clients));
      setStatesAll(isAll(editing?.manage_states));
      setManageClients(isAll(editing?.manage_clients) ? new Set() : csvToSet(editing?.manage_clients));
      setManageStates(isAll(editing?.manage_states) ? new Set() : csvToSet(editing?.manage_states));
      setManageVerticals(isAll(editing?.manage_verticals) ? new Set() : csvToSet(editing?.manage_verticals));
      setReportingManager(editing?.reporting_manager ?? '');
      /*
       * Cleared on EVERY open, then hydrated by the effect below when the
       * detail request resolves. Resetting here rather than only on close is
       * what stops the previous user's UAN sitting in the box for the moment
       * between opening the modal and the fetch returning.
       */
      setDoj(''); setUan(''); setAddress('');
      /* pan/aadhaar are never hydrated — see the state comment. */
      setPan(''); setAadhaar('');
      // Job Stage Access — NULL / absent allowed_stages = unrestricted, so
      // hydrate the "All stages" toggle ON with an empty pick set. An ARRAY
      // (even an empty one) means the operator has set an explicit grant:
      // toggle OFF, pick set = the array. [] therefore round-trips as
      // "no access", not as All.
      const stages = editing?.allowed_stages ?? null;
      setStagesAll(stages === null);
      setAllowedStages(new Set(stages ?? []));
      setError(null);
    }
  }, [open, editing]);

  /*
   * Hydrate the three round-trippable identifiers once the detail arrives.
   * Keyed on `userDetail.data` so it runs when the request resolves, not on
   * every render — and NOT merged into the open-effect above, which fires
   * before the response exists.
   */
  useEffect(() => {
    const d = userDetail.data;
    if (!open || !d) return;
    setDoj(d.date_of_joining ?? '');
    setUan(d.uan ?? '');
    setAddress(d.address ?? '');
  }, [open, userDetail.data]);

  function toggleManageClient(id: number) {
    setManageClients((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /*
   * Cascade rules for Verticals → Clients and States → Cities
   * (introduced 2026-05-15):
   *
   * - Picker options for the dependent field (Clients / Cities) only
   *   include rows whose parent FK is in the currently-selected parent
   *   set. If 0 parents are selected, the picker shows nothing — the
   *   operator must pick a parent first.
   * - When a parent is REMOVED, prune the selected dependents whose
   *   parent FK was that removed parent (and isn't in any of the
   *   still-selected parents). "Don't remove for parents not altered"
   *   — adding never prunes.
   * - Orphan dependents (parent FK = null) are dropped whenever the
   *   filter is active (any parent selected). They can never be added
   *   through the strict picker; clearing all parents leaves them
   *   un-addable until a parent is picked again.
   * - Initial DB hydration of the form is NOT a "change" — load is
   *   raw csvToSet, so existing legacy data with mismatched parents
   *   stays visible as chips until the operator interacts with the
   *   parent field. This preserves backwards-compat for old records
   *   saved before this constraint existed.
   *
   * The cascade lives in the change/toggle handlers (not a useEffect
   * on [manageVerticals]) so the initial hydration doesn't trigger
   * an unwanted prune.
   */
  function applyManageVerticals(next: Set<number>) {
    setManageVerticals(next);
    setManageClients((prevClients) => {
      // Adding a vertical: prevClients ⊆ allowed-by-prev ⊆ allowed-by-next
      // → no prune needed (but pruning is also idempotent so the filter
      // below stays safe to run unconditionally).
      if (next.size === 0) return new Set();
      const pruned = new Set<number>();
      for (const cid of prevClients) {
        const c = clients.find((x) => x.client_id === cid);
        if (!c || c.vertical_id == null) continue;
        if (next.has(c.vertical_id)) pruned.add(cid);
      }
      return pruned;
    });
  }
  function toggleManageVertical(id: number) {
    const next = new Set(manageVerticals);
    if (next.has(id)) next.delete(id); else next.add(id);
    applyManageVerticals(next);
  }

  function applyManageStates(next: Set<number>) {
    // Regions (states) no longer cascade into a Cities picker — this is now
    // a plain setter. Kept as a named helper so toggleManageState and the
    // ScopeMultiSelect onChange share one entry point.
    setManageStates(next);
  }
  function toggleManageState(id: number) {
    const next = new Set(manageStates);
    if (next.has(id)) next.delete(id); else next.add(id);
    applyManageStates(next);
  }

  // Job Stage Access — plain add/remove of a stage_key. Used by the chip
  // remove-buttons and (via the picker) the multi-select onChange.
  function toggleStage(key: string) {
    setAllowedStages((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  /*
   * Derived option lists for the cascaded pickers. When no parent is
   * selected, the list is empty — a helper note under each picker
   * tells the operator to pick a parent first. Orphan rows (parent
   * FK = null) are excluded from the strict-filtered view.
   */
  // Cascading filters (aligned with the Bulk Update modal):
  //   - parent-All ON → child shows every active record
  //   - parent empty (and parent-All OFF) → child shows ALL active
  //     records as well (operator hasn't constrained scope yet)
  //   - parent has picks → child filtered to records under those picks
  //
  // The All-toggle on the child is GATED separately at the UI layer
  // (see ScopeMultiSelect's disableAll prop) so the operator can't
  // store child=0 with an empty parent.
  const filteredClientOptions = useMemo(() => {
    if (verticalsAll || manageVerticals.size === 0) {
      return clients.map((c) => ({ value: c.client_id, label: c.client_name }));
    }
    return clients
      .filter((c) => c.vertical_id != null && manageVerticals.has(c.vertical_id))
      .map((c) => ({ value: c.client_id, label: c.client_name }));
  }, [clients, manageVerticals, verticalsAll]);

  /*
   * Debounced real-time mobile-uniqueness probe. Fires only when:
   *   - exactly 10 digits typed (shorter is a length warning, not a probe)
   *   - mobile differs from the user being edited (no probe for unchanged)
   * Cache hits resolve instantly; cache misses wait 450ms after the last
   * keystroke. The dropdown stays disabled during 'checking' so a fast
   * Save can't race the probe. AbortController cancels stale requests
   * when the user keeps typing.
   */
  /*
   * Debounced real-time email-uniqueness probe. The email field is
   * read-only on Edit (OTP keys to it), so the probe only runs on the
   * Add flow. The `name` query param lets the backend generate a
   * `<first>.<last>[<n>]@easyfix.in` suggestion when the typed address
   * is taken — we surface it as a one-click chip below the input.
   */
  useEffect(() => {
    if (!open) return;
    if (isEdit) { setEmailCheck({ state: 'idle' }); return; }
    const e = email.trim().toLowerCase();
    if (!e) { setEmailCheck({ state: 'idle' }); return; }
    if (!/^\S+@\S+\.\S+$/.test(e)) {
      setEmailCheck({ state: 'invalid' });
      return;
    }
    // Cache key includes name so suggestion bumps regenerate when the
    // operator renames the user; the email itself is what we probe.
    const cacheKey = `${e}::${name.trim().toLowerCase()}`;
    const cached = emailCacheRef.current.get(cacheKey);
    if (cached) {
      setEmailCheck(cached.available
        ? { state: 'available' }
        : { state: 'taken', takenByName: cached.takenBy?.user_name, suggestion: cached.suggestion });
      return;
    }
    setEmailCheck({ state: 'checking' });
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const params: Record<string, string | number> = { email: e };
        if (name.trim()) params.name = name.trim();
        // Debounced
        // availability probe with its own `emailCacheRef` keyed on
        // email+name; the effect implements bespoke setTimeout-debounce
        // + stale-response cancellation that's tighter than what
        // useFetch/useDebouncedValue would give here (cache key depends
        // on TWO inputs, and we suppress fetch entirely on invalid
        // formats / Edit mode / same-as-editing). Migration would mean
        // reimplementing the cache+gating layer above the hook.
        // eslint-disable-next-line no-restricted-syntax
        const res = await api.get<{
          available: boolean;
          takenBy?: { user_id: number; user_name: string };
          suggestion?: string;
        }>('/admin/users/check-email', params);
        if (cancelled) return;
        emailCacheRef.current.set(cacheKey, res);
        setEmailCheck(res.available
          ? { state: 'available' }
          : { state: 'taken', takenByName: res.takenBy?.user_name, suggestion: res.suggestion });
      } catch {
        if (!cancelled) setEmailCheck({ state: 'idle' });
      }
    }, 450);
    return () => { window.clearTimeout(timer); cancelled = true; };
  }, [email, name, isEdit, open]);

  useEffect(() => {
    if (!open) return;
    // Same-as-editing → not a change, skip the probe entirely.
    if (isEdit && mobile === (editing?.mobile_no ?? '')) {
      setMobileCheck({ state: 'idle' });
      return;
    }
    // Canonical rule, shared with every other mobile field in the CRM and now
    // with the backend's Joi. This screen used to hand-roll a looser ten-digit
    // check, which let it probe availability for numbers create would reject.
    if (!INDIAN_MOBILE_REGEX.test(mobile)) {
      // length warning is rendered by the existing UI; we stay idle.
      setMobileCheck({ state: mobile.length === 0 ? 'idle' : 'invalid' });
      return;
    }
    const cached = mobileCacheRef.current.get(mobile);
    if (cached) {
      setMobileCheck(cached.available
        ? { state: 'available' }
        : { state: 'taken', takenByName: cached.takenBy?.user_name });
      return;
    }
    setMobileCheck({ state: 'checking' });
    // Stale-response guard: each effect run sets `cancelled=true` from its
    // cleanup callback, so an in-flight probe whose result arrives AFTER
    // the user kept typing simply no-ops instead of overwriting the newer
    // state. The api wrapper doesn't surface AbortSignal, and that's fine
    // for a 10-digit probe — at most one stale request hits the network.
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const params: Record<string, string | number> = { mobile };
        if (isEdit && editing?.user_id) params.excludeUserId = editing.user_id;
        // Mirror of the
        // email availability probe above: bespoke setTimeout-debounce
        // + per-mobile cache ref + same-as-editing short-circuit. Same
        // rationale as the email probe — useFetch's single-key contract
        // can't express the "skip when same as editing" branch without
        // a contrived enabled chain.
        // eslint-disable-next-line no-restricted-syntax
        const res = await api.get<{ available: boolean; takenBy?: { user_id: number; user_name: string } }>(
          '/admin/users/check-mobile', params,
        );
        if (cancelled) return;
        mobileCacheRef.current.set(mobile, res);
        setMobileCheck(res.available
          ? { state: 'available' }
          : { state: 'taken', takenByName: res.takenBy?.user_name });
      } catch {
        if (!cancelled) setMobileCheck({ state: 'idle' });
      }
    }, 450);
    return () => { window.clearTimeout(timer); cancelled = true; };
  }, [mobile, isEdit, editing?.user_id, editing?.mobile_no, open]);

  /*
   * ── Personal Email requiredness — ONE derived boolean, ONE rule ──────
   *
   * This constant is the single source of truth. The red asterisk on the
   * Label reads it and the submit validator reads it, so the marker can
   * never disagree with what actually blocks Save. (A form that stars a
   * field the validator ignores — or worse, silently rejects an unstarred
   * one — is worse than having no marker at all.)
   *
   *   Add User                       → required
   *   Edit a user who is ACTIVE and stays active → required
   *   Edit a user who is already INACTIVE        → NOT required
   *   Edit that DEACTIVATES (Status toggled off) → NOT required
   *
   * Why the two exemptions: offboarding someone who has already left must
   * never be blocked on collecting their personal address — that edit is
   * precisely the one where nobody can still reach them to ask. Requiring
   * it on the active path is what backfills the existing users, since a
   * touched record has an operator present who can fill it in.
   *
   * It reads `active` (the live form toggle), not `editing.user_status`
   * alone, so flipping Status off clears the asterisk and the requirement
   * in the same render — the operator sees the rule change as they make it.
   */
  const personalEmailRequired = !isEdit || (editing!.user_status === 1 && active);

  /*
   * ── Official-email DIRECTORY pre-flight ──────────────────────────────
   *
   * Returns the address to actually create the user with, or null when the
   * operator chose to abort (nothing is submitted and the form is left exactly
   * as they typed it, so they can edit and try again).
   *
   * Runs BEFORE the user row is written — see the OfficialEmailCheck type for
   * why the order matters. The happy path costs the operator nothing: a free
   * address returns straight away with no dialog and no extra click.
   *
   * Three outcomes need a human:
   *   taken + suggestion → say who is in the way and what will be created
   *                        instead, then adopt the suggestion on confirm. The
   *                        visible field is updated too, so the address the
   *                        operator can read afterwards is the one that was
   *                        created — a form still showing the address we did
   *                        NOT use is how the wrong person gets emailed.
   *   taken, no suggestion → the address IS occupied and no free numbered
   *                        alternative was found. There is nothing we can
   *                        silently substitute, so the only honest options are a
   *                        different address or knowingly taking this one.
   *   not taken / no answer → we do not KNOW. Reported as "could not verify",
   *                        never as "available": a check that is trusted and
   *                        wrong is worse than no check, because it converts a
   *                        question the operator would have asked into a false
   *                        assurance.
   *
   * WHICH OF THE LAST TWO IS DECIDED BY `taken`, NOT BY `suggested`. Inferring it
   * from a missing suggestion conflated three unrelated situations — a taken
   * address whose probe bound was exhausted, a taken address whose suggestion
   * lookup itself failed, and an address nobody could reach the directory to
   * check — and put the "could not verify" wording in front of all of them. The
   * server now states it outright, so we branch on the statement.
   *
   * A response with NO `taken` at all (a backend older than the flag) is read as
   * unknown, never as taken: hard-blocking Add User because the UI is ahead of
   * the API is a worse failure than asking. Such a backend still gets the swap
   * confirm whenever it returns a `suggested`, exactly as it did before.
   *
   * Continuing past the last two is allowed but is the operator's explicit
   * decision. It is not a hole in the guard — the backend refuses to reuse a
   * directory account that is not already recorded against THIS user, so a real
   * collision is stopped at the mailbox step rather than silently attaching
   * this person to a stranger's mailbox.
   */
  async function resolveOfficialEmail(candidate: string): Promise<string | null> {
    let check: OfficialEmailCheck | null = null;
    try {
      check = await api.post<OfficialEmailCheck>('/admin/users/check-official-email', { email: candidate });
    } catch {
      // Swallowed deliberately — an unreachable check is not a failed create.
      // It falls through to the "could not verify" confirm below, which is the
      // honest report of what we know.
      check = null;
    }

    // Free — proceed exactly as before this pre-flight existed.
    if (check?.available) return candidate;

    /*
     * Not gated on `taken`: a returned suggestion is itself proof the server got
     * a definitive answer (it only numbers UPNs around a confirmed collision),
     * and gating would silently discard the suggestion from a backend that has
     * not shipped the flag yet.
     */
    if (check && check.suggested) {
      const suggested = check.suggested;
      const ok = await confirm({
        title: 'Email Already Exists',
        description: (
          <span>
            <span className="font-mono">{candidate}</span> already exists in the Microsoft 365
            directory{check.reason ? ` (${check.reason})` : ''}. A new email will be created as{' '}
            <span className="font-mono font-semibold">{suggested}</span> instead.
            {' '}Confirm to create this user with <span className="font-mono">{suggested}</span>,
            or cancel to type a different address.
          </span>
        ),
        confirmLabel: 'Use Suggested Email',
        cancelLabel: 'Cancel',
      });
      if (!ok) return null;
      // Keep the field and the payload in agreement — both get the suggestion.
      // The payload uses the returned value rather than reading `email` back,
      // because this setState has not landed by the time the POST is built.
      setEmail(suggested);
      return suggested;
    }

    /*
     * Only a definitive directory hit may be worded as "taken". Everything else
     * — an inconclusive probe (taken:false) and an unreachable check (no
     * response at all) — is the same fact from the operator's side: we do not
     * know. Missing `taken` lands here too, by the older-backend rule above.
     */
    const isTaken = check?.taken === true;

    const ok = await confirm({
      title: isTaken ? 'No Available Email Found' : 'Email Could Not Be Verified',
      description: isTaken
        ? `${candidate} already exists in the Microsoft 365 directory`
          + `${check?.reason ? ` (${check.reason})` : ''}, and no free numbered alternative was found. `
          + 'Cancel and choose a different address, or continue to create this user on an address '
          + 'that is already taken — the mailbox step will then refuse to attach them to somebody '
          + 'else’s account, so they will be left without a mailbox.'
        : `We could not confirm whether ${candidate} already exists in the Microsoft 365 directory, `
          + 'so its availability is UNKNOWN — this is not a report that the address is taken. Cancel '
          + 'and try again in a moment, or continue — the mailbox step will refuse to attach this '
          + 'user to somebody else’s account.',
      confirmLabel: 'Continue Anyway',
      cancelLabel: 'Cancel',
      variant: 'destructive',
    });
    return ok ? candidate : null;
  }

  async function handleSubmit() {
    setError(null);
    if (!isEdit) {
      if (!name.trim())  { setError('Name is required'); return; }
      if (!email.trim()) { setError('Email is required'); return; }
      if (!/^\S+@\S+\.\S+$/.test(email)) { setError('Email format looks wrong'); return; }
      // Defensive — the BE also rejects duplicates, but blocking here
      // keeps the operator from clicking Save while the rose hint is
      // still on screen. We tolerate 'checking' (in-flight probe):
      // backend is the source of truth and will reject if needed.
      if (emailCheck.state === 'taken') {
        setError('Email already in use');
        return;
      }
    }
    /*
     * Employee Code is mandatory on both paths. formatEmpCode returns '' for
     * anything that is not a whole 1-6 digit count, so this one check covers
     * empty, non-numeric and over-long in a single answer — and the value that
     * goes on the wire is the one the shared formatter produced, never the raw
     * field, so the padding can't drift between here and the backend.
     */
    const empCode = formatEmpCode(empCount);
    if (!empCode) {
      setError('Employee Code is required');
      return;
    }
    /*
     * Personal Email — gated on the SAME `personalEmailRequired` constant that
     * drives the asterisk, so the two can't drift. The format check runs on any
     * non-empty value regardless of requiredness: an optional field is still
     * not a free-text field, and a typo'd address on an inactive user is a
     * silent dead letter later. Backend Joi enforces the identical matrix.
     */
    const personal = personalEmail.trim();
    if (personalEmailRequired && !personal) {
      setError('Personal Email is required');
      return;
    }
    if (personal && !EMAIL_RE.test(personal)) {
      setError('Personal Email format looks wrong');
      return;
    }

    /*
     * ── HR identifiers ────────────────────────────────────────────────
     * Blocking checks, in the footer where every other validation message
     * lands. Each mirrors a backend rule exactly (normaliseUan / normalisePan /
     * normaliseAadhaar in user.service.js) — the backend is still the
     * authority, this just saves a round trip and points at the right box.
     *
     * All three are skipped when blank: these fields are optional, and an
     * empty one is how HR clears a value entered by mistake.
     */
    if (uan.trim() && uan.trim().length !== 12) {
      setError('UAN must be exactly 12 digits');
      return;
    }
    if (pan.trim() && !PAN_RE.test(pan.trim())) {
      setError('PAN must be 5 letters, 4 digits, then a letter — e.g. ABCDE1234F');
      return;
    }
    if (aadhaar.trim() && !/^[2-9][0-9]{11}$/.test(aadhaar.trim())) {
      setError('Aadhaar must be 12 digits and cannot start with 0 or 1');
      return;
    }
    /*
     * Mobile is OPTIONAL (2026-08-03) — it used to be mandatory. Blank passes;
     * anything typed must still be exactly 10 digits, so a mistyped number is
     * caught rather than half-stored. Mirrors the backend createBody, which now
     * allows '' / null but keeps the same pattern.
     */
    if (mobile.trim() && !INDIAN_MOBILE_REGEX.test(mobile)) { setError(INDIAN_MOBILE_ERROR); return; }
    if (altMob && !/^[0-9]{10}$/.test(altMob)) { setError('Alternate number must be 10 digits or blank'); return; }
    // Block submit if the real-time probe found a collision. Backend
    // re-checks on create/update too — this is defensive UX only. We
    // tolerate 'checking' (probe in flight): backend is the source of
    // truth and will reject if needed; blocking submit on 'checking'
    // would frustrate fast typists.
    if (mobileCheck.state === 'taken') {
      setError(`Mobile already in use${mobileCheck.takenByName ? ` by ${mobileCheck.takenByName}` : ''}`);
      return;
    }
    if (!roleId) { setError('Role is required'); return; }

    // Vertical-touched → client-mandatory rule (mirrors the BE bulk
    // route). If the operator toggled All or picked any verticals,
    // they must explicitly pick (or All) clients too — prevents the
    // "narrowed vertical but forgot clients" footgun.
    const verticalsTouched = verticalsAll || manageVerticals.size > 0;
    const clientsTouched   = clientsAll   || manageClients.size   > 0;
    if (verticalsTouched && !clientsTouched) {
      setError('You picked verticals — please also pick clients (or toggle All).');
      return;
    }

    // Serialise the Sets back to CSV — matches legacy tbl_user storage.
    // Sort by id so the persisted value is deterministic.
    //
    // "All" sentinel rules (per ops direction 2026-05-25):
    //   1. The explicit "All" toggle emits '0' (existing behaviour).
    //   2. If the operator picks every option ONE-BY-ONE without
    //      toggling "All", we ALSO collapse to '0' so the stored
    //      value matches semantic intent. Saves storage churn on
    //      lookups that grow (e.g. a new city added later would
    //      otherwise leave that user "behind"; with '0' they
    //      inherit the new option automatically).
    const csvOrAll = (all: boolean, set: Set<number>, total: number) => {
      if (all) return '0';
      // Auto-collapse: full set === All
      if (total > 0 && set.size >= total) return '0';
      const csv = Array.from(set).sort((a, b) => a - b).join(',');
      return csv || null;
    };
    // Cities are no longer collected in this form. Scope is now "Manage
    // Regions" (states) only; the backend derives the effective city scope
    // from the user's states. We always persist manage_cities as the '0'
    // ("all") sentinel so nothing narrows the city dimension from here.
    const manageClientsCsv   = csvOrAll(clientsAll,   manageClients,   clients.length);
    const manageStatesCsv    = csvOrAll(statesAll,    manageStates,    states.length);
    const manageVerticalsCsv = csvOrAll(verticalsAll, manageVerticals, verticals.length);

    /*
     * Job Stage Access. Backend contract: NULL = ALL (unrestricted, stored as
     * no rows); EMPTY ARRAY [] = explicit NO ACCESS (stored as a sentinel row);
     * a non-empty array = restricted to those stage_keys. So:
     *   All-ON             → null  (unrestricted)
     *   All-OFF + no picks → []    (no access — the operator granted nothing)
     *   specific picks     → that array
     */
    const allowedStagesPayload: string[] | null = stagesAll
      ? null
      : Array.from(allowedStages);

    setSubmitting(true);
    /*
     * The create response carries the Microsoft 365 mailbox outcome alongside
     * the new user — see `provisioning` on CreatedUser. Captured so the toast
     * can tell the truth: the CRM user is created either way, but the mailbox
     * can fail INDEPENDENTLY (no licence seat, missing Graph consent, SKU not
     * on the tenant), and a flat green "User Created" hides exactly that.
     */
    let created: CreatedUser | null = null;
    try {
      /*
       * Directory pre-flight, create flow only (Official Email is frozen on
       * edit). `submitting` is already true, so the button is disabled for the
       * duration of the probe and the confirm. Returning here still runs the
       * `finally` below, which clears it.
       */
      let officialEmail = email.trim();
      if (!isEdit) {
        const resolved = await resolveOfficialEmail(officialEmail);
        if (resolved === null) return;  // operator cancelled — nothing submitted
        officialEmail = resolved;
      }
      /*
       * The five identifiers, assembled once for both branches.
       *
       * doj / uan / address are ALWAYS sent (as null when blank) so clearing a
       * box clears the column. pan / aadhaar are sent ONLY when the operator
       * typed something: the form never holds the stored value, so an absent
       * key is the only way to say "leave it as it is" — and the backend's
       * upsert treats an absent key exactly that way.
       */
      const identifierPayload: Record<string, string | null> = {
        date_of_joining: doj.trim() || null,
        uan:             uan.trim() || null,
        address:         address.trim() || null,
      };
      if (pan.trim())     identifierPayload.pan     = pan.trim();
      if (aadhaar.trim()) identifierPayload.aadhaar = aadhaar.trim();

      if (isEdit) {
        await api.patch(`/admin/users/${editing!.user_id}`, {
          ...identifierPayload,
          user_code:        empCode,
          // null (not '') when cleared — the column is NULLable and '' would
          // store an address that can never be mailed but reads as "present".
          personal_email:   personal || null,
          mobile_no:        mobile,
          alternate_no:     altMob || null,
          user_role:        Number(roleId),
          city_id:          cityId ? Number(cityId) : null,
          manage_cities:    '0',
          manage_clients:   manageClientsCsv,
          manage_states:    manageStatesCsv,
          manage_verticals: manageVerticalsCsv,
          allowed_stages:   allowedStagesPayload,
          reporting_manager: reportingManager ? Number(reportingManager) : null,
          is_active:        active,
        });
      } else {
        created = await api.post<CreatedUser>('/admin/users', {
          ...identifierPayload,
          user_name:        name.trim(),
          user_code:        empCode,
          // The PRE-FLIGHT's answer, not the raw field — on a collision this is
          // the numbered address the operator confirmed.
          official_email:   officialEmail,
          // Required on create — this is the address the sign-in details are
          // mailed to, and the new user cannot read their official inbox until
          // they have used them.
          personal_email:   personal,
          mobile_no:        mobile,
          alternate_no:     altMob || null,
          user_role:        Number(roleId),
          city_id:          cityId ? Number(cityId) : null,
          manage_cities:    '0',
          manage_clients:   manageClientsCsv,
          manage_states:    manageStatesCsv,
          manage_verticals: manageVerticalsCsv,
          allowed_stages:   allowedStagesPayload,
          reporting_manager: reportingManager ? Number(reportingManager) : null,
        });
      }
      // Success feedback via the shared bottom-centre toast — matches
      // the convention used across the CRM (Notice Board, Manage Roles,
      // Manage Clients). Inline `setError` stays for FAILURES so the
      // operator sees them within the still-open modal.
      // Title Case + no trailing period — matches the project-wide UI
      // label-casing rule (memory `feedback_easyfix_label_casing`).
      /*
       * MAILBOX OUTCOME — reported honestly, not folded into the success toast.
       *
       * Creating the Entra account and assigning the 365 licence are TWO
       * independent steps: `created` + `no_seats_available` means the directory
       * account exists but there is no mailbox, so the address will bounce.
       * Observed live on user 8737 (vijay.nailwal@easyfix.in): the operator saw
       * a green "User Created" while the mailbox had silently failed on
       * "SKU O365_BUSINESS_ESSENTIALS has no free seats (67/67 used)".
       *
       * `warning` (amber, 6s) is the right variant, not `error`: the user WAS
       * created — this is an operation that succeeded but not the way the
       * operator asked. Rose on a successful action trains people to distrust
       * the colour. Amber also holds for 6s rather than success's 4s, because
       * the reason is something they have to read and act on.
       */
      /*
       * ── Toast matrix (create flow; an edit is always a plain success) ──
       *
       * Exactly ONE toast fires. The branches are ordered by how much the
       * operator has to DO about each outcome, most-actionable first —
       * stacking three toasts would bury the one that matters.
       *
       *   1. provisioning / mail pending → warning: outcome not known yet
       *   2. mailbox NOT ready           → warning: no mailbox, and by design
       *                                    NO credential mail was sent (the
       *                                    service reports 'skipped'). Outranks
       *                                    branch 3 because the mail not going
       *                                    out is a CONSEQUENCE here, not a
       *                                    fault, and the mailbox is the thing
       *                                    to fix.
       *   3. mail 'failed'               → warning: the account and mailbox are
       *                                    fine but nobody has been told the
       *                                    password. Needs a human — ops must
       *                                    re-share the sign-in details.
       *   4. mail 'sent'                 → success, and say so; the operator
       *                                    needs to know an email went out to a
       *                                    personal address.
       *   5. everything else             → plain success. Covers 'skipped' for
       *                                    benign reasons (NOTIFICATIONS_DISABLE
       *                                    on QA) and a backend that reports no
       *                                    mail outcome at all.
       */
      const prov = created?.provisioning;
      const mail = readMailOutcome(created);
      if (!isEdit && (prov?.pending || mail?.status === 'pending')) {
        showToast({
          variant: 'warning',
          message: 'User Created — Microsoft 365 mailbox provisioning is still running. Check the Provisioning panel shortly.',
        });
      } else if (!isEdit && prov?.attempted && !prov.mailboxReady) {
        showToast({
          variant: 'warning',
          message: `User Created — but the Microsoft 365 mailbox is NOT ready: ${prov.reason || 'see the provisioning outcome'}`,
        });
      } else if (!isEdit && mail?.status === 'failed') {
        showToast({
          variant: 'warning',
          message: `User Created and the mailbox is ready, but the sign-in details email FAILED to send: ${mail.reason || 'see the mail outcome'}. Share the credentials with them directly.`,
        });
      } else if (!isEdit && mail?.status === 'sent') {
        showToast({
          variant: 'success',
          message: 'User Created — Sign-In Details Emailed',
        });
      } else {
        showToast({
          variant: 'success',
          message: isEdit ? 'User Updated' : 'User Created',
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  // useFormDirtyGuard (2026-06-03) — same pattern as the sibling
  // Add/Edit Role modal: Esc / X / overlay-click now prompt with the
  // shared "Discard changes?" confirm; skip while saving.
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      {/* Wider modal — matches Add/Edit Role so the two settings forms
          feel like siblings, and gives the multi-select pickers enough
          horizontal room for the chip rows below them.

          ONE SCROLLER, and that is the whole point of these three classes.
          DialogContent's base is `max-h-[85vh] overflow-y-auto`, so a body
          that ALSO declared `max-h-[70vh] overflow-y-auto` — as this one did —
          put two scroll containers in the same chain. Measured in Chrome at
          1400x900: the inner band scrolled 1419px and the panel itself another
          56px, so a wheel gesture ran the form to its end and then lurched the
          whole modal, header and all. That extra 56px was also the only way to
          reach the footer, which is why Save Changes sat below the fold.

          `overflow-hidden` deletes the base overflow via tailwind-merge (the
          local/no-unscrollable-dialog-content rule allows it precisely because
          there IS a scroll region beneath), `flex flex-col` gives the body a
          track to fill, and `flex-1 min-h-0` lets it shrink below its content
          so it — and only it — scrolls. Header and footer are pinned with
          shrink-0. Byte-for-byte the arrangement Add/Edit Role already used;
          this modal had simply diverged from the sibling it claims to match. */}
      <DialogContent className="!max-w-[1100px] w-[95vw] max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          {/*
            * Avatar beside the title, same component the list column renders, so
            * the operator confirms they opened the right person's record before
            * reading a single field. Click enlarges, exactly as in the list.
            *
            * EDIT ONLY, and that is the whole handling of the Add case: on Add
            * there is no user, so there is no name to build a monogram from and
            * no photo to show — an avatar there would be a circle standing in
            * for nobody. It is omitted rather than rendered empty, and the row
            * collapses back to just the title.
            *
            * Reads `editing.photo_url`, which arrives from whichever fetch
            * opened the modal (the list row, or the ?unmasked=true refetch the
            * Edit action does). If a backend build serves photo_url on the list
            * but not on the detail projection, this degrades to the monogram —
            * the same third state the 404 path lands on, and equally harmless.
            */}
          <div className="flex items-center gap-3">
            {isEdit && <UserAvatar name={editing!.user_name} photoUrl={editing!.photo_url} />}
            <DialogTitle>{isEdit ? `Edit "${editing!.user_name}"` : 'Add User'}</DialogTitle>
          </div>
        </DialogHeader>
        <div className="space-y-3 flex-1 min-h-0 overflow-y-auto pr-1">
          {/* Row 1: Full Name | Status toggle (edit only).
              On Add, the Status column is unused — Status defaults to
              Active for new users so we omit it entirely instead of
              showing a redundant always-on switch, and the grid carries two
              tracks rather than three. Below md everything is one column, so
              the toggle drops under the name field gracefully. */}
          {/* No `items-end` here, unlike every other row in this form — and that
              is the point. Employee Code carries a conditional hint under it
              ("Prefilled with the next free code…"), so bottom-aligning the row
              pushed its label and input ~2 lines ABOVE Full Name's, and moved
              them again depending on whether the hint was showing. Alignment
              must not be a function of optional content. Top-aligned, the two
              fields share a baseline and the hint hangs below, which is exactly
              what rows 2-4 already do with their own conditional helper text.

              WIDTHS, per-mode, because Status changes what is affordable.
              Measured in Chrome against the compiled stylesheet, over the
              1048px of content width inside the 1100px panel:

                Add    60% name | 157px | 25% code     code flush right, 1 row
                Edit   57.6%    |  12px | 25% | 15.1%  status flush right

              Add has only two cells, so `[60%_25%]` plus justify-between spends
              every leftover pixel as a single gap in the middle — and it now
              holds from md up, where the old thirds-grid gave 49/49 with no gap
              at all.

              Edit cannot have 60%. Status is intrinsically 159px (label +
              switch + the w-16 state word) = 15.0% of 1048, and two gaps take
              24px more, so a literal 60/25/15 overflows by 26px and squeezes
              the state word onto two lines. `1fr` hands Full Name every pixel
              that is genuinely free — 57.6% — with Employee Code still exactly
              25%. Both class strings are written out in full: Tailwind scans
              source text, so a template literal assembled from fragments would
              emit no rule at all. */}
          <div
            className={`grid grid-cols-1 gap-3 ${
              isEdit
                ? 'md:grid-cols-2 lg:grid-cols-[1fr_25%_auto]'
                : 'md:grid-cols-[60%_25%] md:justify-between'
            }`}
          >
            <div>
              <Label className="block mb-1" required>
                Full Name {isEdit && <span className="text-xs text-muted-foreground font-normal">(not editable)</span>}
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                disabled={isEdit}
              />
            </div>
            <div>
              <Label className="block mb-1" required>Employee Code</Label>
              {/* Prefix as a non-editable affix, mirroring the @easyfix.in
                  suffix on Official Email below: the operator edits the count
                  and only the count, so the prefix is guaranteed and the padding
                  is applied on save by the shared formatter. Rendered from
                  EMP_CODE_PREFIX, so naming it here would just be a second copy
                  free to drift — as it did. */}
              <div className="flex items-stretch">
                <span className="inline-flex select-none items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-sm text-muted-foreground">
                  {EMP_CODE_PREFIX}
                </span>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={empCount}
                  onChange={(e) => setEmpCount(sanitiseEmpCount(e.target.value))}
                  /* Settle to the six digits that will be stored. Padding on
                     every keystroke would turn "1" into "000001" and the next
                     digit into "0000012"; on blur it is just the truth. */
                  onBlur={() => setEmpCount((c) => padEmpCount(c))}
                  placeholder="200244"
                  className="rounded-l-none"
                />
              </div>
              {needsEmpSuggestion && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {nextEmpCode.loading
                    ? 'Finding The Next Free Code…'
                    : isEdit
                      ? 'This user has no code yet. Prefilled with the next free one — change it if they already have one.'
                      : 'Prefilled with the next free code. Edit it if this employee already has one.'}
                </p>
              )}
            </div>
            {isEdit ? (
              /* `lg:` only, and that is load-bearing. At lg the grid is 3-across
                 and Status sits BESIDE the two fields, so it needs the label
                 block above them — Label is text-sm/leading-none (14px) + mb-1
                 (4px) = 18px — plus the input's own h-9 to centre against. At md
                 the grid is 2-across, so Status wraps onto a row of its own where
                 that offset would just be 18px of stray space. Measured both. */
              <div className="flex h-9 items-center justify-end gap-3 lg:mt-[18px]">
                <span className="text-sm font-medium">Status</span>
                <Switch checked={active} onCheckedChange={setActive} ariaLabel="Toggle user active" />
                <span
                  className={`text-xs w-16 inline-block text-left ${
                    active ? 'text-success-strong' : 'text-muted-foreground'
                  }`}
                >
                  {active ? 'Active' : 'Inactive'}
                </span>
              </div>
            ) : null}
          </div>

          {/* Row 2: Official Email | Personal Email | Role.
              Email is non-editable on edit (it keys OTP delivery). Role
              uses the shared SearchSelect so the dropdown matches every
              other typeahead in the form.
              Three columns on lg+; two on md (Role wraps below) so the
              Official Email field keeps enough width for its "@easyfix.in"
              affix plus the local-part input at narrower viewports. */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <Label className="block mb-1" required>
                Official Email
              </Label>
              {/* Add-mode: hardcode the @easyfix.in suffix as a non-editable
                  affix so operators can't accidentally type a foreign
                  domain. Only the local-part input round-trips into state.
                  Edit-mode: render the full email, disabled — we never
                  change OTP-keyed emails on existing users. */}
              {isEdit ? (
                <Input
                  type="email"
                  value={email}
                  disabled
                />
              ) : (
                <div className="flex items-stretch">
                  <Input
                    type="text"
                    value={email.endsWith('@easyfix.in')
                      ? email.slice(0, -'@easyfix.in'.length)
                      : email.replace(/@.*$/, '')}
                    onChange={(e) => {
                      const local = e.target.value.replace(/@.*/g, '').replace(/\s+/g, '').toLowerCase();
                      setEmail(local ? `${local}@easyfix.in` : '');
                    }}
                    placeholder="priya"
                    className="rounded-r-none"
                  />
                  <span className="inline-flex items-center px-3 rounded-r-md border border-l-0 border-input bg-muted text-sm text-muted-foreground select-none">
                    @easyfix.in
                  </span>
                </div>
              )}
              {/* Real-time DB uniqueness check — only on Add, only after
                  the value parses as an email. Suggestion chip lets the
                  operator adopt the next free <first>.<last>[<n>]@easyfix.in
                  slot with one click. Taker name is intentionally NOT
                  surfaced — exposes too much in a shared CRM. */}
              {!isEdit && emailCheck.state === 'checking' && (
                <p className="text-xs text-muted-foreground mt-1">Checking availability…</p>
              )}
              {!isEdit && emailCheck.state === 'available' && (
                <p className="text-xs text-success-strong mt-1">✓ Available</p>
              )}
              {!isEdit && emailCheck.state === 'taken' && (
                <div className="mt-1 space-y-1">
                  <p className="text-xs text-urgent-strong">
                    ✗ Already in use
                  </p>
                  {emailCheck.suggestion && (
                    <button
                      type="button"
                      className="text-xs text-primary hover:text-brand-600 underline underline-offset-2"
                      onClick={() => setEmail(emailCheck.suggestion!)}
                    >
                      Use suggestion: <span className="font-mono">{emailCheck.suggestion}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
            {/*
              * Personal Email — sits directly beside Official Email because the
              * two are read together: the official address is what the person
              * gets, the personal one is the only way to TELL them about it
              * before they can sign in.
              *
              * Editable on Edit as well as Add (unlike Official Email, which is
              * frozen because OTP delivery keys off it). Nothing keys off the
              * personal address, and the whole point of the column is that
              * existing users need theirs filled in.
              */}
            <div>
              <Label className="block mb-1" required={personalEmailRequired}>
                Personal Email{' '}
                {!personalEmailRequired && (
                  <span className="text-xs text-muted-foreground font-normal">(optional)</span>
                )}
              </Label>
              <Input
                type="email"
                value={personalEmail}
                onChange={(e) => setPersonalEmail(e.target.value.replace(/\s+/g, ''))}
                placeholder="e.g. priya.sharma@gmail.com"
              />
              {/* Inline format hint only — the blocking check lives in
                  handleSubmit so every validation message surfaces in one
                  place (the footer), where it can't scroll out of view. */}
              {personalEmail.trim() && !EMAIL_RE.test(personalEmail.trim()) && (
                <p className="text-xs text-warning-strong mt-1">That doesn&apos;t look like a valid email address.</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {isEdit
                  ? 'A non-company address, used to reach this user when their official inbox is unavailable.'
                  : 'Sign-in details are emailed here — the new user cannot read their official inbox yet.'}
              </p>
            </div>
            <div>
              <Label className="block mb-1" required>Role</Label>
              <SearchSelect
                value={roleId === '' ? '' : roleId}
                onChange={(v) => setRoleId(v ? Number(v) : '')}
                options={roles.map((r) => ({ value: r.role_id, label: r.role_name }))}
                placeholder="Search and select a role…"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              {/* No `required` — mobile became optional 2026-08-03. The
                  10-digit format is still enforced when one IS supplied. */}
              <Label className="block mb-1">Mobile</Label>
              <Input
                value={mobile}
                onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="10-digit number (optional)"
                className="font-mono"
              />
              {mobile && !INDIAN_MOBILE_REGEX.test(mobile) && (
                <p className="text-xs text-warning-strong mt-1">
                  {mobile.length !== 10
                    ? `Mobile must be exactly 10 digits (${mobile.length}/10).`
                    : INDIAN_MOBILE_ERROR}
                </p>
              )}
              {/* Real-time DB uniqueness check — only renders for a complete
                  10-digit number that actually differs from the user being
                  edited. Sub-second feel via 450ms debounce + in-memory
                  cache; the form submit is blocked while taken (see
                  handleSubmit guard below). */}
              {mobile.length === 10 && mobileCheck.state === 'checking' && (
                <p className="text-xs text-muted-foreground mt-1">Checking availability…</p>
              )}
              {mobile.length === 10 && mobileCheck.state === 'available' && (
                <p className="text-xs text-success-strong mt-1">✓ Available</p>
              )}
              {mobile.length === 10 && mobileCheck.state === 'taken' && (
                <p className="text-xs text-urgent-strong mt-1">
                  ✗ Already in use{mobileCheck.takenByName ? ` by ${mobileCheck.takenByName}` : ' by another active user'}.
                </p>
              )}
            </div>
            <div>
              <Label className="block mb-1">Alternate Mobile</Label>
              <Input
                value={altMob}
                onChange={(e) => setAltMob(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="optional"
                className="font-mono"
              />
              {altMob && altMob.length !== 10 && (
                <p className="text-xs text-warning-strong mt-1">If supplied, alt mobile must be 10 digits.</p>
              )}
            </div>
          </div>

          {/*
            * ── PERSONAL DETAILS (HR MASTER DATA) ─────────────────────────
            * Every field here is OPTIONAL and every one is stored on
            * tbl_user_personal_details, never on tbl_user. HR fills them in
            * from the master sheet as it is reconciled, a few people at a
            * time — which is why there is no bulk import behind this and why
            * nothing on the form blocks a save when they are empty.
            *
            * Date Of Joining also feeds the dashboard's Upcoming Events rail
            * (Work Anniversary), the same way Date Of Birth already feeds
            * Birthday. That is the only place any of this is read outside the
            * user's own profile page.
            */}
          <div className="rounded-md border border-border p-3 space-y-3">
            <p className="text-sm font-medium">
              Personal Details{' '}
              <span className="text-xs text-muted-foreground font-normal">(optional)</span>
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="block mb-1">Date Of Joining</Label>
                <Input
                  type="date"
                  value={doj}
                  onChange={(e) => setDoj(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Shows as a Work Anniversary on the dashboard each year.
                </p>
              </div>
              <div>
                <Label className="block mb-1">UAN</Label>
                <Input
                  value={uan}
                  onChange={(e) => setUan(e.target.value.replace(/\D/g, '').slice(0, 12))}
                  placeholder="12-digit EPFO number"
                  className="font-mono"
                />
                {uan && uan.length !== 12 && (
                  <p className="text-xs text-warning-strong mt-1">
                    UAN must be exactly 12 digits ({uan.length}/12).
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="block mb-1">PAN</Label>
                <Input
                  value={pan}
                  onChange={(e) => setPan(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))}
                  placeholder={userDetail.data?.pan_masked ? 'Type to replace' : 'e.g. ABCDE1234F'}
                  className="font-mono"
                />
                {/* The stored value, masked. It is shown as TEXT rather than
                    prefilled into the box precisely so that saving without
                    touching this field leaves the real PAN alone. */}
                {userDetail.data?.pan_masked && !pan && (
                  <p className="text-xs text-muted-foreground mt-1">
                    On file: <span className="font-mono">{userDetail.data.pan_masked}</span>
                  </p>
                )}
                {pan && !PAN_RE.test(pan) && (
                  <p className="text-xs text-warning-strong mt-1">
                    PAN is 5 letters, 4 digits, then a letter — e.g. ABCDE1234F.
                  </p>
                )}
              </div>
              <div>
                <Label className="block mb-1">Aadhaar</Label>
                <Input
                  value={aadhaar}
                  onChange={(e) => setAadhaar(e.target.value.replace(/\D/g, '').slice(0, 12))}
                  placeholder={userDetail.data?.aadhaar_masked ? 'Type to replace' : '12 digits'}
                  className="font-mono"
                />
                {userDetail.data?.aadhaar_masked && !aadhaar && (
                  <p className="text-xs text-muted-foreground mt-1">
                    On file: <span className="font-mono">{userDetail.data.aadhaar_masked}</span>
                  </p>
                )}
                {aadhaar && aadhaar.length !== 12 && (
                  <p className="text-xs text-warning-strong mt-1">
                    Aadhaar must be exactly 12 digits ({aadhaar.length}/12).
                  </p>
                )}
              </div>
            </div>

            <div>
              <Label className="block mb-1">Address</Label>
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value.slice(0, 512))}
                placeholder="Home address (optional)"
              />
              <p className="text-xs text-muted-foreground mt-1">
                The user&apos;s own address. Separate from the city and state
                on their account, which say where they are posted.
              </p>
            </div>
          </div>

          {/* Role helper text — kept under the Email | Role row above
              (instead of inside the picker block) so the grid stays
              clean. Backend rejects role+group mismatches; this hint
              tells operators what to expect if a combo fails. */}
          <p className="text-xs text-muted-foreground -mt-1">
            Every active role is listed. Backend will reject combos that aren&apos;t allowed for the user&apos;s group.
          </p>

          {/*
            * Multi-select scope fields — Cities / Clients / States / Verticals.
            *
            * REFACTORED: previously each field rendered its own search box,
            * a chips-row ABOVE the scrollable list, then the list itself.
            * That layout pushed selected chips into the reading flow before
            * the operator finished selecting, made tall sections in the
            * form (4 × 36-line lists = a lot of scrolling), and duplicated
            * the same search/clear logic four times.
            *
            * Now: each field renders a single `SearchMultiSelect` trigger
            * (matches the look of other dropdowns in the form) and chips
            * appear BELOW it once selected. The popover's internal
            * filter + "select all / clear" footer replaces the old
            * inline Input + bulk action row.
            *
            * Layout: two columns on md+ so the four scopes fit on one
            * screen without a long vertical scroll. Falls back to a
            * single column on narrow viewports.
            */}
          {/*
            * Layout:
            *   Row 1: Verticals | Clients
            *   Row 2: Manage Regions (writes manage_states)
            * Clients sit immediately to the right of their parent
            * (Verticals) so the cascade direction is visually obvious —
            * Clients options are filtered to selected Verticals; see
            * `applyManageVerticals` for the prune-on-remove rules.
            * Cities were removed: the form collects Regions only and
            * always persists manage_cities='0' (see handleSubmit).
            */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Verticals — parent of Clients */}
            <ScopeMultiSelect
              label="Manages Verticals"
              chipColor="amber"
              selected={manageVerticals}
              onChange={(next) => applyManageVerticals(new Set(next as number[]))}
              options={verticals.map((v) => ({ value: v.vertical_id, label: v.vertical_name }))}
              chipFor={(id) => verticals.find((x) => x.vertical_id === id)?.vertical_name}
              onRemoveOne={toggleManageVertical}
              placeholder="Select verticals…"
              selectedLabel="verticals"
              allOn={verticalsAll}
              onAllChange={(b) => {
                setVerticalsAll(b);
                // Clear the picked set on EITHER direction. Toggling
                // On: chips would be stale under "All". Toggling Off:
                // operator wants a clean slate to re-pick — they
                // explicitly unchecked "All", so any previously-loaded
                // chips are no longer relevant.
                setManageVerticals(new Set());
                // Reset Clients-All AND clear the client set so the
                // operator re-affirms client scope against the new
                // vertical universe (the "client mandatory after
                // vertical change" rule).
                setClientsAll(false);
                setManageClients(new Set());
              }}
            />

            {/* Clients — filtered by selected Verticals */}
            <ScopeMultiSelect
              label="Manages Clients"
              chipColor="emerald"
              selected={manageClients}
              onChange={(next) => setManageClients(new Set(next as number[]))}
              options={filteredClientOptions}
              chipFor={(id) => clients.find((x) => x.client_id === id)?.client_name}
              onRemoveOne={toggleManageClient}
              placeholder="Select clients…"
              selectedLabel="clients"
              helperText={
                !verticalsAll && manageVerticals.size === 0
                  ? 'Pick at least one vertical above (or toggle All) to choose clients.'
                  : undefined
              }
              allOn={clientsAll}
              onAllChange={(b) => {
                setClientsAll(b);
                // Always clear chips on either direction — matches the
                // Verticals toggle behavior. Operator expects a clean
                // state when unchecking All so they can re-pick from
                // scratch.
                setManageClients(new Set());
              }}
              // Locked until a Vertical (or Verticals-All) is picked.
              disableAll={!verticalsAll && manageVerticals.size === 0}
            />

            {/* Regions — writes tbl_user.manage_states underneath. Only the
                labels change; the field still serialises manage_states. */}
            <ScopeMultiSelect
              label="Manage Regions"
              chipColor="violet"
              selected={manageStates}
              onChange={(next) => applyManageStates(new Set(next as number[]))}
              options={states.map((s) => ({ value: s.state_id, label: s.state_name }))}
              chipFor={(id) => states.find((x) => x.state_id === id)?.state_name}
              onRemoveOne={toggleManageState}
              placeholder="All Regions"
              selectedLabel="regions"
              allOn={statesAll}
              onAllChange={(b) => {
                setStatesAll(b);
                // Toggling either direction clears the region set so the
                // operator gets a clean slate to re-pick.
                setManageStates(new Set());
              }}
            />

            {/*
              * Job Stage Access — restrict the user to a subset of job
              * lifecycle STAGES. "All" ON = unrestricted (saved as null); OFF
              * with nothing picked = no access (saved as []). Sits alongside
              * the geo/vertical scopes because it's the same class of
              * row-visibility control.
              */}
            <ScopeMultiSelect<string>
              label="Job Stage Access"
              chipColor="blue"
              selected={allowedStages}
              onChange={(next) => setAllowedStages(new Set(next as string[]))}
              options={STAGE_OPTIONS}
              chipFor={(key) => STAGES[key as keyof typeof STAGES]?.label}
              onRemoveOne={toggleStage}
              placeholder="Select stages…"
              selectedLabel="stages"
              helperText="Which lifecycle stages this user can see and act on. All on = unrestricted. All off with nothing selected = no access to any job."
              allOn={stagesAll}
              onAllChange={(b) => {
                setStagesAll(b);
                // Clear the pick set on either direction — matches the geo
                // scopes. All-ON hides the picker; All-OFF gives a clean
                // slate, and saving from there (no picks) means NO ACCESS.
                setAllowedStages(new Set());
              }}
            />
          </div>

          {/*
            * Reporting Manager + Home City — both single-select. Side
            * by side so the identity-graph metadata clusters together.
            *
            * Reporting Manager drives the hierarchy DFS for scope-union
            * (on login, the user's own scope is merged with every
            * direct/indirect report's manage_* fields). Self-assignment
            * is blocked at the UI layer (`adminUsers` filtered to
            * exclude the current user); backend also catches transitive
            * cycles.
            *
            * Home City (tbl_user.city_id) is a new-app addition — not
            * in the legacy form but the column has existed for years
            * and other surfaces key off it.
            *
            * Both fields share the SearchSelect component so the
            * "(optional)" label, picker UI, and clear affordance all
            * stay identical. The clear-X inside SearchSelect replaces
            * the prior bespoke "Selected: X | clear" line below each
            * field.
            */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label className="block mb-1">
                Reporting Manager <span className="text-xs text-muted-foreground font-normal">(optional)</span>
              </Label>
              <SearchSelect
                value={reportingManager === '' ? '' : reportingManager}
                onChange={(v) => setReportingManager(v ? Number(v) : '')}
                options={adminUsers
                  .filter((u) => !editing || u.user_id !== editing.user_id)
                  .map((u) => ({
                    value: u.user_id,
                    label: u.role_name ? `${u.user_name} · ${u.role_name}` : u.user_name,
                  }))}
                placeholder="Search by name or role…"
              />
            </div>
            <div>
              <Label className="block mb-1">
                Home City <span className="text-xs text-muted-foreground font-normal">(optional)</span>
              </Label>
              <SearchSelect
                value={cityId === '' ? '' : cityId}
                onChange={(v) => setCityId(v ? Number(v) : '')}
                options={cities.map((c) => ({ value: c.city_id, label: c.city_name }))}
                placeholder="Search cities…"
              />
            </div>
          </div>

          {/* Status toggle previously lived here at the bottom of the
              form; moved to row 1 (alongside Full Name) so the
              identity-level metadata clusters together. */}

        </div>
        {/*
          * The validation error lives in the FOOTER, beside the button that
          * triggers it — NOT at the end of the form body where it used to be.
          *
          * The body scrolls and the footer is sticky, so a message rendered at
          * the bottom of the body was below the fold: clicking "Add User" with
          * an empty Role set the error, the submit correctly aborted, and the
          * operator saw NOTHING happen. That reads as a dead button, which is
          * exactly how it was reported. An error the user cannot see is the
          * same as no validation at all.
          *
          * `flex-1 text-left` claims the space DialogFooter would otherwise
          * leave empty on the left, so the buttons stay where they were.
          */}
        <DialogFooter className="shrink-0">
          {error && (
            <div className="flex-1 text-left text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4 shrink-0" /> {error}
            </div>
          )}
          <Button variant="outline" onClick={cancelWithConfirm} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add User'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Small helper that pairs a `SearchMultiSelect` picker with a row of
 * removable chips below it. Used for the 4 scope fields (Cities,
 * Clients, States, Verticals) inside the User modal — keeps each field
 * compact (one trigger + a wrap of chips) instead of four duplicated
 * search-list-chips blocks.
 *
 * The chip color is a theme prop so each scope keeps its identity
 * (blue cities, emerald clients, violet states, amber verticals).
 */
type ChipColor = 'blue' | 'emerald' | 'violet' | 'amber';
const CHIP_CLASSES: Record<ChipColor, { bg: string; text: string; closeHover: string }> = {
  blue:    { bg: 'bg-info-tint',    text: 'text-info-strong',    closeHover: 'hover:text-info-deep' },
  emerald: { bg: 'bg-success-tint', text: 'text-success-strong', closeHover: 'hover:text-ink-900' },
  violet:  { bg: 'bg-gold-tint',  text: 'text-gold-strong',  closeHover: 'hover:text-ink-900' },
  amber:   { bg: 'bg-warning-tint',   text: 'text-warning-strong',   closeHover: 'hover:text-ink-900' },
};

function ScopeMultiSelect<V extends string | number>({
  label,
  chipColor,
  selected,
  onChange,
  options,
  chipFor,
  onRemoveOne,
  placeholder,
  selectedLabel,
  helperText,
  allOn,
  onAllChange,
  disableAll,
}: {
  label: string;
  chipColor: ChipColor;
  /*
   * Selected value set. Generic over `V extends string | number` so the same
   * picker drives both the numeric-id scopes (cities / clients / states /
   * verticals) and the string-keyed Job Stage Access field (STAGE_KEYS).
   */
  selected: Set<V>;
  onChange: (next: Array<string | number>) => void;
  options: SearchOption[];
  chipFor: (id: V) => string | undefined;
  onRemoveOne: (id: V) => void;
  placeholder: string;
  selectedLabel: string;
  /*
   * Optional muted hint rendered between the trigger and the chips.
   * Used by cascaded pickers (Clients depends on Verticals, Cities
   * depends on States) to explain why the option list is empty.
   */
  helperText?: string;
  /*
   * Optional "All" toggle. When ON, the multi-select is disabled and
   * the parent persists '0' as the CSV (legacy "manage_*='0'" sentinel,
   * see lib/scope.js). Caller controls the boolean — keeps the picker
   * stateless so a single source of truth (the form state) governs
   * what gets saved.
   *
   * `disableAll` mutes the All checkbox itself — used by dependent
   * pickers (Clients gated by Verticals, Cities gated by States) so
   * operators can't store child=0 under an empty parent scope.
   */
  allOn?: boolean;
  onAllChange?: (b: boolean) => void;
  disableAll?: boolean;
}) {
  const cls = CHIP_CLASSES[chipColor];
  return (
    <div>
      <label className="text-sm font-medium flex items-center justify-between mb-1">
        <span>
          {label}{' '}
          <span className="text-xs text-muted-foreground font-normal">
            ({allOn ? 'All' : `${selected.size} selected`})
          </span>
        </span>
        {onAllChange && (
          <label className={`inline-flex items-center gap-1.5 text-xs font-normal cursor-pointer ${disableAll ? 'opacity-50 cursor-not-allowed' : 'text-muted-foreground'}`}>
            <input
              type="checkbox"
              checked={!!allOn}
              onChange={(e) => onAllChange(e.target.checked)}
              disabled={!!disableAll}
            />
            All
          </label>
        )}
      </label>
      <SearchMultiSelect
        value={allOn ? [] : Array.from(selected)}
        onChange={onChange}
        options={options}
        placeholder={allOn ? 'All — every active record' : placeholder}
        selectedLabel={selectedLabel}
        disabled={!!allOn}
      />
      {helperText && (
        <p className="text-xs text-muted-foreground mt-1">{helperText}</p>
      )}
      {!allOn && selected.size > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {Array.from(selected).map((id) => {
            const name = chipFor(id);
            if (!name) return null;
            return (
              <span
                key={id}
                className={`text-xs rounded px-1.5 py-0.5 ${cls.bg} ${cls.text}`}
              >
                {name}
                <button
                  type="button"
                  className={`ml-1 opacity-60 ${cls.closeHover}`}
                  onClick={() => onRemoveOne(id)}
                  aria-label={`Remove ${name}`}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}


