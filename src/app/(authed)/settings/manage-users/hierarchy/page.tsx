'use client';

/*
 * Users → Hierarchy — graphical hierarchy view.
 *
 * Operator searches for a user by id, email, or name; we resolve to a
 * user_id and call `GET /admin/users/:id/hierarchy` which returns:
 *   - `tree`: the user as root with nested `children[]` (their direct
 *      and indirect reports, expanded server-side via DFS)
 *   - `ancestors`: the chain of reporting managers above them
 *
 * Rendered as a top-down org chart (CSS connectors, no graph lib) with
 * the manager chain above the root. Click a card to expand/collapse its
 * reports; the crosshair re-roots the chart on THAT user.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Users, Search, ChevronLeft, AlertTriangle, ArrowUp, Plus, Minus, Crosshair, ChevronsUpDown, ChevronsDownUp } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { UserAvatar } from '@/components/users/UserAvatar';

type Node = {
  user_id: number;
  user_name: string;
  official_email: string;
  mobile_no: string;
  user_role: number | null;
  role_name: string | null;
  reporting_manager: number | null;
  photo_url?: string | null; // presigned; null → monogram (same contract as Manage Users)
  children: Node[];
};
type HierarchyResponse = { tree: Node; ancestors: Node[] };
type SearchResult = { user_id: number; user_name: string; official_email: string; role_name: string | null };

export default function HierarchyPage() {
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hierarchy, setHierarchy] = useState<HierarchyResponse | null>(null);
  const [loading, setLoading] = useState(false);

  async function search() {
    setError(null);
    setHierarchy(null);
    const term = q.trim();
    if (!term) { setResults([]); return; }
    setSearching(true);
    try {
      // If purely numeric, treat as user_id and load directly.
      if (/^\d+$/.test(term)) {
        await loadHierarchy(Number(term));
        return;
      }
      // Otherwise: search the admin user lookup.
      const params = new URLSearchParams({ q: term, limit: '20' });
      const r = await api.get<{ items: SearchResult[] }>(`/admin/users?${params}`);
      setResults(r.items || []);
      if ((r.items || []).length === 1) await loadHierarchy(r.items[0].user_id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  }

  const loadHierarchy = useCallback(async (userId: number) => {
    setLoading(true); setError(null);
    try {
      const data = await api.get<HierarchyResponse>(`/admin/users/${userId}/hierarchy`);
      setHierarchy(data);
      setResults([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load hierarchy');
    } finally { setLoading(false); }
  }, []);

  return (
    <div className="space-y-4">
      {/* Back link — mirrors the pattern used on settings/zones/[zoneId].
          Explicit Link rather than router.back() so the destination is
          predictable (back-stack could contain a non-manage-users page). */}
      <div className="flex items-center gap-2">
        <Link
          href="/settings/manage-users"
          className="text-sm text-muted-foreground hover:underline inline-flex items-center"
        >
          <ChevronLeft className="h-4 w-4" /> Back to Manage Users
        </Link>
      </div>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Users className="size-6" /> Hierarchy
          </h1>
          <p className="text-sm text-muted-foreground">
            View the reporting tree rooted at any user. Search by id, email, or name.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-2">
            <Search className="size-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
              placeholder="user_id, email, or name…"
              className="max-w-md"
            />
            <Button onClick={search} disabled={searching || !q.trim()}>
              {searching ? 'Searching…' : 'Search'}
            </Button>
          </div>

          {results.length > 0 && (
            <ul className="mt-3 border rounded divide-y max-w-md">
              {results.map((r) => (
                <li key={r.user_id}>
                  <button
                    onClick={() => loadHierarchy(r.user_id)}
                    className="w-full text-left px-3 py-2 hover:bg-muted/60 flex items-center justify-between gap-2"
                  >
                    <span>
                      <span className="font-medium">{r.user_name}</span>
                      {' '}<span className="text-xs text-muted-foreground">#{r.user_id}</span>
                      <div className="text-xs text-muted-foreground">{r.official_email}</div>
                    </span>
                    {r.role_name && (
                      <span className="text-xs text-muted-foreground">{r.role_name}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      {loading && <div className="text-sm text-muted-foreground text-center py-6">Loading hierarchy…</div>}

      {hierarchy && <OrgChart key={hierarchy.tree.user_id} data={hierarchy} onDrillInto={loadHierarchy} />}
    </div>
  );
}


function countAll(n: Node): number {
  return 1 + n.children.reduce((s, c) => s + countAll(c), 0);
}

function managerIds(n: Node, out: number[] = []): number[] {
  if (n.children.length) out.push(n.user_id);
  n.children.forEach((c) => managerIds(c, out));
  return out;
}

/*
 * Top-down org chart. Connectors are plain 1px divs (no graph lib, no
 * canvas): each child column draws the two halves of the horizontal bus
 * above it plus its own vertical stem, so the first/last child simply
 * omit the outer half. Expansion state lives here (not per node) so
 * Expand All / Collapse All can drive it.
 */
function OrgChart({ data, onDrillInto }: { data: HierarchyResponse; onDrillInto: (id: number) => void }) {
  const root = data.tree;
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([root.user_id]));
  const scroller = useRef<HTMLDivElement>(null);

  // Keyed by root id at the call site, so a new root remounts with one
  // level open; centre the viewport on it once.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, []);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // Nearest manager comes first from the API; draw top-most boss first.
  const chain = [...data.ancestors].reverse();

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <div className="text-xs font-medium text-muted-foreground">
            {countAll(root)} user(s) under {root.user_name}, including them
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setExpanded(new Set(managerIds(root)))}>
              <ChevronsUpDown className="size-3.5" /> Expand All
            </Button>
            <Button size="sm" variant="outline" onClick={() => setExpanded(new Set([root.user_id]))}>
              <ChevronsDownUp className="size-3.5" /> Collapse All
            </Button>
          </div>
        </div>

        <div ref={scroller} className="overflow-x-auto pb-2">
          <div className="mx-auto w-max px-4 py-2 flex flex-col items-center">
            {chain.length > 0 && (
              <>
                <div className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-1">
                  <ArrowUp className="size-3" /> Reports Up To
                </div>
                {chain.map((a) => (
                  <div key={a.user_id} className="flex flex-col items-center">
                    <button
                      onClick={() => onDrillInto(a.user_id)}
                      className="rounded-full border border-dashed bg-card px-3 py-1 text-xs hover:border-primary hover:text-primary"
                      title="View hierarchy from this manager"
                    >
                      <span className="font-medium">{a.user_name}</span>
                      {a.role_name && <span className="text-muted-foreground"> · {a.role_name}</span>}
                    </button>
                    <span className="h-4 w-px bg-border" />
                  </div>
                ))}
              </>
            )}
            <OrgNode node={root} isRoot expanded={expanded} onToggle={toggle} onDrillInto={onDrillInto} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function OrgNode({ node, isRoot, expanded, onToggle, onDrillInto }: {
  node: Node;
  isRoot?: boolean;
  expanded: Set<number>;
  onToggle: (id: number) => void;
  onDrillInto: (id: number) => void;
}) {
  const kids = node.children;
  const open = kids.length > 0 && expanded.has(node.user_id);
  const total = countAll(node) - 1;
  const stack = kids.length > 1 && kids.every((k) => k.children.length === 0);

  return (
    <div className="flex flex-col items-center">
      <div
        onClick={() => kids.length && onToggle(node.user_id)}
        className={cn(
          'w-56 rounded-lg border bg-card p-3 shadow-sm transition-colors',
          kids.length > 0 && 'cursor-pointer hover:border-primary',
          isRoot && 'border-primary ring-1 ring-primary',
        )}
      >
        <div className="flex items-start gap-2">
          {/* A photo click opens a lightbox, and React portals bubble to
              this card's expand toggle — so stop it there. A monogram is
              not clickable and lets the card toggle as usual. */}
          <span className="flex" onClick={node.photo_url ? (e) => e.stopPropagation() : undefined}>
            <UserAvatar name={node.user_name} photoUrl={node.photo_url} className="size-9" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold" title={node.user_name}>{node.user_name}</div>
            <div className="truncate text-xs text-muted-foreground" title={node.official_email}>{node.official_email}</div>
          </div>
          {!isRoot && (
            <button
              onClick={(e) => { e.stopPropagation(); onDrillInto(node.user_id); }}
              className="text-muted-foreground hover:text-primary"
              title="View hierarchy from this user"
              aria-label={`View hierarchy from ${node.user_name}`}
            >
              <Crosshair className="size-4" />
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          {node.role_name
            ? <span className="truncate text-xs text-info-strong bg-info-tint rounded px-1.5">{node.role_name}</span>
            : <span />}
          <span className="text-xs text-muted-foreground font-mono">#{node.user_id}</span>
        </div>
      </div>

      {kids.length > 0 && (
        <>
          <span className="h-3 w-px bg-border" />
          <button
            onClick={() => onToggle(node.user_id)}
            aria-expanded={open}
            className="flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary"
            title={`${kids.length} direct · ${total} total`}
          >
            {open ? <Minus className="size-3" /> : <Plus className="size-3" />}
            {kids.length} Report{kids.length === 1 ? '' : 's'}
            {total > kids.length && <span className="opacity-70">· {total}</span>}
          </button>
        </>
      )}

      {open && (
        <>
          <span className="h-4 w-px bg-border" />
          {stack ? (
            // All leaves: hang them down a rail instead of fanning sideways,
            // so a 5-person team costs one column, not five. The empty left
            // cell mirrors the right one, putting the rail under the stem.
            <div className="grid grid-cols-2">
              <div />
              <div>
                {kids.map((c, i) => (
                  <div key={c.user_id} className={cn('relative pl-5', i < kids.length - 1 && 'pb-2')}>
                    <span className={cn('absolute left-0 top-0 w-px bg-border', i < kids.length - 1 ? 'h-full' : 'h-11')} />
                    <span className="absolute left-0 top-11 h-px w-5 bg-border" />
                    <OrgNode node={c} expanded={expanded} onToggle={onToggle} onDrillInto={onDrillInto} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex">
              {kids.map((c, i) => (
                <div key={c.user_id} className="relative flex flex-col items-center px-2 pt-4">
                  {i > 0 && <span className="absolute top-0 left-0 h-px w-1/2 bg-border" />}
                  {i < kids.length - 1 && <span className="absolute top-0 right-0 h-px w-1/2 bg-border" />}
                  <span className="absolute top-0 left-1/2 h-4 w-px bg-border" />
                  <OrgNode node={c} expanded={expanded} onToggle={onToggle} onDrillInto={onDrillInto} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
