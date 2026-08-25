'use client';

/*
 * Client Profile → Booking Channels.
 *
 * Every route through which a job can enter the platform for THIS client, with
 * its real on/off state. It answers the question that used to require three
 * screens and a DB check: "how are these orders actually reaching us?"
 *
 * Nothing here is a new setting — each row reads state that already exists:
 *   CRM              always available to staff.
 *   Client portal    tbl_client_contacts rows that hold a portal role.
 *   Public link / QR tbl_client.reference_code. A client with no code has no
 *                    public booking page, because the public route resolves a
 *                    client BY that code.
 *   Magic link       tbl_client_custom_properties.auto_process_unconfirmed_order.
 *   Bulk upload      always available to staff.
 *
 * ─── THE status=0 TRAP ──────────────────────────────────────────────────────
 * GET /:clientId/custom-properties does NOT filter on the legacy `status`
 * column — it returns every row and hands the raw record through. A property
 * row with status = 0 is DISABLED, so reading value === 'true' alone reports a
 * channel as live when it is switched off. Both conditions are checked below;
 * the raw row is the only place `status` is visible.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { StatusChip } from '@/components/ui/StatusChip';
import { showToast } from '@/components/ui/toast';
import { useFetch } from '@/lib/hooks';
import type { ClientContact, ClientDetail } from '@/lib/client-types';
import { SectionShell } from '@/components/client/SectionShell';

type CustomProp = {
  id: number | null;
  name: string;
  label: string | null;
  value: string | null;
  is_config: number;
  raw?: Record<string, unknown>;
};

const TRUTHY = new Set(['1', 'true', 'yes', 'y']);

/*
 * A property counts as ON only when its value is truthy AND its row is active.
 * `status` exists only on the legacy schema shape, so an undefined status is
 * treated as active — the canonical shape has no such column and its rows are
 * always live.
 */
function propEnabled(props: CustomProp[], name: string): boolean {
  const row = props.find((p) => p.name === name);
  if (!row) return false;
  if (!TRUTHY.has(String(row.value ?? '').trim().toLowerCase())) return false;
  const status = row.raw?.status;
  return status === undefined || status === null || Number(status) === 1;
}

export function BookingChannelsSection({ client, clientId }: { client: ClientDetail; clientId: number }) {
  const { data: props } = useFetch<CustomProp[]>(`/admin/clients/${clientId}/custom-properties`);
  const { data: contacts } = useFetch<ClientContact[]>(`/admin/clients/${clientId}/contacts`);
  const [copied, setCopied] = useState(false);

  const referenceCode = String(client.reference_code ?? '').trim();
  const publicUrl = useMemo(() => {
    if (!referenceCode) return null;
    const origin = typeof window === 'undefined' ? '' : window.location.origin;
    return `${origin}/public/book/${encodeURIComponent(referenceCode)}`;
  }, [referenceCode]);

  const portalUsers = (contacts ?? []).filter((c) => c.status === 1 && c.spoc_role != null).length;
  const magicLink = propEnabled(props ?? [], 'auto_process_unconfirmed_order');

  async function copyLink() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast({ variant: 'error', message: 'Could not copy — select the link and copy manually.' });
    }
  }

  return (
    <SectionShell
      title="Booking Channels"
      note="Every route an order can reach EasyFix through for this client."
    >
      <ul className="space-y-2">
        <Channel
          name="CRM — Book New Call"
          on
          detail="EasyFix staff booking on the client's behalf."
          action={<Link href="/jobs/new" className="text-primary hover:underline inline-flex items-center gap-1">Book <ExternalLink className="size-3.5" /></Link>}
        />

        <Channel
          name="Client Portal"
          on={portalUsers > 0}
          detail={contacts
            ? (portalUsers > 0
              ? `${portalUsers} SPOC${portalUsers === 1 ? '' : 's'} can sign in and raise orders.`
              : 'No SPOC has a portal role yet, so nobody at this client can sign in.')
            : 'Checking SPOC access…'}
          action={<Link href={`/clients/${clientId}?tab=contacts`} className="text-primary hover:underline">Manage SPOCs</Link>}
        />

        <Channel
          name="Public Booking Link / QR"
          on={!!referenceCode}
          detail={referenceCode
            ? 'Anyone with the link or QR code can raise an order against this client.'
            : 'Needs a Reference Code — the public route resolves the client by that code.'}
          action={publicUrl
            ? (
              <button type="button" onClick={copyLink} className="text-primary hover:underline inline-flex items-center gap-1">
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? 'Copied' : 'Copy Link'}
              </button>
            )
            : <Link href={`/clients/${clientId}`} className="text-primary hover:underline">Set A Code</Link>}
        >
          {publicUrl && (
            <code className="block text-xs mt-1 break-all text-muted-foreground">{publicUrl}</code>
          )}
        </Channel>

        <Channel
          name="Magic-Link Job Completion"
          on={magicLink}
          detail={magicLink
            ? 'Unconfirmed orders are auto-processed and the customer completes the job over a magic link.'
            : 'Off — set the auto_process_unconfirmed_order custom property to turn it on.'}
          action={<Link href={`/clients/${clientId}?tab=props`} className="text-primary hover:underline">Custom Properties</Link>}
        />

        <Channel
          name="Bulk Upload"
          on
          detail="Spreadsheet upload of many orders at once, by EasyFix staff."
          action={<Link href="/jobs/upload" className="text-primary hover:underline inline-flex items-center gap-1">Upload <ExternalLink className="size-3.5" /></Link>}
        />
      </ul>
    </SectionShell>
  );
}

function Channel({
  name, on, detail, action, children,
}: {
  name: string;
  on: boolean;
  detail: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li className="rounded border bg-card px-3 py-2.5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{name}</span>
            <StatusChip tone={on ? 'success' : 'neutral'} size="sm">{on ? 'Enabled' : 'Off'}</StatusChip>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>
          {children}
        </div>
        {action && <div className="text-sm shrink-0">{action}</div>}
      </div>
    </li>
  );
}
