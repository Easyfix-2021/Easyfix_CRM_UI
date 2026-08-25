'use client';

/*
 * Client Profile → Services.
 *
 * Two existing tabs folded into one rail entry: the client's service catalogue
 * (ServicesTab) and which technicians are mapped to those services
 * (TechMappingTab). The profile comp has thirteen rail items and the old modal
 * had a separate "Tech Mapping" tab; rather than drop a working feature to hit
 * the count, it becomes a sub-tab here — which is also where an operator looks
 * for it, since a mapping only means anything against a service.
 *
 * Both children are UNCHANGED and keep their own fetch keys, so a deep link
 * from the list kebab (?tab=services, or the legacy ?tab=tech-mapping alias)
 * lands on the right thing.
 */

import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ServicesTab } from '@/components/client/ServicesTab';
import { TechMappingTab } from '@/components/client/TechMappingTab';
import { SectionShell } from '@/components/client/SectionShell';

export function ServicesSection({ clientId, canEdit }: { clientId: number; canEdit: boolean }) {
  const [sub, setSub] = useState<'catalogue' | 'mapping'>('catalogue');
  return (
    <SectionShell
      title="Services"
      note="What this client can book, and which technicians are mapped to it."
    >
      <Tabs value={sub} onValueChange={(v) => setSub(v as 'catalogue' | 'mapping')}>
        <TabsList>
          <TabsTrigger value="catalogue">Service Catalogue</TabsTrigger>
          <TabsTrigger value="mapping">Technician Mapping</TabsTrigger>
        </TabsList>
        <TabsContent value="catalogue">
          <ServicesTab clientId={clientId} canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="mapping">
          <TechMappingTab clientId={clientId} canEdit={canEdit} />
        </TabsContent>
      </Tabs>
    </SectionShell>
  );
}
