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
 * Rendered as an indented tree (CSS only, no graph lib) so the entire
 * subtree is visible at once without needing a viewport-sizing canvas.
 * Each node shows name + role + email; click to drill into THAT user's
 * sub-hierarchy.
 */

import { useState, useCallback } from 'react';
import { Users, Search, ChevronRight, ChevronDown, AlertTriangle, ArrowUp } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';

type Node = {
  user_id: number;
  user_name: string;
  official_email: string;
  mobile_no: string;
  user_role: number | null;
  role_name: string | null;
  reporting_manager: number | null;
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

  function totalCount(n: Node): number {
    return 1 + n.children.reduce((s, c) => s + totalCount(c), 0);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
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
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      {loading && <div className="text-sm text-muted-foreground text-center py-6">Loading hierarchy…</div>}

      {hierarchy && (
        <>
          {hierarchy.ancestors.length > 0 && (
            <Card>
              <CardContent className="p-3">
                <div className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-2">
                  <ArrowUp className="size-3.5" /> Reports up to
                </div>
                <div className="flex items-center gap-1 flex-wrap text-sm">
                  {hierarchy.ancestors.map((a, i) => (
                    <span key={a.user_id} className="flex items-center gap-1">
                      <button
                        className="text-primary hover:underline"
                        onClick={() => loadHierarchy(a.user_id)}
                      >
                        {a.user_name}{a.role_name ? ` (${a.role_name})` : ''}
                      </button>
                      {i < hierarchy.ancestors.length - 1 && <ChevronRight className="size-3 text-muted-foreground" />}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-3">
              <div className="text-xs font-medium text-muted-foreground mb-2">
                Subtree — {totalCount(hierarchy.tree)} user(s) including root
              </div>
              <TreeNode node={hierarchy.tree} onDrillInto={loadHierarchy} root />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// Recursive node — uses a disclosure toggle so deep trees stay scannable.
function TreeNode({ node, onDrillInto, root }: {
  node: Node;
  onDrillInto: (id: number) => void;
  root?: boolean;
}) {
  const hasChildren = node.children.length > 0;
  const [open, setOpen] = useState(root ?? false);

  return (
    <div className={root ? '' : 'ml-5 mt-1 border-l border-slate-200 pl-3'}>
      <div className="flex items-center gap-1.5 group">
        {hasChildren ? (
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <span className="size-3.5 inline-block" />
        )}
        <div className="flex-1 flex items-center gap-2 text-sm">
          <span className="font-medium">{node.user_name}</span>
          <span className="text-xs text-muted-foreground font-mono">#{node.user_id}</span>
          {node.role_name && <span className="text-xs text-blue-700 bg-blue-50 rounded px-1.5">{node.role_name}</span>}
          <span className="text-xs text-muted-foreground">{node.official_email}</span>
          {hasChildren && (
            <span className="text-xs text-muted-foreground">· {node.children.length} report{node.children.length === 1 ? '' : 's'}</span>
          )}
          <button
            onClick={() => onDrillInto(node.user_id)}
            className="ml-auto text-xs text-primary opacity-0 group-hover:opacity-100 hover:underline"
            title="Focus hierarchy on this user"
          >
            focus →
          </button>
        </div>
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map((c) => (
            <TreeNode key={c.user_id} node={c} onDrillInto={onDrillInto} />
          ))}
        </div>
      )}
    </div>
  );
}
