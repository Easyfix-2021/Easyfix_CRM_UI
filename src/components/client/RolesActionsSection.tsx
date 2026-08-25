'use client';

/*
 * Client Profile → Roles & Actions.
 *
 * Who can do what for this client, at the two tiers that actually exist:
 *
 *   1. EASYFIX STAFF — the vertical/user/role grid (VerticalsTab, previously
 *      its own "Verticals" tab). This is what makes somebody the Head or
 *      Project Manager on this client's projects.
 *   2. CLIENT-SIDE ROLES — the SPOC access-role catalogue, read from
 *      GET /admin/clients/contacts/access-roles. Shown here READ-ONLY as a
 *      reference: a role defines what its holders inherit, and this page is
 *      about one client, whereas the roles themselves are global. Editing them
 *      is one click away at /clients/access-roles; assigning one to a person
 *      is on the Contacts section.
 *
 * The read-only catalogue is here rather than omitted because the question an
 * operator actually asks on a client screen is "what does Finance let them
 * see?", and answering it previously meant leaving the client entirely.
 */

import Link from 'next/link';
import { ExternalLink, ShieldCheck, Users } from 'lucide-react';
import { StatusChip } from '@/components/ui/StatusChip';
import { useFetch } from '@/lib/hooks';
import { VerticalsTab } from '@/components/client/VerticalsTab';
import type { SpocAccessRole } from '@/lib/client-types';
import { SectionShell } from '@/components/client/SectionShell';

type Catalogue = { roles: SpocAccessRole[]; surfaces: string[] };

export function RolesActionsSection({ clientId, canEdit }: { clientId: number; canEdit: boolean }) {
  const { data, loading } = useFetch<Catalogue>('/admin/clients/contacts/access-roles');

  return (
    <SectionShell
      title="Roles & Actions"
      note="EasyFix staff assigned to this client, and the client-side roles their SPOCs can hold."
    >
      <section className="space-y-2">
        <h4 className="text-sm font-semibold flex items-center gap-1.5">
          <Users className="size-4" /> EasyFix Staff On This Client
        </h4>
        <VerticalsTab clientId={clientId} canEdit={canEdit} />
      </section>

      <section className="space-y-2 border-t pt-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h4 className="text-sm font-semibold flex items-center gap-1.5">
            <ShieldCheck className="size-4" /> Client-Side Access Roles
          </h4>
          <Link href="/clients/access-roles" className="text-sm text-primary hover:underline inline-flex items-center gap-1">
            Configure Roles <ExternalLink className="size-3.5" />
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          Global roles, shown for reference. Assign one to a person under Contacts.
        </p>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {data?.roles?.length ? (
          <ul className="space-y-2">
            {data.roles.map((r) => (
              <li key={r.id} className="rounded border bg-card px-3 py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{r.name}</span>
                  <StatusChip tone={r.configured ? 'success' : 'neutral'} size="sm">
                    {r.configured ? 'Configured' : 'Default'}
                  </StatusChip>
                  {r.allStores && <StatusChip tone="info" size="sm">All Branches</StatusChip>}
                </div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {r.grants.length === 0
                    ? <span className="text-xs text-muted-foreground italic">No surfaces granted.</span>
                    : r.grants.map((g) => <StatusChip key={g} tone="neutral" size="sm">{g}</StatusChip>)}
                </div>
              </li>
            ))}
          </ul>
        ) : (!loading && <p className="text-sm text-muted-foreground italic">No roles in the catalogue.</p>)}
      </section>
    </SectionShell>
  );
}
