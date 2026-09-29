'use client';

/*
 * Team Roster — Manage Roster (grid) + Update Log + Action Log.
 *
 * Gate copied from admin-actions/issues/page.tsx: useMe() + a feature flag,
 * redirect only after BOTH have settled (never eject a user mid-flight).
 * Tabs copied from admin-actions/webhooks/page.tsx (shared @/components/ui/tabs).
 * See src/components/roster/roster-api-contract usage in RosterGrid /
 * RosterLogs for the backend shape this page is coded against.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useMe } from '@/lib/auth-context';
import { useFetchOnce } from '@/lib/hooks';
import { hasAction } from '@/lib/permissions';
import { RosterGrid } from '@/components/roster/RosterGrid';
import { RosterLogs } from '@/components/roster/RosterLogs';

export default function TeamRosterPage() {
  const router = useRouter();
  const { me, loading: meLoading } = useMe();
  const features = useFetchOnce<{ canManageRoster?: boolean }>('/admin/access/features');
  const canManage = hasAction(me, 'isRosterManage') && features.data?.canManageRoster === true;

  // Fail closed, and only once BOTH signals have settled — see issues/page.tsx.
  const gateSettled = !meLoading && !features.loading;
  useEffect(() => {
    if (gateSettled && !canManage) router.replace('/dashboard');
  }, [gateSettled, canManage, router]);

  const [tab, setTab] = useState<'manage' | 'updates' | 'actions'>('manage');

  if (meLoading || !canManage) {
    return <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <CalendarDays className="size-6" /> Team Roster
        </h1>
        <p className="text-sm text-muted-foreground">
          Plan who is present or on a week off, day by day, for your team.
        </p>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'manage' | 'updates' | 'actions')}>
        <TabsList>
          <TabsTrigger value="manage">Manage Roster</TabsTrigger>
          <TabsTrigger value="updates">Update Log</TabsTrigger>
          <TabsTrigger value="actions">Action Log</TabsTrigger>
        </TabsList>
        <TabsContent value="manage"><RosterGrid /></TabsContent>
        <TabsContent value="updates"><RosterLogs kind="updates" /></TabsContent>
        <TabsContent value="actions"><RosterLogs kind="actions" /></TabsContent>
      </Tabs>
    </div>
  );
}
