'use client';

import Link from 'next/link';
import {
  Brain, Building, Hash, Tag, Package, UserCog, FileText,
  Sparkles, Wrench, ShieldCheck, Zap, type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';

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

/*
 * `actionKey` ties each tile to the permission that unlocks it. If a user
 * lacks the action, the tile is hidden — mirroring the legacy CRM's
 * per-menu visibility check. Tiles without an actionKey are always shown
 * (currently the WIP placeholders that don't reach a real screen — once
 * those screens ship, add the matching actionKey).
 *
 * Keys use the same `is{Entity}{Verb}` naming as the in-page button gates,
 * so adding a permission to a role lights up both the landing tile AND the
 * action buttons inside the page in one move.
 */
type Tile = { href: string; icon: LucideIcon; title: string; blurb: string; shipped?: boolean; actionKey?: string };

const AREAS: Tile[] = [
  { href: '/settings/auto-allocation', icon: Zap, title: 'Manage Auto Allocations',
    blurb: 'Toggle instant vs batch auto-assignment per client, failure email, and L3 scoring weights.',
    shipped: true, actionKey: 'isAutoAllocationEdit' },
  { href: '/settings/deep-skills', icon: Brain, title: 'Manage Deep Skills',
    blurb: 'Service Category → Service Type → Deep Skill → Option catalogue used for technician skill mapping.',
    shipped: true, actionKey: 'isDeepSkillEdit' },
  { href: wip('Manage Cities', 'city'), icon: Building, title: 'Manage Cities',
    blurb: 'List + search tbl_city entries; tier + district + reference pincode.',
    actionKey: 'isCityEdit' },
  { href: wip('Manage Vertical', 'vertical'), icon: Tag, title: 'Manage Vertical',
    blurb: 'Business vertical classifications.' },
  { href: wip('Manage Service Category', 'servicecategory'), icon: Package, title: 'Manage Service Category',
    blurb: 'Top-level service categories (Electrician, Carpentry, …).' },
  { href: wip('Manage Service Type', 'servicetype'), icon: Hash, title: 'Manage Service Type',
    blurb: 'Service types inside each category (AC, Geyser, …).' },
  { href: wip('Manage Services', 'clientratecard'), icon: FileText, title: 'Manage Services',
    blurb: 'Client rate cards — service × client × pricing.' },
  { href: '/settings/manage-users', icon: UserCog, title: 'Manage Users',
    blurb: 'Internal CRM staff. Identity + role + city; OTP-only login (no passwords).',
    shipped: true, actionKey: 'isUserEdit' },
  { href: '/settings/manage-roles', icon: ShieldCheck, title: 'Manage Roles',
    blurb: 'tbl_role rows + their group classification (admin / client / mobile).',
    shipped: true, actionKey: 'isRollEdit' },
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
  const { me } = useMe();
  /*
   * Filter visible tiles by permission:
   *   - actionKey set → require the user to have that action permission.
   *   - actionKey absent → always show (WIP placeholders fall here for now).
   *
   * No actionKey + no permissions data is treated as "show" so an
   * unconfigured account still sees the WIP grid. Once a WIP tile ships its
   * real page, give it an actionKey — that automatically gates the tile.
   */
  const visibleAreas = AREAS.filter((a) => !a.actionKey || hasAction(me, a.actionKey));
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Master data and catalogue configuration</p>
      </div>
      {visibleAreas.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            You don&apos;t have access to any Settings screens yet. Ask an admin to grant the
            relevant action permissions in Manage Roles.
          </CardContent>
        </Card>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {visibleAreas.map((a) => {
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
