'use client';

import Link from 'next/link';
import {
  Brain, Building, Hash, Tag, Package, UserCog, FileText,
  Sparkles, Wrench, ShieldCheck, Zap, type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

/*
 * Settings landing — a tile grid of every master this page manages. Each
 * tile links to the actual route (real or coming-soon). Mirrors the sidebar
 * Settings submenu so operators can navigate by either surface.
 *
 * When a master ships a real page, flip its `href` from the /coming-soon URL
 * to the real one in both this config AND the Sidebar config.
 */
const wip = (title: string, legacyPath: string) =>
  `/coming-soon?title=${encodeURIComponent(title)}&legacyPath=${encodeURIComponent(legacyPath)}`;

type Tile = { href: string; icon: LucideIcon; title: string; blurb: string; shipped?: boolean };

const AREAS: Tile[] = [
  { href: '/settings/auto-allocation', icon: Zap, title: 'Manage Auto Allocations',
    blurb: 'Toggle instant vs batch auto-assignment per client, failure email, and L3 scoring weights.',
    shipped: true },
  { href: '/settings/deep-skills', icon: Brain, title: 'Manage Deep Skills',
    blurb: 'Service Category → Service Type → Deep Skill → Option catalogue used for technician skill mapping.',
    shipped: true },
  { href: wip('Manage Cities', 'city'), icon: Building, title: 'Manage Cities',
    blurb: 'List + search tbl_city entries; tier + district + reference pincode.' },
  { href: wip('Manage Vertical', 'vertical'), icon: Tag, title: 'Manage Vertical',
    blurb: 'Business vertical classifications.' },
  { href: wip('Manage Service Category', 'servicecategory'), icon: Package, title: 'Manage Service Category',
    blurb: 'Top-level service categories (Electrician, Carpentry, …).' },
  { href: wip('Manage Service Type', 'servicetype'), icon: Hash, title: 'Manage Service Type',
    blurb: 'Service types inside each category (AC, Geyser, …).' },
  { href: wip('Manage Services', 'clientratecard'), icon: FileText, title: 'Manage Services',
    blurb: 'Client rate cards — service × client × pricing.' },
  { href: wip('Manage Role', 'usertype'), icon: UserCog, title: 'Manage Role',
    blurb: 'tbl_role rows + their group classification (admin / client / mobile).' },
  { href: wip('Manage Document Type', 'documentType'), icon: FileText, title: 'Manage Document Type',
    blurb: 'Document types required from technicians for verification.' },
  { href: wip('Manage Skill Level', 'skill'), icon: Sparkles, title: 'Manage Skill Level',
    blurb: 'Skill tiers (L1/L2/…) used in legacy scoring — see tbl_skill_master.' },
  { href: wip('Manage Tools', 'tool'), icon: Wrench, title: 'Manage Tools',
    blurb: 'Tools required by deep skills (multimeter, welding kit, etc.).' },
  { href: wip('Admin Action', 'generateClientInvoice'), icon: ShieldCheck, title: 'Admin Action',
    blurb: 'Restricted admin operations — invoice generation etc.' },
];

export default function SettingsLandingPage() {
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Master data and catalogue configuration</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {AREAS.map((a) => {
          const Icon = a.icon;
          return (
            <Link key={a.title} href={a.href}>
              <Card className="hover:border-primary hover:shadow-sm transition-colors h-full">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                      <Icon className="h-4 w-4" />
                    </div>
                    <h2 className="font-medium flex-1">{a.title}</h2>
                    {!a.shipped && (
                      <span className="text-[10px] font-medium rounded bg-amber-100 text-amber-800 px-1.5 py-0.5">WIP</span>
                    )}
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
