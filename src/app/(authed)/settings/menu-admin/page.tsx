'use client';

/*
 * Menu Admin — manage tbl_menu rows that drive the sidebar tree.
 *
 * Backend: /api/admin/menus
 *   GET    /        → list (all rows incl. inactive)
 *   POST   /        → create
 *   PATCH  /:id     → update fields
 *   DELETE /:id     → soft-delete (sets menu_status = 0)
 *
 * Legacy `MenuAction.java` exposed similar CRUD but the CRM rarely needed
 * it — menus are seeded once per env. This page closes the audit's
 * "menu admin frontend missing" gap. Soft-delete only — never hard-delete
 * because role.menu_ids CSV references would break.
 */

import { useEffect, useState } from 'react';
import { MenuSquare, Plus, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';

type MenuRow = {
  menu_id: number;
  menu_name: string;
  parent_menu: number;
  menu_depth: number;
  has_child: number;
  url: string | null;
  icons: string | null;
  sequence: number | null;
  menu_status: number;
};

export default function MenuAdminPage() {
  const confirm = useConfirm();
  const [rows, setRows] = useState<MenuRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MenuRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const data = await api.get<MenuRow[]>('/admin/menus');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load menus');
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function deactivate(r: MenuRow) {
    const ok = await confirm({
      title: 'Hide this menu?',
      description: `"${r.menu_name}" will be soft-deleted (menu_status=0) and disappear from sidebars. Existing role.menu_ids references remain intact. Re-enable by editing.`,
      confirmLabel: 'Hide', variant: 'destructive',
    });
    if (!ok) return;
    try { await api.delete(`/admin/menus/${r.menu_id}`); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); }
  }

  // Build a parent lookup so the list can render the parent name inline.
  const byId = new Map(rows.map((r) => [r.menu_id, r]));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MenuSquare className="size-6" /> Menu Admin
          </h1>
          <p className="text-sm text-muted-foreground">
            Edit <code>tbl_menu</code> rows that drive the sidebar. Changes take effect on the
            next page load (sidebar fetches via <code>/shared/lookup/menus</code>).
          </p>
        </div>
        <Button size="sm" onClick={() => { setEditing(null); setModalOpen(true); }}>
          <Plus className="size-4 mr-1" /> Add Menu
        </Button>
      </div>

      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-center">ID</th>
                <th className="!text-left">Name</th>
                <th className="!text-left">Parent</th>
                <th className="!text-center">Depth</th>
                <th className="!text-left">URL</th>
                <th className="!text-center">Seq</th>
                <th className="!text-center">Status</th>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">No menus.</td></tr>}
              {!loading && rows.map((r) => {
                const parent = r.parent_menu ? byId.get(r.parent_menu) : null;
                return (
                  <tr key={r.menu_id}>
                    <td className="!text-center font-mono text-xs">{r.menu_id}</td>
                    <td className="!text-left font-medium">{r.menu_name}</td>
                    <td className="!text-left text-xs">{parent ? `${parent.menu_name} (#${parent.menu_id})` : <span className="text-muted-foreground italic">root</span>}</td>
                    <td className="!text-center font-mono text-xs">{r.menu_depth}</td>
                    <td className="!text-left font-mono text-xs truncate max-w-[180px]" title={r.url ?? ''}>{r.url ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="!text-center font-mono text-xs">{r.sequence ?? '—'}</td>
                    <td className="!text-center">
                      {r.menu_status === 1
                        ? <span className="text-emerald-700 text-xs">Active</span>
                        : <span className="text-muted-foreground text-xs">Hidden</span>}
                    </td>
                    <td className="!text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setModalOpen(true); }}>
                        <Pencil className="size-3.5" />
                      </Button>
                      {r.menu_status === 1 && (
                        <Button size="sm" variant="ghost" onClick={() => deactivate(r)}>
                          <Trash2 className="size-3.5 text-red-600" />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <MenuFormDialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        rows={rows}
        onSaved={() => { setModalOpen(false); void load(); }}
      />
    </div>
  );
}

function MenuFormDialog({ open, onClose, editing, rows, onSaved }: {
  open: boolean; onClose: () => void; editing: MenuRow | null;
  rows: MenuRow[]; onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState('');
  const [parent, setParent] = useState<number>(0);
  const [depth, setDepth] = useState<number>(1);
  const [hasChild, setHasChild] = useState<number>(0);
  const [url, setUrl] = useState('');
  const [icons, setIcons] = useState('');
  const [sequence, setSequence] = useState('');
  const [active, setActive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.menu_name ?? '');
      setParent(editing?.parent_menu ?? 0);
      setDepth(editing?.menu_depth ?? 1);
      setHasChild(editing?.has_child ?? 0);
      setUrl(editing?.url ?? '');
      setIcons(editing?.icons ?? '');
      setSequence(editing?.sequence != null ? String(editing.sequence) : '');
      setActive(editing ? editing.menu_status === 1 : true);
      setErr(null);
    }
  }, [open, editing]);

  async function go() {
    if (!name.trim()) { setErr('Menu name is required'); return; }
    setLoading(true); setErr(null);
    try {
      const body = {
        menu_name: name.trim(),
        parent_menu: parent,
        menu_depth: depth,
        has_child: hasChild,
        url: url.trim() || null,
        icons: icons.trim() || null,
        sequence: sequence ? Number(sequence) : undefined,
        ...(isEdit ? { menu_status: active ? 1 : 0 } : {}),
      };
      if (isEdit) await api.patch(`/admin/menus/${editing!.menu_id}`, body);
      else        await api.post('/admin/menus', body);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setLoading(false); }
  }

  // Eligible parents: any active menu, excluding self (to prevent cycles).
  const parentChoices = rows
    .filter((r) => r.menu_status === 1 && (!editing || r.menu_id !== editing.menu_id));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{isEdit ? `Edit "${editing!.menu_name}"` : 'Add Menu'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium block mb-1">Menu Name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Reports"' />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Parent Menu</label>
            <select
              value={parent}
              onChange={(e) => setParent(Number(e.target.value))}
              className="border rounded h-9 px-2 text-sm bg-background w-full"
            >
              <option value={0}>— Root (top-level) —</option>
              {parentChoices.map((p) => (
                <option key={p.menu_id} value={p.menu_id}>{p.menu_name} (#{p.menu_id})</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-sm font-medium block mb-1">Depth</label>
              <Input type="number" min={1} max={5} value={depth} onChange={(e) => setDepth(Number(e.target.value))} />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Has Child</label>
              <select value={hasChild} onChange={(e) => setHasChild(Number(e.target.value))} className="border rounded h-9 px-2 text-sm bg-background w-full">
                <option value={0}>No</option>
                <option value={1}>Yes</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Sequence</label>
              <Input type="number" min={0} value={sequence} onChange={(e) => setSequence(e.target.value)} placeholder="ord" />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">URL key (matches Sidebar.URL_MAP key)</label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder='e.g. "reports" or "javascript:;" for parent-only' className="font-mono" />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Icons (legacy FA class, optional)</label>
            <Input value={icons} onChange={(e) => setIcons(e.target.value)} placeholder='e.g. "fa-home"' className="font-mono" />
          </div>
          {isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              <span>Active</span>
            </label>
          )}
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
            <Button onClick={go} disabled={loading}>{loading ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Menu'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
