'use client';

/*
 * Client Profile — /clients/[id]
 *
 * The client master, as a PAGE rather than the near-fullscreen dialog it used
 * to be (ClientDetailDialog in ../page.tsx, now deleted). Three things the
 * dialog could not do and this can:
 *
 *   1. Deep-link. `?tab=rate-cards` is a real URL, so the kebab menu on the
 *      list, a Slack message and the browser Back button all work. The dialog
 *      held its tab in component state that vanished on close.
 *   2. Give the left rail room. Thirteen sections do not fit a horizontal
 *      strip without scrolling; a vertical rail shows every section at once,
 *      which is the point of a rail.
 *   3. Carry a headline strip. Outstanding / open orders / pending client QC /
 *      SLA breaches are the four numbers an operator opens a client to check,
 *      and they were previously spread across four other screens.
 *
 * ─── LAYOUT (matches the approved profile comp) ─────────────────────────────
 *   ┌ Client Profile ................................ ← All clients ┐
 *   ┌ hero card: avatar · name · status · terms · Actions           ┐
 *   │            four-figure strip                                  │
 *   ┌ context strip: brand + project(s)                             ┐
 *   ┌ rail (13) ┬ section body ──────────────────────────────────── ┐
 *
 * ─── WHY THE PROJECT SELECTOR IS NOT A SELECTOR ─────────────────────────────
 * The comp draws the context strip as a dropdown ("Brightline Retail (Brand) ▾
 * — Project: Store Repair & Maintenance"). Nothing in the data model is scoped
 * per project: tbl_client carries ONE row of settings, and tbl_vertical_mapping
 * maps a client to verticals only to say which staff run it. A dropdown that
 * changed the selection but not a single field on the page would be a control
 * that lies. So the strip renders the brand plus every mapped project as
 * chips, and each section header carries the BRAND-LEVEL tag the comp shows —
 * which is the honest version of the same information. When per-project
 * settings actually land, this strip becomes the selector with no layout
 * change.
 *
 * Permission: isClientEdit gates every mutation, exactly as the dialog did.
 * Without it the page is READ-ONLY, not hidden — seeing a client's rate cards
 * is useful to someone who may not change them.
 */

import { useMemo } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle, Building2, ChevronRight, Download, MoreHorizontal, Pencil,
  CheckCircle2, XCircle, IndianRupee, FolderOpen, ClipboardCheck, Timer,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BackLink } from '@/components/ui/back-link';
import { StatusChip } from '@/components/ui/StatusChip';
import { RefreshBar } from '@/components/ui/refresh-bar';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { downloadXlsx } from '@/lib/download-xlsx';
import { cn } from '@/lib/utils';
import {
  CLIENT_TAB_LIST, resolveClientTab,
  type ClientDetail, type ClientSummary, type ClientTab,
} from '@/lib/client-types';

import { SectionShell } from '@/components/client/SectionShell';
import { ProfileOverviewSection } from '@/components/client/ProfileOverviewSection';
import { RolesActionsSection } from '@/components/client/RolesActionsSection';
import { BranchesSection } from '@/components/client/BranchesSection';
import { BookingChannelsSection } from '@/components/client/BookingChannelsSection';
import { AccountPaymentSection } from '@/components/client/AccountPaymentSection';
import { SlaTargetsSection } from '@/components/client/SlaTargetsSection';
import { NotificationsSection } from '@/components/client/NotificationsSection';
import { ReportsSection } from '@/components/client/ReportsSection';
import { ServicesSection } from '@/components/client/ServicesSection';
import { ContactsTab } from '@/components/client/ContactsTab';
import { BillingTab } from '@/components/client/BillingTab';
import { RateCardsTab } from '@/components/client/RateCardsTab';
import { CustomPropsTab } from '@/components/client/CustomPropsTab';

/* Compact Indian-locale integer for the KPI tiles (₹1,23,456 / 1,234). */
function fmtInt(n: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n));
}

/*
 * Two-letter monogram. Same rule as the client portal's avatar: first + last
 * initial for a multi-word name, first two characters otherwise.
 */
function initialsOf(name?: string | null): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* A vertical assignment row from GET /admin/clients/:id/verticals. */
type VerticalAssignment = { vertical_id: number; vertical_name?: string | null };

/* Shape of GET /admin/tat/client/:id — only the parts this page reads. */
type TatClientResult = {
  summary: {
    jobsAnalysed: number;
    labels: { Excellent: number; Good: number; Partial: number; Poor: number; Pending: number };
  };
};

export default function ClientProfilePage() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isClientEdit', 'isClientAddNew']);
  const canEdit = !!can.isClientEdit;

  const clientId = Number(params?.id);
  const validId = Number.isFinite(clientId) && clientId > 0;

  /*
   * The active section is URL state, not component state, so a deep link and
   * the Back button both work. resolveClientTab() also maps the pre-profile
   * tab names ('verticals', 'tech-mapping', 'documents') onto their new homes
   * so older links keep landing somewhere sensible instead of on Overview.
   */
  const tab = resolveClientTab(searchParams.get('tab'));

  function selectTab(next: ClientTab) {
    const qs = new URLSearchParams(searchParams.toString());
    if (next === 'overview') qs.delete('tab');
    else qs.set('tab', next);
    const q = qs.toString();
    // replace, not push: flipping through thirteen sections should not bury
    // the list page thirteen entries deep in history.
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }

  const detailKey = validId ? `/admin/clients/${clientId}` : null;
  const { data: client, loading, refreshing, error, refetch } = useFetch<ClientDetail>(detailKey);
  const { data: summary, error: summaryError } = useFetch<ClientSummary>(validId ? `/admin/clients/${clientId}/summary` : null);
  const { data: verticals } = useFetch<VerticalAssignment[]>(validId ? `/admin/clients/${clientId}/verticals` : null);

  /*
   * SLA breaches come from the TAT engine, NOT from the summary endpoint —
   * see the handler comment there. It is the slow one and it carries its own
   * action gate, so it loads independently and a 403 renders as a dash rather
   * than failing the strip.
   */
  const { data: tat, error: tatError } = useFetch<TatClientResult>(
    validId ? `/admin/tat/client/${clientId}?days=30` : null,
  );

  const isActive = client?.client_status === 1;

  /* Distinct projects this client is mapped to, in stable name order. */
  const projects = useMemo(() => {
    const seen = new Map<number, string>();
    for (const v of verticals ?? []) {
      if (v.vertical_id && !seen.has(v.vertical_id)) {
        seen.set(v.vertical_id, String(v.vertical_name ?? `Vertical #${v.vertical_id}`));
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [verticals]);

  /*
   * Jobs where at least one EasyFix-OWNED TAT segment was missed. The engine
   * labels a job 'Excellent' only when every EF segment was met, so anything
   * scored below that is a breach; 'Pending' jobs are excluded because they
   * are not yet judgeable, not because they passed.
   */
  const slaBreaches = useMemo(() => {
    if (!tat?.summary) return null;
    const l = tat.summary.labels;
    const judged = tat.summary.jobsAnalysed - (l.Pending ?? 0);
    return Math.max(0, judged - (l.Excellent ?? 0));
  }, [tat]);

  async function toggleStatus() {
    if (!client) return;
    const nextStatus = isActive ? 0 : 1;
    if (isActive) {
      const ok = await confirm({
        title: 'Deactivate Client',
        description: `Mark "${client.client_name}" as inactive? The row hides from the default Manage Clients filter; toggle "Include Inactive" to see it again.`,
        confirmLabel: 'Deactivate',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    try {
      await api.put(`/admin/clients/${clientId}`, { clientStatus: nextStatus } as never);
      invalidateFetch((k) => k.startsWith('/admin/clients'));
      refetch();
      showToast({ variant: 'success', message: nextStatus === 1 ? 'Client reactivated.' : 'Client deactivated.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Status toggle failed.' });
    }
  }

  async function downloadRateCard() {
    try {
      const safeName = String(client?.client_name ?? '').replace(/[^a-z0-9_-]+/gi, '_') || `client-${clientId}`;
      await downloadXlsx({
        url: `/admin/clients/${clientId}/rate-cards/download`,
        filename: `rate-cards-${safeName}.xlsx`,
      });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed.' });
    }
  }

  /* Jumps to Overview, which is where the master fields are edited inline. */
  function handleEditOverview() {
    selectTab('overview');
  }

  if (!validId) {
    return (
      <Card><CardContent className="p-4 flex items-center gap-2 text-sm text-urgent">
        <AlertTriangle className="size-4" /> Not a valid client id.
      </CardContent></Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Page title + return path ─────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Building2 className="size-6" /> Client Profile
        </h1>
        <BackLink href="/clients" label="All Clients" />
      </div>

      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      {/* ── Hero: identity + the four figures ────────────────────────── */}
      <Card className="overflow-hidden">
        <RefreshBar active={refreshing} />
        <CardContent className="p-5 space-y-5">
          <div className="flex items-start gap-4 flex-wrap">
            <span
              aria-hidden
              className="size-12 shrink-0 rounded-lg bg-muted text-muted-foreground font-semibold flex items-center justify-center text-sm"
            >
              {initialsOf(client?.client_name)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-semibold truncate">
                  {loading ? 'Loading…' : String(client?.client_name ?? `Client #${clientId}`)}
                </h2>
                {client && (
                  <StatusChip tone={isActive ? 'success' : 'neutral'} size="sm">
                    {isActive ? 'Active' : 'Inactive'}
                  </StatusChip>
                )}
                {client && (
                  /* Payment terms, read off the legacy invoice switch: billing_raised
                     = 1 means this client is invoiced on a cycle (postpaid); 0 means
                     every job is settled at the job. */
                  <StatusChip
                    tone={Number(client.billing_raised) === 1 ? 'info' : 'neutral'}
                    size="sm"
                    title={Number(client.billing_raised) === 1
                      ? 'Invoiced on a billing cycle — see Account & Payment'
                      : 'Not invoiced; settled per job — see Account & Payment'}
                  >
                    {Number(client.billing_raised) === 1 ? 'Postpaid' : 'Pay Per Job'}
                  </StatusChip>
                )}
              </div>
              {/* The two presentation names, shown only when ops have actually set
                  them — repeating client_name three times says nothing. */}
              <ProfileNameLine client={client} />
            </div>

            {canEdit && client && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <MoreHorizontal className="size-4 mr-1" /> Actions
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onSelect={handleEditOverview}>
                    <Pencil className="size-3.5 mr-2" /> Edit Overview
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={downloadRateCard}>
                    <Download className="size-3.5 mr-2" /> Download Rate Card
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={toggleStatus}>
                    {isActive
                      ? <><XCircle className="size-3.5 mr-2" /> Deactivate Client</>
                      : <><CheckCircle2 className="size-3.5 mr-2" /> Reactivate Client</>}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {/*
           * The four figures. Each renders a dash rather than a zero when the
           * number is genuinely unknown (table not provisioned, TAT not
           * permitted) — "₹0 outstanding" and "we cannot tell you" are very
           * different statements to put in front of an operator.
           */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Kpi
              icon={<IndianRupee className="size-3.5" />}
              label="Outstanding"
              value={summaryError ? null : (summary ? (summary.outstanding == null ? null : `₹${fmtInt(summary.outstanding)}`) : undefined)}
              hint={summaryError ? summaryError : (summary?.invoices
                ? `${fmtInt(summary.invoices.invoices)} raised · ₹${fmtInt(summary.invoices.collected)} collected`
                : 'Invoice ledger unavailable on this environment')}
            />
            <Kpi
              icon={<FolderOpen className="size-3.5" />}
              label="Open Orders"
              value={summaryError ? null : (summary ? fmtInt(summary.openOrders) : undefined)}
              hint={summary ? `${fmtInt(summary.totalOrders)} lifetime · ${fmtInt(summary.completedOrders)} completed` : undefined}
            />
            <Kpi
              icon={<ClipboardCheck className="size-3.5" />}
              label="Pending Client QC"
              value={summaryError ? null : (summary ? fmtInt(summary.pendingClientQc) : undefined)}
              hint="Jobs waiting on this client to approve a billing line"
              tone={summary && summary.pendingClientQc > 0 ? 'warning' : undefined}
            />
            <Kpi
              icon={<Timer className="size-3.5" />}
              label="SLA Breaches (30d)"
              value={tatError ? null : (slaBreaches == null ? undefined : fmtInt(slaBreaches))}
              hint={tatError
                ? 'Needs the TAT Calculator permission'
                : (tat ? `${fmtInt(tat.summary.jobsAnalysed)} jobs completed in the window` : undefined)}
              tone={slaBreaches ? 'urgent' : undefined}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Context strip: brand + project(s) ────────────────────────── */}
      <div className="rounded-lg border bg-muted/40 px-4 py-2.5 text-sm flex items-center gap-x-2 gap-y-1 flex-wrap">
        <span className="font-medium">{String(client?.client_name ?? '—')}</span>
        <span className="text-muted-foreground">(Brand)</span>
        {projects.length > 0 && (
          <>
            <ChevronRight className="size-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">
              {projects.length === 1 ? 'Project:' : 'Projects:'}
            </span>
            {projects.map((p) => (
              <StatusChip key={p} tone="neutral" size="sm">{p}</StatusChip>
            ))}
          </>
        )}
        {projects.length === 0 && (
          <span className="text-muted-foreground">· No project mapped yet — assign one under Roles &amp; Actions.</span>
        )}
      </div>

      {/* ── Rail + section body ──────────────────────────────────────── */}
      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <Card className="w-full lg:w-56 shrink-0">
          <CardContent className="p-2">
            <nav aria-label="Client profile sections" className="flex lg:flex-col gap-1 overflow-x-auto">
              {CLIENT_TAB_LIST.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => selectTab(t.key)}
                  aria-current={tab === t.key ? 'page' : undefined}
                  className={cn(
                    'text-left text-sm rounded px-3 py-2 whitespace-nowrap transition',
                    tab === t.key
                      ? 'bg-sidebar text-sidebar-foreground font-medium'
                      : 'hover:bg-muted text-foreground',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </CardContent>
        </Card>

        <Card className="flex-1 min-w-0 w-full">
          <CardContent className="p-5">
            {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
            {!loading && client && (
              <ClientSection
                tab={tab}
                client={client}
                clientId={clientId}
                canEdit={canEdit}
                onSaved={refetch}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ── The presentation-name line under the client name ───────────────── */
function ProfileNameLine({ client }: { client: ClientDetail | null }) {
  if (!client) return null;
  const billing = String(client.billing_name ?? '').trim();
  const techApp = String(client.tech_app_name ?? '').trim();
  const parts: string[] = [];
  if (billing) parts.push(`Billing: ${billing}`);
  if (techApp) parts.push(`Tech app: ${techApp}`);
  if (client.reference_code) parts.push(`Ref: ${String(client.reference_code)}`);
  if (parts.length === 0) return null;
  return <p className="text-xs text-muted-foreground mt-0.5 truncate">{parts.join(' · ')}</p>;
}

/* ── One figure in the headline strip ───────────────────────────────── */
function Kpi({
  icon, label, value, hint, tone,
}: {
  icon: React.ReactNode;
  label: string;
  /* undefined = still loading. null = genuinely unknown (renders a dash). */
  value: string | null | undefined;
  hint?: string;
  tone?: 'warning' | 'urgent';
}) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          'text-2xl font-semibold tabular-nums',
          tone === 'urgent' && 'text-urgent-strong',
          tone === 'warning' && 'text-warning-strong',
        )}
      >
        {value === undefined ? <span className="text-muted-foreground text-base font-normal">…</span>
          : value === null ? <span className="text-muted-foreground">—</span>
            : value}
      </div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1 mt-0.5">
        {icon} {label}
      </div>
      {hint && <div className="text-xs text-muted-foreground mt-0.5 truncate" title={hint}>{hint}</div>}
    </div>
  );
}

/*
 * Section router. Every section takes the same three props so adding one is a
 * rail entry plus a case, not a new plumbing shape.
 */
function ClientSection({
  tab, client, clientId, canEdit, onSaved,
}: {
  tab: ClientTab;
  client: ClientDetail;
  clientId: number;
  canEdit: boolean;
  onSaved: () => void;
}) {
  switch (tab) {
    case 'overview':      return <ProfileOverviewSection client={client} canEdit={canEdit} onSaved={onSaved} />;
    case 'roles':         return <RolesActionsSection clientId={clientId} canEdit={canEdit} />;
    case 'contacts':      return <SectionShell title="Contacts" note="Client SPOCs and their portal access."><ContactsTab clientId={clientId} canEdit={canEdit} /></SectionShell>;
    case 'branches':      return <BranchesSection clientId={clientId} />;
    case 'channels':      return <BookingChannelsSection client={client} clientId={clientId} />;
    case 'billing':       return <SectionShell title="Billing & Estimates" note="Billing addresses invoices are raised against."><BillingTab clientId={clientId} canEdit={canEdit} /></SectionShell>;
    case 'account':       return <AccountPaymentSection client={client} canEdit={canEdit} onSaved={onSaved} />;
    case 'services':      return <ServicesSection clientId={clientId} canEdit={canEdit} />;
    case 'rate-cards':    return <SectionShell title="Rate Cards" note="Per-service pricing applied to this client's jobs."><RateCardsTab clientId={clientId} canEdit={canEdit} /></SectionShell>;
    case 'sla':           return <SlaTargetsSection clientId={clientId} />;
    case 'notifications': return <NotificationsSection client={client} clientId={clientId} />;
    case 'reports':       return <ReportsSection clientId={clientId} clientName={String(client.client_name ?? '')} />;
    case 'props':         return <SectionShell title="Custom Properties" note="Per-client feature switches and booking-form fields."><CustomPropsTab clientId={clientId} canEdit={canEdit} /></SectionShell>;
    default:              return null;
  }
}
