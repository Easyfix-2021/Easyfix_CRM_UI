'use client';

/*
 * Admin Action — landing page that surfaces admin-only operations that
 * don't fit elsewhere. Mirrors the legacy CRM `generateClientInvoice` action
 * which was a misc-admin bucket.
 *
 * Each card links to the canonical implementation already shipped in the
 * app (Webhook re-dispatch, Bulk job upload, Manage Roles, etc.). This
 * avoids duplicating logic — Admin Action is a discovery surface, not a
 * second implementation.
 */

import Link from 'next/link';
import {
  ShieldCheck, Webhook, FileSpreadsheet, ShieldAlert, Workflow, Database,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';

const ACTIONS = [
  {
    href: '/jobs/upload',
    icon: FileSpreadsheet,
    title: 'Bulk Job Upload',
    blurb: 'Excel-driven job import with dry-run mode and per-row error report.',
    actionKey: 'isJobUpload',
  },
  {
    href: '/settings/manage-roles',
    icon: ShieldCheck,
    title: 'Manage Roles & Permissions',
    blurb: 'Configure which menus + buttons each role can reach. Edits live-bust the 5-minute role cache.',
    actionKey: 'isRollEdit',
  },
  {
    href: '/settings/auto-allocation',
    icon: Workflow,
    title: 'Auto-Allocation Config',
    blurb: 'Tune the per-client auto-assignment engine — toggles, scoring weights, failure email.',
    actionKey: 'isAutoAllocationEdit',
  },
  {
    href: '/reports',
    icon: Database,
    title: 'Operational Reports',
    blurb: 'Completed jobs, payout sheet, easyfixer roll-up, user productivity. XLSX export.',
    actionKey: 'isReportView',
  },
  {
    href: '/tracking',
    icon: ShieldAlert,
    title: 'Job Tracking / Audit',
    blurb: 'Reconstruct any job’s scheduling-history timeline for dispute investigation.',
  },
  // Webhook surface — placeholder href until a dedicated screen ships.
  // Backend already exposes /api/admin/webhooks (Phase 2 DONE per backend
  // CLAUDE.md). When the admin screen lands, swap this href and add an
  // actionKey like `isWebhookManage`.
  {
    href: '/coming-soon?title=Webhook+Manager&legacyPath=webhook',
    icon: Webhook,
    title: 'Webhook Manager',
    blurb: 'Backend endpoints exist (/api/admin/webhooks). Frontend admin screen ships next.',
  },
];

export default function AdminActionsPage() {
  const { me } = useMe();
  const visible = ACTIONS.filter((a) => !a.actionKey || hasAction(me, a.actionKey));
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="size-6" /> Admin Action
        </h1>
        <p className="text-sm text-muted-foreground">
          Privileged operations that don&apos;t fit elsewhere in the sidebar. Most cards link to
          their canonical screen — Admin Action is a discovery surface, not a second
          implementation.
        </p>
      </div>
      {visible.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            You don&apos;t have permission to use any admin operations yet. Ask an admin to
            grant the relevant action permissions in Manage Roles.
          </CardContent>
        </Card>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {visible.map((a) => {
          const Icon = a.icon;
          return (
            <Link key={a.title} href={a.href}>
              <Card className="hover:border-primary hover:shadow-sm transition-colors h-full">
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                      <Icon className="h-4 w-4" />
                    </div>
                    <h2 className="font-medium flex-1">{a.title}</h2>
                  </div>
                  <p className="text-xs text-muted-foreground">{a.blurb}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
