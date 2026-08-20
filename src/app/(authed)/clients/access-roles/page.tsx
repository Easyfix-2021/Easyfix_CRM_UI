'use client';

/*
 * Client Role Access — /clients/access-roles
 *
 * THE TIER ABOVE THE CONTACTS TAB. Manage Clients → Contacts sets ONE SPOC's
 * access; this screen sets what a ROLE grants by default, which is what every
 * SPOC holding that role inherits when they have no per-SPOC override.
 *
 * Backed by:
 *   GET /admin/clients/contacts/access-roles
 *     → { roles: [{ id, key, name, grants[], allStores, configured }],
 *         surfaces: string[],
 *         overrides: [{ flag, surface }] }
 *   PUT /admin/clients/contacts/access-roles/:roleId  { surfaces, allStores }
 *     → { roleId, surfaces, allStores }
 *
 * Three things about the contract shape this screen:
 *
 *   1. THE SURFACE VOCABULARY COMES FROM THE SERVER. `surfaces` is rendered as
 *      given — never a local array — because the whole reason the endpoint
 *      returns it is that SURFACES in services/client-access.service.js is the
 *      single definition. A surface added there appears here on the next
 *      deploy with no frontend change; a local copy would silently omit it.
 *      Only the human LABEL is local, and an unlabelled key still renders
 *      (title-cased) rather than disappearing.
 *   2. A PUT REPLACES THE SET. There is no "revoke one surface" call — the
 *      surfaces array you send becomes the role's whole grant list, so an
 *      unchecked box IS a revocation. Hence the removal confirm below.
 *   3. `home` IS FORCED SERVER-SIDE (setRoleAccess unshifts it when missing).
 *      It renders checked and disabled: letting an operator uncheck it and
 *      then reading it back checked is the worst of both worlds.
 *
 * Permission: isClientEdit — the same key that gates the Contacts tab and the
 * PUT itself (requireClientEdit on routes/admin/clients.js). Without it the
 * screen is READ-ONLY rather than hidden: seeing what Finance grants is
 * useful even to someone who may not change it.
 */

import { useState } from 'react';
import { ShieldCheck, Save, RotateCcw, AlertCircle, Lock, Info, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { BackLink } from '@/components/ui/back-link';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import type { SpocAccessCatalogue, SpocAccessRole } from '@/lib/client-types';

const CATALOGUE_KEY = '/admin/clients/contacts/access-roles';

/*
 * The one surface the server adds back whether or not it was sent
 * (setRoleAccess: `if (!clean.includes('home')) clean.unshift('home')`).
 * Named here so the disabled checkbox and its explanation cannot drift apart,
 * and guarded on presence: if `home` ever leaves the SURFACES vocabulary this
 * screen shows whatever the server does send instead of inventing a row.
 */
const ALWAYS_GRANTED = 'home';

/*
 * Human labels for the surface keys, matching what the client portal calls
 * each screen (Easyfix_client_UI/src/app/(authed)/layout.tsx). A key with no
 * entry falls back to a title-cased version of itself — an unlabelled NEW
 * surface must still be configurable, just less prettily.
 */
const SURFACE_LABELS: Record<string, string> = {
  home: 'Home',
  open: 'Open Jobs',
  completed: 'Completed Jobs',
  performance: 'Performance',
  actions: 'Action Queue',
  invoicing: 'Invoicing',
};

const SURFACE_HINTS: Record<string, string> = {
  home: 'The portal landing page. Always granted.',
  open: 'Live jobs the SPOC can track.',
  completed: 'Closed jobs and their reports.',
  performance: 'SLA, TAT and rating dashboards.',
  actions: 'Estimate approvals and other items awaiting the SPOC.',
  invoicing: 'Invoices, wallet and billing documents.',
};

function titleCase(key: string): string {
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function surfaceLabel(key: string): string {
  return SURFACE_LABELS[key] ?? titleCase(key);
}

type RoleDraft = { surfaces: string[]; allStores: boolean };

function sameSurfaces(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export default function ClientRoleAccessPage() {
  const { me } = useMe();
  const can = actionFlags(me, ['isClientEdit']);
  const confirm = useConfirm();

  const { data, loading, error, refetch } = useFetch<SpocAccessCatalogue>(CATALOGUE_KEY);
  const roles = data?.roles ?? [];
  const surfaces = data?.surfaces ?? [];
  /* Surfaces a per-SPOC override flag can reach. One that isn't here can ONLY
     be granted by the role — worth saying on screen, because it changes where
     an operator goes to fix a single person's access. */
  const overridable = new Set((data?.overrides ?? []).map((o) => o.surface));

  /*
   * Edits live here keyed by role id, and ONLY for roles that were touched.
   * Rendering `drafts[id] ?? serverValue` means there is no effect syncing
   * fetched data into state — the fetch stays the single source of truth for
   * anything untouched, and a refetch after save drops straight through.
   */
  const [drafts, setDrafts] = useState<Record<number, RoleDraft>>({});
  const [saving, setSaving] = useState<number | null>(null);

  const draftFor = (r: SpocAccessRole): RoleDraft =>
    drafts[r.id] ?? { surfaces: r.grants, allStores: r.allStores };

  const isDirty = (r: SpocAccessRole): boolean => {
    const d = drafts[r.id];
    if (!d) return false;
    return !sameSurfaces(d.surfaces, r.grants) || d.allStores !== r.allStores;
  };

  function toggleSurface(r: SpocAccessRole, surface: string, next: boolean) {
    setDrafts((prev) => {
      const current = prev[r.id] ?? { surfaces: r.grants, allStores: r.allStores };
      const set = new Set(current.surfaces);
      if (next) set.add(surface); else set.delete(surface);
      // Keep the server's ordering so the saved CSV and the effective-list
      // preview read in tab order rather than in click order.
      const ordered = surfaces.filter((s) => set.has(s));
      return { ...prev, [r.id]: { ...current, surfaces: ordered } };
    });
  }

  function toggleAllStores(r: SpocAccessRole, next: boolean) {
    setDrafts((prev) => {
      const current = prev[r.id] ?? { surfaces: r.grants, allStores: r.allStores };
      return { ...prev, [r.id]: { ...current, allStores: next } };
    });
  }

  function resetRole(r: SpocAccessRole) {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[r.id];
      return next;
    });
  }

  async function saveRole(r: SpocAccessRole) {
    const draft = draftFor(r);
    // `home` is force-added server-side; send it explicitly so what we post
    // and what comes back agree, and so the Joi min(1) can never be tripped.
    const surfacesToSend = surfaces.includes(ALWAYS_GRANTED) && !draft.surfaces.includes(ALWAYS_GRANTED)
      ? [ALWAYS_GRANTED, ...draft.surfaces]
      : draft.surfaces;

    const removed = r.grants.filter((s) => !surfacesToSend.includes(s));
    const losesAllStores = r.allStores && !draft.allStores;

    if (removed.length || losesAllStores) {
      const lines = [
        removed.length
          ? `${r.name} will no longer grant ${removed.map(surfaceLabel).join(', ')}.`
          : null,
        losesAllStores
          ? `${r.name} will be narrowed from all stores to the SPOC's own booking subtree.`
          : null,
        'This applies immediately to every SPOC holding this role who has no per-SPOC override for it. A SPOC with an "Allow" override keeps their access.',
      ].filter(Boolean);
      const ok = await confirm({
        title: 'Remove Access From This Role?',
        description: (
          <span className="space-y-2 block">
            {lines.map((l) => <span key={l as string} className="block">{l}</span>)}
          </span>
        ),
        confirmLabel: 'Remove Access',
        variant: 'destructive',
        iconAccent: 'rose',
      });
      if (!ok) return;
    }

    setSaving(r.id);
    try {
      await api.put(`${CATALOGUE_KEY}/${r.id}`, {
        surfaces: surfacesToSend,
        allStores: draft.allStores,
      });
      resetRole(r);
      invalidateFetch((k) => k.startsWith(CATALOGUE_KEY));
      refetch();
      showToast({ variant: 'success', message: `${r.name} access saved.` });
    } catch (e) {
      showToast({
        variant: 'error',
        message: e instanceof ApiError ? e.message : 'Could not save role access.',
      });
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <BackLink href="/clients" label="Back To Manage Clients" />
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ShieldCheck className="size-6 text-primary" /> Client Role Access
          </h1>
          {!can.isClientEdit && (
            <Badge className="bg-muted text-muted-foreground">
              <Lock className="size-3 mr-1" /> Read Only
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Which screens of the client portal each SPOC role grants by default.
        </p>
      </div>

      <Card>
        <CardContent className="pt-4 text-sm space-y-2">
          <div className="flex items-start gap-2">
            <Info className="size-4 mt-0.5 shrink-0 text-info" />
            <div className="space-y-1.5">
              <p>
                <b>The role is the default.</b> Every SPOC holding a role starts from the
                screens ticked below.
              </p>
              <p>
                <b>The Contacts tab overrides it per person.</b> On Manage Clients → Contacts,
                one SPOC can be given a screen this role withholds (Allow) or have one taken
                away that this role grants (Deny). An override of <b>Deny</b> beats a role that
                grants the screen — the person stays out until the override is set back to
                Inherit.
              </p>
              <p>
                <b>Saving replaces the whole set.</b> An unticked box is a revocation, not a
                no-op: it applies to every SPOC on this role who has no override for that
                screen.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {!can.isClientEdit && (
        <div className="rounded border border-warning/30 bg-warning-tint px-3 py-2 text-sm text-warning-strong">
          You Do Not Have The Edit Client Permission. Role access is shown read-only.
        </div>
      )}

      {error && (
        <div className="text-sm text-urgent-strong flex items-center gap-1">
          <AlertCircle className="size-4" /> {error}
        </div>
      )}

      {loading && !data && (
        <div className="text-sm text-muted-foreground">Loading Roles…</div>
      )}

      {!loading && !error && roles.length === 0 && (
        <div className="text-sm text-muted-foreground italic">No configurable roles returned.</div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {roles.map((r) => {
          const draft = draftFor(r);
          const dirty = isDirty(r);
          const removed = r.grants.filter((s) => !draft.surfaces.includes(s));
          const added = draft.surfaces.filter((s) => !r.grants.includes(s));
          const busy = saving === r.id;

          return (
            <Card key={r.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                <div className="min-w-0">
                  <CardTitle className="text-base">{r.name}</CardTitle>
                  <div className="text-xs font-mono text-muted-foreground">{r.key}</div>
                </div>
                <Badge
                  className={r.configured
                    ? 'bg-info-tint text-info-strong'
                    : 'bg-muted text-muted-foreground'}
                  title={r.configured
                    ? 'Saved from this screen — no longer on the shipped default.'
                    : 'Never edited — still on the default that ships with the product.'}
                >
                  {r.configured ? 'Customised' : 'Built-In Default'}
                </Badge>
              </CardHeader>

              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  {surfaces.map((s) => {
                    const forced = s === ALWAYS_GRANTED;
                    const checked = forced || draft.surfaces.includes(s);
                    return (
                      <label
                        key={s}
                        className={`flex items-start gap-2 rounded px-2 py-1.5 ${
                          forced || !can.isClientEdit ? '' : 'cursor-pointer hover:bg-muted/50'
                        }`}
                      >
                        <span className="pt-0.5">
                          <Checkbox
                            checked={checked}
                            disabled={forced || !can.isClientEdit || busy}
                            label={`${surfaceLabel(s)} for ${r.name}`}
                            title={forced
                              ? 'Home is the portal landing page and is always granted — the server adds it back even if it is sent unticked.'
                              : undefined}
                            onChange={(next) => toggleSurface(r, s, next)}
                          />
                        </span>
                        <span className="min-w-0">
                          <span className="text-sm flex flex-wrap items-center gap-1.5">
                            {surfaceLabel(s)}
                            <span className="font-mono text-xs text-muted-foreground">{s}</span>
                            {forced && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                                <Lock className="size-2.5" /> Always Granted
                              </span>
                            )}
                            {!forced && !overridable.has(s) && (
                              <span className="text-xs text-muted-foreground">
                                · Role only — no per-SPOC override
                              </span>
                            )}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {SURFACE_HINTS[s] ?? 'Portal screen.'}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>

                <div className="flex items-start justify-between gap-3 rounded border bg-muted/30 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm">All Stores</div>
                    <div className="text-xs text-muted-foreground">
                      {draft.allStores
                        ? 'Sees every store on the client.'
                        : 'Sees only their own booking subtree (the reporting-hierarchy filter stays in force).'}
                    </div>
                  </div>
                  <Switch
                    checked={draft.allStores}
                    disabled={!can.isClientEdit || busy}
                    ariaLabel={`All stores for ${r.name}`}
                    onCheckedChange={(next) => toggleAllStores(r, next)}
                  />
                </div>

                {dirty && (
                  <div className="rounded border border-warning/30 bg-warning-tint px-3 py-2 text-xs text-warning-strong space-y-0.5">
                    <div className="font-medium">Unsaved Changes</div>
                    {removed.length > 0 && (
                      <div>Removing: {removed.map(surfaceLabel).join(', ')} — every SPOC on this role without an Allow override loses it.</div>
                    )}
                    {added.length > 0 && <div>Adding: {added.map(surfaceLabel).join(', ')}</div>}
                    {draft.allStores !== r.allStores && (
                      <div>
                        All Stores: {r.allStores ? 'On → Off' : 'Off → On'}
                      </div>
                    )}
                  </div>
                )}

                {can.isClientEdit && (
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => resetRole(r)}
                      disabled={!dirty || busy}
                    >
                      <RotateCcw className="size-3.5 mr-1" /> Reset
                    </Button>
                    <Button size="sm" onClick={() => saveRole(r)} disabled={!dirty || busy}>
                      <Save className="size-3.5 mr-1" /> {busy ? 'Saving…' : 'Save Role'}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/*
        * "No Role" is deliberately not editable — the server rejects role 0
        * (setRoleAccess: "Unknown or non-configurable role"), because it is the
        * ABSENCE of configuration rather than a role anybody chose. Shown here
        * read-only so an operator who expected five cards knows why there are
        * four, and knows where the gap gets closed.
        */}
      {!loading && roles.length > 0 && (
        <Card>
          <CardContent className="pt-4 text-sm flex items-start gap-2">
            <Users className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
            <div>
              <div className="font-medium">No Role — Not Configurable Here</div>
              <p className="text-muted-foreground text-xs mt-0.5">
                A SPOC who has never been given a role shows as <b>No Role</b> in the portal and
                on the Contacts tab. That is an unconfigured state, not a role with a screen
                set, so it cannot be edited on this screen. Close the gap by assigning a role on
                Manage Clients → Contacts → Portal Access.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
