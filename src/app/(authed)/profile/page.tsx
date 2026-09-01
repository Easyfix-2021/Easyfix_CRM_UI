'use client';
/*
 * My Profile — the operator's own record.
 *
 * Reached by clicking your own name in the navbar. Started life as a small
 * "Effective Access" dropdown showing four scope counts; became a full record
 * page; now also the one place a user can correct their own details.
 *
 * ─── LAYOUT: ONE RECORD, NOT SIX CARDS ──────────────────────────────────────
 * The previous version was a hero plus five Section cards in a 2-column grid,
 * every card the same size and weight, so nothing said where to look. This is
 * a single vertical read instead:
 *
 *   1. Identity band   — the one focal element. Who you are, at a glance.
 *   2. Pending banner  — only when a request is open. Placed above everything
 *                        it affects, because withdrawing is all-or-nothing.
 *   3. Personal & Contact Details — the editable rows, the reason to be here.
 *   4. Bank Details    — editable as a group (one approval covers all four).
 *   5. Access & Permissions — read-only reference, deliberately quiet: muted
 *                        surface, smaller type, three compact columns. It is
 *                        what you check once a quarter, not what you came for.
 *
 * Fields are definition-list rows, not cards. A column of labels is scannable;
 * a grid of same-weight boxes is a search.
 *
 * ─── THREE EDIT MODES, EACH SAID IN WORDS BEFORE THE CLICK ──────────────────
 *   Alternate Number  — inline. Saves immediately, no approval (PATCH).
 *   Date Of Birth     — free to set ONCE while blank (POST .../date-of-birth);
 *                       locked afterwards, and then it takes a request. Which
 *                       state the field is in is stated on the row.
 *   Mobile / Bank     — always a Profile Update Request. Nothing on the record
 *                       moves until HR approves.
 *
 * Everything else — role, scope, hierarchy, feature grants — stays read-only.
 *
 * ─── STILL NOT PERMISSION-GATED, ON PURPOSE ─────────────────────────────────
 * Every other new CRM page is RBAC-gated with a seeded menu + action. This one
 * is not, and must not be: it is self-service, and a permission key would mean
 * an operator whose role omitted it could not see or correct their own record.
 * It gets no sidebar entry either; it is reached only from your own name.
 *
 * ─── DATA ───────────────────────────────────────────────────────────────────
 * useMe() for identity/role/scope/hierarchy (already hydrated — no request),
 * plus ONE call to GET /api/profile/details for the HRMS fields. useFetchOnce
 * rather than useFetch on purpose: it subscribes to invalidateFetch, so a save
 * anywhere on this page refreshes the record without a manual refetch wire.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Mail, ShieldCheck, Users, Layers, Landmark, IdCard, Pencil } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BackLink } from '@/components/ui/back-link';
import { StatusChip } from '@/components/ui/StatusChip';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetchOnce, invalidateFetch } from '@/lib/hooks';
import { useMe, type ScopeDimension } from '@/lib/auth-context';
import {
  ProfileRow, PendingBanner, PendingFieldNote, RequestChangeDialog,
  pendingItems, fmtDate, dobError, dobMin, dobMax,
  PHONE_RE, PHONE_ERROR,
  type ProfileDetails, type RequestableField,
} from '@/components/profile/ProfileFields';

/* Same rule as the client and technician headers: first + last initial. */
function initialsOf(name?: string | null): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* Section shell. One heading, one hairline, then rows — no nested card
 * chrome, so the sections read as parts of one document. */
function Section({
  title, icon, action, children, muted,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <Card className={muted ? 'bg-muted/30' : undefined}>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-muted-foreground">{icon}</span>
          <h3 className="text-sm font-semibold">{title}</h3>
          {action && <div className="ml-auto">{action}</div>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/* Loading placeholder — the app's convention is inline pulse blocks, there is
 * no Skeleton component in this codebase. */
function PulseRows({ n = 4 }: { n?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="h-3 w-32 rounded bg-muted animate-pulse" />
          <div className="h-3 flex-1 rounded bg-muted animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/* Compact label/value pair for the quiet Access section. */
function MiniStat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xs font-medium text-right ${tone ?? ''}`}>{value}</span>
    </div>
  );
}

/*
 * One scope dimension. 'none' is highlighted rather than shown as a quiet zero
 * because it almost always means the operator's manage_* column is mis-seeded —
 * which is the whole reason the original dropdown existed.
 */
function scopeValue(dim?: ScopeDimension): { text: ReactNode; tone?: string } {
  if (!dim) return { text: 'All' };
  if (dim.mode === 'allow') return { text: dim.ids.length };
  if (dim.mode === 'none') return { text: 'None', tone: 'text-warning-strong' };
  return { text: 'All' };
}

export default function MyProfilePage() {
  const { me, loading: meLoading, refresh } = useMe();
  const confirm = useConfirm();
  const user = me?.user;
  const active = Number(user?.user_status ?? 1) === 1;

  const { data: details, loading: detailsLoading, error: detailsError } =
    useFetchOnce<ProfileDetails>('/profile/details');

  /* Which field's approval dialog is open, if any. */
  const [requestField, setRequestField] = useState<RequestableField | null>(null);

  /* Alternate Number — inline editor. */
  const [editingAlt, setEditingAlt] = useState(false);
  const [altDraft, setAltDraft] = useState('');
  const [savingAlt, setSavingAlt] = useState(false);

  /* Date Of Birth — the one free set, while it is still blank. */
  const [dobDraft, setDobDraft] = useState('');
  const [savingDob, setSavingDob] = useState(false);

  const [withdrawing, setWithdrawing] = useState(false);

  const pending = details?.pending ?? null;
  const changes = pending?.changes;
  const allPending = pendingItems(changes);
  /* Labels of the OTHER fields in the same request — repeated on each field
   * note so the blast radius of "Withdraw" is never a surprise. */
  const othersFor = (key: RequestableField) =>
    allPending.filter((it) => it.key !== key).map((it) => it.label);

  /* ── Alternate Number — direct write, no approval ───────────────────── */
  const altValid = altDraft === '' || PHONE_RE.test(altDraft);
  async function saveAlternate() {
    if (!altValid || savingAlt) return;
    setSavingAlt(true);
    try {
      await api.patch('/profile/alternate-no', { alternate_no: altDraft });
      /* Written to tbl_user, so /auth/me is stale too — refresh both caches. */
      invalidateFetch((k) => k.startsWith('/profile'));
      await refresh();
      showToast({ variant: 'success', message: 'Alternate number saved.' });
      setEditingAlt(false);
    } catch (e) {
      showToast({
        variant: 'error',
        message: e instanceof ApiError ? e.message : 'Could not save the alternate number.',
      });
    } finally {
      setSavingAlt(false);
    }
  }

  /* ── Date Of Birth — the single self-service set ────────────────────── */
  const dobDraftError = dobDraft.length > 0 ? dobError(dobDraft) : null;
  async function saveDobOnce() {
    if (savingDob || dobDraft.length === 0 || dobDraftError) return;
    setSavingDob(true);
    try {
      await api.post('/profile/date-of-birth', { date_of_birth: dobDraft });
      invalidateFetch((k) => k.startsWith('/profile'));
      showToast({ variant: 'success', message: 'Date of birth saved. It is locked now — further changes need HR approval.' });
      setDobDraft('');
    } catch (e) {
      /* 409 = it was set in the meantime (a second tab). Say so and let the
       * refetch flip the row into its locked, request-only state. */
      if (e instanceof ApiError && e.status === 409) {
        invalidateFetch((k) => k.startsWith('/profile'));
        showToast({
          variant: 'warning',
          message: 'Your date of birth is already set. Raise a change request to correct it.',
        });
      } else {
        showToast({
          variant: 'error',
          message: e instanceof ApiError ? e.message : 'Could not save the date of birth.',
        });
      }
    } finally {
      setSavingDob(false);
    }
  }

  /* ── Withdraw — all-or-nothing, so the confirm names everything ─────── */
  async function withdraw() {
    if (!pending || withdrawing) return;
    const ok = await confirm({
      title: 'Withdraw Profile Update Request?',
      variant: 'destructive',
      confirmLabel: 'Withdraw Request',
      cancelLabel: 'Keep Request',
      description: (
        <div className="space-y-2">
          <p>
            {allPending.length === 1
              ? 'This cancels the change waiting for HR:'
              : `This cancels the whole request — all ${allPending.length} changes waiting for HR, not just one:`}
          </p>
          <ul className="space-y-1">
            {allPending.map((it) => (
              <li key={it.key} className="text-xs flex flex-wrap gap-x-2">
                <span className="text-muted-foreground w-32 shrink-0">{it.label}</span>
                <span className="font-medium break-all">{it.text}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs">Your record stays as it is. You can raise a new request any time.</p>
        </div>
      ),
    });
    if (!ok) return;
    setWithdrawing(true);
    try {
      await api.delete(`/profile/update-requests/${pending.request_id}`);
      invalidateFetch((k) => k.startsWith('/profile'));
      showToast({ variant: 'success', message: 'Request withdrawn. Nothing on your record changed.' });
    } catch (e) {
      showToast({
        variant: 'error',
        message: e instanceof ApiError ? e.message : 'Could not withdraw the request — please retry.',
      });
    } finally {
      setWithdrawing(false);
    }
  }

  /*
   * mode 'list' with an EMPTY stages array is a real grant meaning NO stages —
   * not a synonym for unrestricted. Rendering it as "All Stages" would tell an
   * operator the opposite of their actual access.
   */
  const stages = me?.allowedStages;
  const stageLabel = !stages || stages.mode === 'all'
    ? 'All Stages'
    : (stages.stages.length ? stages.stages.join(', ') : 'None');

  const bank = details?.bank;
  const hasBank = !!(bank && (bank.account_number || bank.ifsc || bank.account_name || bank.bank_name));
  const bankPending = changes?.bank !== undefined;
  const mobilePending = changes?.mobile_no !== undefined;
  const dobPending = changes?.date_of_birth !== undefined;

  /* Employee code lives on tbl_user (useMe) and is echoed by /profile/details;
   * prefer the record fetch, fall back to the session payload. */
  const empCode = details?.user_code ?? user?.user_code;

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-4xl">
      <BackLink fallback="/dashboard" />

      {/* ═══ 1. Identity band — the page's one focal element ═════════════ */}
      <Card className="overflow-hidden">
        <div className="bg-gradient-to-br from-primary/10 via-card to-card p-5 sm:p-6">
          <div className="flex items-start gap-4 flex-wrap">
            <span
              aria-hidden
              className="size-16 shrink-0 rounded-2xl bg-primary/10 text-primary font-semibold flex items-center justify-center text-xl"
            >
              {initialsOf(user?.user_name)}
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-semibold truncate">
                {meLoading ? 'Loading…' : (user?.user_name ?? '—')}
              </h1>
              <div className="flex items-center gap-2 flex-wrap mt-2">
                {user && (
                  <StatusChip tone={active ? 'success' : 'neutral'} size="sm">
                    {active ? 'Active' : 'Inactive'}
                  </StatusChip>
                )}
                {me?.role?.role_name && (
                  <StatusChip tone="info" size="sm">{me.role.role_name}</StatusChip>
                )}
                {allPending.length > 0 && (
                  <StatusChip tone="warning" size="sm">
                    {allPending.length} Awaiting Approval
                  </StatusChip>
                )}
              </div>
            </div>
          </div>

          {/* At-a-glance identity facts, inline rather than in their own card. */}
          <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-4 border-t border-border/60 pt-4">
            <div>
              <div className="text-xs text-muted-foreground">Employee Code</div>
              <div className={`text-sm font-mono mt-0.5 ${empCode ? '' : 'text-muted-foreground'}`}>
                {detailsLoading && !empCode
                  ? <span className="block h-4 w-20 rounded bg-muted animate-pulse" />
                  : (empCode || '—')}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">User ID</div>
              <div className="text-sm font-mono mt-0.5">{user?.user_id ?? '—'}</div>
            </div>
            <div className="col-span-2 sm:col-span-1 min-w-0">
              <div className="text-xs text-muted-foreground">Official Email</div>
              <div className="text-sm mt-0.5 break-words">{user?.official_email || '—'}</div>
            </div>
          </div>
        </div>
      </Card>

      {/* ═══ 2. Pending request — stated once, above everything it covers ═ */}
      {pending && (
        <PendingBanner pending={pending} onWithdraw={withdraw} withdrawing={withdrawing} />
      )}

      {detailsError && (
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-destructive">{detailsError}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Your identity and access below are still accurate — only the editable details
              failed to load. Reload the page to try again.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ═══ 3. Personal & Contact Details ═══════════════════════════════ */}
      <Section title="Personal & Contact Details" icon={<Mail className="size-4" />}>
        {detailsLoading ? <PulseRows n={5} /> : (
          <div>
            <ProfileRow label="Official Email" value={user?.official_email} />
            <ProfileRow label="Personal Email" value={details?.personal_email} />

            {/* Mobile Number — approval only. */}
            <ProfileRow
              label="Mobile Number"
              value={details?.mobile_no ?? user?.mobile_no}
              mono
              hint={mobilePending ? undefined : 'A change here needs HR approval before it takes effect.'}
              action={details && (
                <Button variant="outline" size="sm" onClick={() => setRequestField('mobile_no')}>
                  {mobilePending ? 'Revise Request' : 'Request Change'}
                </Button>
              )}
            >
              {mobilePending && (
                <PendingFieldNote
                  text={String(changes?.mobile_no)}
                  alsoCovers={othersFor('mobile_no')}
                />
              )}
            </ProfileRow>

            {/* Alternate Number — inline, immediate. */}
            <ProfileRow
              label="Alternate Number"
              value={details?.alternate_no ?? user?.alternate_no}
              hideValue={editingAlt}
              mono
              hint={editingAlt ? undefined : 'You can change this yourself — it saves straight away, no approval needed.'}
              action={!editingAlt && details && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAltDraft(String(details?.alternate_no ?? ''));
                    setEditingAlt(true);
                  }}
                >
                  <Pencil className="size-3.5 mr-1.5" /> Edit
                </Button>
              )}
            >
              {editingAlt && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor="pf-alt" className="sr-only">Alternate Number</Label>
                    <Input
                      id="pf-alt"
                      value={altDraft}
                      onChange={(e) => setAltDraft(e.target.value.replace(/\D/g, '').slice(0, 10))}
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="10-digit number"
                      className="font-mono w-48"
                      autoFocus
                    />
                    <Button size="sm" onClick={saveAlternate} disabled={!altValid || savingAlt}>
                      {savingAlt ? 'Saving…' : 'Save'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingAlt(false)}
                      disabled={savingAlt}
                    >
                      Cancel
                    </Button>
                  </div>
                  {!altValid && <p className="text-xs text-destructive">{PHONE_ERROR}</p>}
                  <p className="text-xs text-muted-foreground">
                    Saves straight away, no approval needed. Leave it empty to remove the number.
                  </p>
                </div>
              )}
            </ProfileRow>

            {/* Date Of Birth — three states, each named on the row. */}
            <ProfileRow
              label="Date Of Birth"
              value={
                details?.date_of_birth
                  ? (
                    <span className="inline-flex items-center gap-2 flex-wrap">
                      {fmtDate(details.date_of_birth)}
                      {details.dob_locked && <StatusChip tone="neutral" size="sm">Locked</StatusChip>}
                    </span>
                  )
                  : undefined
              }
              hint={
                dobPending ? undefined
                  : (!details?.date_of_birth && !details?.dob_locked)
                    ? 'Not set yet. You can set it once yourself — after that it is locked and any correction needs HR approval.'
                    : 'Set and locked. A correction needs HR approval before it takes effect.'
              }
              action={
                details && (dobPending || details.date_of_birth || details.dob_locked) ? (
                  <Button variant="outline" size="sm" onClick={() => setRequestField('date_of_birth')}>
                    {dobPending ? 'Revise Request' : 'Request Change'}
                  </Button>
                ) : undefined
              }
            >
              {dobPending && (
                <PendingFieldNote
                  text={fmtDate(changes?.date_of_birth)}
                  alsoCovers={othersFor('date_of_birth')}
                />
              )}
              {details && !dobPending && !details.date_of_birth && !details.dob_locked && (
                <div className="mt-2 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor="pf-dob-once" className="sr-only">Date Of Birth</Label>
                    <Input
                      id="pf-dob-once"
                      type="date"
                      value={dobDraft}
                      min={dobMin()}
                      max={dobMax()}
                      onChange={(e) => setDobDraft(e.target.value)}
                      className="w-48"
                    />
                    <Button
                      size="sm"
                      onClick={saveDobOnce}
                      disabled={savingDob || dobDraft.length === 0 || !!dobDraftError}
                    >
                      {savingDob ? 'Saving…' : 'Set Date Of Birth'}
                    </Button>
                  </div>
                  {dobDraftError && <p className="text-xs text-destructive">{dobDraftError}</p>}
                </div>
              )}
            </ProfileRow>
          </div>
        )}
      </Section>

      {/* ═══ 4. Bank Details — one approval covers all four values ═══════ */}
      <Section
        title="Bank Details"
        icon={<Landmark className="size-4" />}
        action={details && (
          <Button variant="outline" size="sm" onClick={() => setRequestField('bank')}>
            {bankPending ? 'Revise Request' : hasBank ? 'Request Change' : 'Add Bank Details'}
          </Button>
        )}
      >
        {detailsLoading ? <PulseRows n={4} /> : (
          <div>
            <ProfileRow label="Account Holder Name" value={bank?.account_name} />
            <ProfileRow label="Account Number" value={bank?.account_number} mono />
            <ProfileRow label="IFSC Code" value={bank?.ifsc} mono />
            <ProfileRow label="Bank Name" value={bank?.bank_name} />
            {bankPending ? (
              <PendingFieldNote
                text={pendingItems(changes).find((i) => i.key === 'bank')?.text ?? '—'}
                alsoCovers={othersFor('bank')}
              />
            ) : (
              <p className="text-xs text-muted-foreground pt-3">
                {hasBank
                  ? 'All four values change together, and only after HR approves.'
                  : 'No bank details on record. Adding them raises a request for HR to approve.'}
              </p>
            )}
          </div>
        )}
      </Section>

      {/* ═══ 5. Access & Permissions — read-only, deliberately quiet ═════ */}
      <Section title="Access & Permissions" icon={<ShieldCheck className="size-4" />} muted>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
          <div>
            <div className="text-xs font-semibold mb-1.5 flex items-center gap-1.5">
              <Layers className="size-3.5 text-muted-foreground" /> Record Scope
            </div>
            {!me?.scope ? (
              <p className="text-xs text-muted-foreground">
                All records — your role bypasses row-level scope.
              </p>
            ) : (
              <div className="divide-y divide-border/60">
                {([
                  ['Clients', me.scope.clients],
                  ['Cities', me.scope.cities],
                  ['States', me.scope.states],
                  ['Verticals', me.scope.verticals],
                ] as Array<[string, ScopeDimension]>).map(([label, dim]) => {
                  const v = scopeValue(dim);
                  return <MiniStat key={label} label={label} value={v.text} tone={v.tone} />;
                })}
              </div>
            )}
          </div>

          <div>
            <div className="text-xs font-semibold mb-1.5 flex items-center gap-1.5">
              <Users className="size-3.5 text-muted-foreground" /> Reporting
            </div>
            <div className="divide-y divide-border/60">
              <MiniStat label="Direct Reports" value={me?.hierarchy?.directReportsCount ?? 0} />
              <MiniStat label="Downstream Reports" value={me?.hierarchy?.descendantsCount ?? 0} />
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Records belonging to anyone below you in the reporting tree are included in your scope.
            </p>
          </div>

          {/*
            * Three grants that sit OUTSIDE the menu/role pipeline and had no
            * surface anywhere in the CRM until this page — the reason "why can
            * I not see Billing & Charges?" used to need a ticket.
            */}
          <div>
            <div className="text-xs font-semibold mb-1.5 flex items-center gap-1.5">
              <IdCard className="size-3.5 text-muted-foreground" /> Feature Access
            </div>
            <div className="divide-y divide-border/60">
              <MiniStat label="Job Stage Access" value={stageLabel} />
              <MiniStat
                label="Scheduled Jobs"
                value={
                  <StatusChip tone={me?.scheduledJobsAccess ? 'success' : 'neutral'} size="sm">
                    {me?.scheduledJobsAccess ? 'Granted' : 'Not Granted'}
                  </StatusChip>
                }
              />
              <MiniStat
                label="Billing & Charges"
                value={
                  <StatusChip tone={me?.canManageJobCharges ? 'success' : 'neutral'} size="sm">
                    {me?.canManageJobCharges ? 'Granted' : 'Not Granted'}
                  </StatusChip>
                }
              />
            </div>
          </div>
        </div>
      </Section>

      <p className="text-xs text-muted-foreground px-1">
        Your name, employee code, role, access and reporting line are maintained by HR and cannot
        be changed here. To correct any of them, contact HR.
      </p>

      {requestField && details && (
        <RequestChangeDialog
          field={requestField}
          details={details}
          onClose={() => setRequestField(null)}
          onSubmitted={() => setRequestField(null)}
        />
      )}
    </div>
  );
}
