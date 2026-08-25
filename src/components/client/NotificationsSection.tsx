'use client';

/*
 * Client Profile → Notifications.
 *
 * WHO at this client hears from the platform, and through which surface. There
 * is no per-client notification-preferences table, so this section does NOT
 * invent one — it renders the two things that genuinely decide who gets
 * contacted today:
 *
 *   1. REPORTING CONTACTS — tbl_client.reporting_contact_ids, a CSV of
 *      tbl_client_contacts ids. These are the people attributed on bookings and
 *      copied on client reporting. Ids that no longer resolve to a contact are
 *      shown as unresolved rather than dropped: a stale id is precisely the
 *      thing worth seeing on a screen about who gets emailed.
 *   2. SPOC REACHABILITY — every active contact with the channels we actually
 *      hold for them (email, mobile) and whether they have portal access at all.
 *      A SPOC with no email cannot be notified by email, however the templates
 *      are configured.
 *
 * Editing lives on Contacts (people) and Overview (the reporting-contact set),
 * so this section reads rather than duplicating those forms.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { AlertTriangle, Mail, Phone, Send } from 'lucide-react';
import { StatusChip } from '@/components/ui/StatusChip';
import { useFetch } from '@/lib/hooks';
import type { ClientContact, ClientDetail } from '@/lib/client-types';
import { SectionShell } from '@/components/client/SectionShell';

export function NotificationsSection({ client, clientId }: { client: ClientDetail; clientId: number }) {
  const { data: contacts, loading } = useFetch<ClientContact[]>(`/admin/clients/${clientId}/contacts`);

  /* reporting_contact_ids is stored as a CSV string on the master row. */
  const reportingIds = useMemo(() => {
    const raw = (client as Record<string, unknown>).reporting_contact_ids;
    return String(raw ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }, [client]);

  const byId = useMemo(
    () => new Map((contacts ?? []).map((c) => [c.id, c])),
    [contacts],
  );

  const active = (contacts ?? []).filter((c) => c.status === 1);
  const unreachable = active.filter((c) => !String(c.contact_email ?? '').trim());

  return (
    <SectionShell
      title="Notifications"
      note="Who at this client the platform contacts, and on which channels."
    >
      <section className="space-y-2">
        <h4 className="text-sm font-semibold flex items-center gap-1.5">
          <Send className="size-4" /> Reporting Contacts
        </h4>
        <p className="text-xs text-muted-foreground">
          Attributed on bookings and copied on client reporting. Set on the Overview section.
        </p>
        {reportingIds.length === 0 && (
          <p className="text-sm text-muted-foreground italic">None set for this client.</p>
        )}
        {reportingIds.length > 0 && (
          <ul className="space-y-1">
            {reportingIds.map((id) => {
              const c = byId.get(id);
              return (
                <li key={id} className="rounded border bg-card px-3 py-2 text-sm flex items-center justify-between gap-2 flex-wrap">
                  {c ? (
                    <>
                      <span>
                        <span className="font-medium">{c.contact_name ?? `Contact #${id}`}</span>
                        {c.contact_email && <span className="text-muted-foreground"> · {c.contact_email}</span>}
                      </span>
                      <StatusChip tone={c.status === 1 ? 'success' : 'neutral'} size="sm">
                        {c.status === 1 ? 'Active' : 'Inactive'}
                      </StatusChip>
                    </>
                  ) : (
                    <span className="flex items-center gap-1.5 text-warning-strong">
                      <AlertTriangle className="size-3.5" />
                      Contact #{id} no longer exists — clear it from the reporting set.
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-2 border-t pt-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h4 className="text-sm font-semibold">SPOC Reachability</h4>
          <Link href={`/clients/${clientId}?tab=contacts`} className="text-sm text-primary hover:underline">
            Manage Contacts
          </Link>
        </div>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && active.length === 0 && (
          <p className="text-sm text-muted-foreground italic">No active contacts on this client.</p>
        )}
        {unreachable.length > 0 && (
          <p className="text-xs bg-warning-tint text-warning-strong border border-warning rounded px-2 py-1.5">
            {unreachable.length} active contact{unreachable.length === 1 ? ' has' : 's have'} no email
            address, so no email notification can reach them.
          </p>
        )}
        {active.length > 0 && (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="!text-left">Contact</th>
                  <th className="!text-left">Email</th>
                  <th className="!text-left">Mobile</th>
                  <th className="!text-center">Portal Access</th>
                </tr>
              </thead>
              <tbody>
                {active.map((c) => (
                  <tr key={c.id}>
                    <td className="!text-left">
                      <div className="font-medium">{c.contact_name ?? '—'}</div>
                      {c.contact_desgn && <div className="text-xs text-muted-foreground">{c.contact_desgn}</div>}
                    </td>
                    <td className="!text-left text-xs">
                      {c.contact_email
                        ? <span className="inline-flex items-center gap-1"><Mail className="size-3" /> {c.contact_email}</span>
                        : <span className="text-warning-strong">No email</span>}
                    </td>
                    <td className="!text-left text-xs">
                      {c.contact_no
                        ? <span className="inline-flex items-center gap-1"><Phone className="size-3" /> {c.contact_no}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="!text-center">
                      <StatusChip tone={c.spoc_role != null ? 'success' : 'neutral'} size="sm">
                        {c.spoc_role != null ? 'Yes' : 'No'}
                      </StatusChip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-xs text-muted-foreground border-t pt-3">
        Notification TEMPLATES (email/SMS/WhatsApp copy and triggers) are
        platform-wide, not per client — this section shows recipients only.
      </p>
    </SectionShell>
  );
}
