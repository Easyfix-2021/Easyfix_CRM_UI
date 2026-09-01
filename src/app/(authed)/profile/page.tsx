'use client';
/*
 * My Profile — the operator's own record, READ ONLY.
 *
 * Reached by clicking your own name in the navbar, which used to open a small
 * "Effective Access" dropdown. That panel showed four scope counts and nothing
 * else, while /auth/me was already returning the operator's employee code,
 * contact numbers, reporting reach and three feature grants that had no surface
 * anywhere in the CRM. This page is that dropdown grown into the full record.
 *
 * ─── NO NEW ENDPOINT, AND DELIBERATELY SO ───────────────────────────────────
 * Everything here comes from `useMe()`, which is already hydrated on first
 * paint for every authenticated page. The page therefore adds ZERO requests.
 *
 * The obvious alternative — GET /admin/users/:id — was rejected: it takes the
 * id from the URL, so "a user can only read their own record" would become a
 * rule enforced by a check somewhere rather than a fact of the shape. /auth/me
 * has no id parameter at all; the server resolves the row from the token. There
 * is no request this page could make for somebody else's profile.
 *
 * ─── NOT PERMISSION-GATED, ON PURPOSE ───────────────────────────────────────
 * Every other new CRM page is RBAC-gated with a seeded menu + action. This one
 * is not, and must not be: it is self-service. A permission key would mean an
 * operator whose role omitted it could not see their own employee code — and
 * the page reveals nothing the session already lacks, since every value on it
 * is the caller's own /auth/me payload. It gets no sidebar entry either; it is
 * reached only from your own name.
 *
 * ─── FIELDS THE ASK NAMED THAT DO NOT EXIST ─────────────────────────────────
 * Profile photo and bank details were requested. Neither exists for a CRM user:
 * tbl_user has no image column and no bank columns, and tbl_user_personal_details
 * (the only user-keyed side table) holds personal_email alone. Both DO exist for
 * TECHNICIANS, on tbl_easyfixer — a different table for different people.
 *
 * So the photo is an initials monogram, and there is no Bank Details section at
 * all rather than an empty card, which would read as a loading bug. Date of
 * joining is absent for the same reason (insert_date is row-creation time,
 * wrong for every migrated user, and is not in this payload).
 */
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { ArrowLeft, Mail, Phone, ShieldCheck, Users, Layers } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { StatusChip } from '@/components/ui/StatusChip';
import { useMe, type ScopeDimension } from '@/lib/auth-context';

/* Same rule as the client and technician headers: first + last initial. */
function initialsOf(name?: string | null): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/*
 * One label/value row. An em dash for anything absent — never a blank cell,
 * which is indistinguishable from a field that failed to load.
 */
function Field({ label, value, mono }: { label: string; value?: ReactNode; mono?: boolean }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-sm mt-0.5 break-words ${mono ? 'font-mono' : ''} ${empty ? 'text-muted-foreground' : ''}`}>
        {empty ? '—' : value}
      </div>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-muted-foreground">{icon}</span>
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/*
 * One scope dimension. 'none' is highlighted rather than shown as a quiet zero
 * because it almost always means the operator's manage_* column is mis-seeded —
 * which is the whole reason the original dropdown existed.
 */
function ScopeRow({ label, dim }: { label: string; dim?: ScopeDimension }) {
  let value: ReactNode = 'All';
  let cls = '';
  if (dim) {
    if (dim.mode === 'allow') value = dim.ids.length;
    else if (dim.mode === 'none') { value = 'None'; cls = 'text-warning-strong font-medium'; }
  }
  return (
    <tr className="border-b last:border-0">
      <td className="text-left text-muted-foreground py-1.5">{label}</td>
      <td className={`text-right py-1.5 ${cls}`}>{value}</td>
    </tr>
  );
}

/* A yes/no feature grant. */
function GrantRow({ label, granted, detail }: { label: string; granted: boolean; detail?: string }) {
  return (
    <tr className="border-b last:border-0">
      <td className="text-left text-muted-foreground py-1.5">{label}</td>
      <td className="text-right py-1.5">
        {detail ?? (
          <StatusChip tone={granted ? 'success' : 'neutral'} size="sm">
            {granted ? 'Granted' : 'Not Granted'}
          </StatusChip>
        )}
      </td>
    </tr>
  );
}

export default function MyProfilePage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const user = me?.user;
  const active = Number(user?.user_status ?? 1) === 1;

  /*
   * mode 'list' with an EMPTY stages array is a real grant meaning NO stages —
   * not a synonym for unrestricted. Rendering it as "All Stages" would tell an
   * operator the opposite of their actual access.
   */
  const stages = me?.allowedStages;
  const stageLabel = !stages || stages.mode === 'all'
    ? 'All Stages'
    : (stages.stages.length ? stages.stages.join(', ') : 'None');

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      {/*
        * Back to wherever they came from, not to a fixed page. This is reached
        * from the navbar, which is on EVERY screen — so a hardcoded destination
        * would take an operator who opened their profile from a job list and
        * drop them somewhere they were not.
        *
        * Falls back to the dashboard when there is nothing to go back TO: a
        * direct link, a fresh tab, or a hard reload all leave history with one
        * entry, and router.back() there walks the user out of the app.
        */}
      <button
        type="button"
        onClick={() => {
          if (typeof window !== 'undefined' && window.history.length > 1) router.back();
          else router.push('/dashboard');
        }}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" /> Back
      </button>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <CardContent className="p-5">
          <div className="flex items-start gap-4 flex-wrap">
            <span
              aria-hidden
              className="size-12 shrink-0 rounded-lg bg-muted text-muted-foreground font-semibold flex items-center justify-center text-sm"
            >
              {initialsOf(user?.user_name)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-semibold truncate">
                  {loading ? 'Loading…' : (user?.user_name ?? '—')}
                </h2>
                {user && (
                  <StatusChip tone={active ? 'success' : 'neutral'} size="sm">
                    {active ? 'Active' : 'Inactive'}
                  </StatusChip>
                )}
                {me?.role?.role_name && (
                  <StatusChip tone="info" size="sm">{me.role.role_name}</StatusChip>
                )}
              </div>
              <div className="text-xs text-muted-foreground font-mono mt-1">
                User #{user?.user_id ?? '—'}
              </div>
            </div>
          </div>
          {/*
            * Said once, plainly, at the top. Without it the page reads as an
            * edit form whose inputs have gone missing.
            */}
          <p className="text-xs text-muted-foreground mt-4">
            This page is view only. To correct anything here, contact HR.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Identity" icon={<ShieldCheck className="size-4" />}>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Employee Code" value={user?.user_code} mono />
            <Field label="Role" value={me?.role?.role_name} />
            <Field label="Status" value={active ? 'Active' : 'Inactive'} />
            <Field label="User ID" value={user?.user_id} mono />
          </div>
        </Section>

        <Section title="Contact" icon={<Mail className="size-4" />}>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Official Email" value={user?.official_email} />
            <Field label="Mobile Number" value={user?.mobile_no} mono />
            <Field label="Alternate Number" value={user?.alternate_no} mono />
          </div>
        </Section>

        {/*
          * The old dropdown, unchanged in meaning. The two reporting counts were
          * already in /auth/me and rendered nowhere except as one italic line.
          */}
        <Section title="Effective Access" icon={<Layers className="size-4" />}>
          {!me?.scope ? (
            <p className="text-sm text-muted-foreground">
              All records — your role bypasses row-level scope.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                <ScopeRow label="Clients"   dim={me.scope.clients} />
                <ScopeRow label="Cities"    dim={me.scope.cities} />
                <ScopeRow label="States"    dim={me.scope.states} />
                <ScopeRow label="Verticals" dim={me.scope.verticals} />
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Reporting" icon={<Users className="size-4" />}>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Direct Reports" value={me?.hierarchy?.directReportsCount ?? 0} />
            <Field label="Downstream Reports" value={me?.hierarchy?.descendantsCount ?? 0} />
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Records belonging to anyone below you in the reporting tree are included in your scope.
          </p>
        </Section>

        {/*
          * Three grants that sit OUTSIDE the menu/role pipeline and had no
          * surface anywhere in the CRM until now — the reason "why can I not see
          * Billing & Charges?" was previously unanswerable without a ticket.
          */}
        <Section title="Feature Access" icon={<Phone className="size-4" />}>
          <table className="w-full text-sm">
            <tbody>
              <GrantRow label="Job Stage Access" granted detail={stageLabel} />
              <GrantRow label="Scheduled Jobs" granted={!!me?.scheduledJobsAccess} />
              <GrantRow label="Billing & Charges" granted={!!me?.canManageJobCharges} />
            </tbody>
          </table>
        </Section>
      </div>
    </div>
  );
}
