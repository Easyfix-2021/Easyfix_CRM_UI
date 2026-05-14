'use client';

/*
 * Manage Skill Level — Settings page.
 * Operates on tbl_skill_master via /api/admin/skill-levels.
 * Mirrors /pages/settings/manageSkill.vm + addEditSkill.vm.
 *
 * Distinct from /settings/deep-skills (the new app's 4-level hierarchy).
 * This screen edits the legacy skill master used by older scoring rules.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Sparkles, Search, Plus, Pencil, Trash2,
  AlertTriangle, ArrowUp, ArrowDown, ArrowUpDown,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

type Skill = {
  skill_id: number;
  skill_name: string;
  skill_desc: string | null;
  skill_status: number;
};
type ListResponse = { items: Skill[]; total: number };
type SortKey = 'skill_id' | 'skill_name' | 'skill_status';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 100;

export default function ManageSkillLevelsPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isSkillAddNew', 'isSkillEdit']);

  const [items, setItems] = useState<Skill[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('skill_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function onSort(col: SortKey) {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('asc'); }
    setPage(0);
  }

  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => { setPage(0); void fetchList(); }, 300);
    return () => { if (tRef.current) clearTimeout(tRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, includeInactive]);
  useEffect(() => { void fetchList(); /* eslint-disable-next-line */ }, [page, sortBy, sortDir]);

  async function fetchList() {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (search.trim()) p.set('q', search.trim());
      if (includeInactive) p.set('includeInactive', 'true');
      p.set('limit', String(PAGE_SIZE)); p.set('offset', String(page * PAGE_SIZE));
      p.set('sortBy', sortBy); p.set('sortDir', sortDir);
      const data = await api.get<ListResponse>(`/admin/skill-levels?${p}`);
      setItems(data.items); setTotal(data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load skills');
    } finally { setLoading(false); }
  }

  async function handleDeactivate(s: Skill) {
    const ok = await confirm({
      title: 'Deactivate skill?',
      description: `${s.skill_name} will be hidden from default lists. Reactivate by editing.`,
      confirmLabel: 'Deactivate', variant: 'destructive',
    });
    if (!ok) return;
    try { await api.delete(`/admin/skill-levels/${s.skill_id}`); void fetchList(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Deactivate failed'); }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="size-6" /> Manage Skill Level
          </h1>
          <p className="text-sm text-muted-foreground">
            Legacy skill tiers (L1/L2/…) stored in <code>tbl_skill_master</code>. Distinct from Deep Skills.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isSkillAddNew && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add Skill
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search by name or description…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
          </div>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            Include inactive
          </label>
        </CardContent>
      </Card>

      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '8%'  }} />
              <col style={{ width: '25%' }} />
              <col style={{ width: '40%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '15%' }} />
            </colgroup>
            <thead>
              <tr>
                <SortHeader col="skill_id"     align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Skill ID</SortHeader>
                <SortHeader col="skill_name"   align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Skill Name</SortHeader>
                <th className="!text-left whitespace-nowrap">Skill Description</th>
                <SortHeader col="skill_status" align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={5} className="!text-center text-muted-foreground py-6">No skills match the current filters.</td></tr>}
              {!loading && items.map((s) => (
                <tr key={s.skill_id}>
                  <td className="!text-center font-mono text-xs truncate">{s.skill_id}</td>
                  <td className="!text-left font-medium truncate" title={s.skill_name}>{s.skill_name}</td>
                  <td className="!text-left truncate text-muted-foreground" title={s.skill_desc ?? ''}>
                    {s.skill_desc ?? <span>—</span>}
                  </td>
                  <td className="!text-center whitespace-nowrap">
                    {s.skill_status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-1">
                      {can.isSkillEdit && (
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(s); setModalOpen(true); }}>
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                      {can.isSkillEdit && s.skill_status === 1 && (
                        <Button size="sm" variant="ghost" onClick={() => handleDeactivate(s)}>
                          <Trash2 className="size-3.5 text-red-600" />
                        </Button>
                      )}
                      {!can.isSkillEdit && <span className="text-[10px] text-muted-foreground">view-only</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      <SkillFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        onSaved={() => { setModalOpen(false); void fetchList(); }}
      />
    </div>
  );
}

function SortHeader({ col, align, sortBy, sortDir, onSort, children }: {
  col: SortKey; align: 'left' | 'center' | 'right'; sortBy: SortKey; sortDir: SortDir;
  onSort: (col: SortKey) => void; children: React.ReactNode;
}) {
  const isActive = sortBy === col;
  const alignCls = align === 'left' ? '!text-left' : align === 'right' ? '!text-right' : '!text-center';
  const justify = align === 'left' ? 'justify-start' : align === 'right' ? 'justify-end' : 'justify-center';
  const Icon = !isActive ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={`${alignCls} cursor-pointer select-none hover:bg-muted/40 transition-colors whitespace-nowrap overflow-hidden`}
      onClick={() => onSort(col)} role="button"
      aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span className={`inline-flex items-center gap-1 whitespace-nowrap ${justify}`}>
        {children}
        <Icon className={`size-3 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground/40'}`} />
      </span>
    </th>
  );
}

function SkillFormModal({ open, onClose, editing, onSaved }: {
  open: boolean; onClose: () => void; editing: Skill | null; onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.skill_name ?? '');
      setDesc(editing?.skill_desc ?? '');
      setActive(editing ? editing.skill_status === 1 : true);
      setError(null);
    }
  }, [open, editing]);

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('Skill name is required'); return; }
    if (!desc.trim()) { setError('Skill description is required'); return; }
    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/skill-levels/${editing!.skill_id}`, {
          skill_name: name.trim(), skill_desc: desc.trim() || null, is_active: active,
        });
      } else {
        await api.post('/admin/skill-levels', {
          skill_name: name.trim(), skill_desc: desc.trim() || null,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.skill_name}"` : 'Add Skill'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium block mb-1">Skill Name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "L1 Technician"' />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Skill Description *</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="What this skill tier covers"
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
              maxLength={500} />
          </div>
          {isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              <span>Active</span>
            </label>
          )}
          {error && <div className="text-sm text-red-600 flex items-center gap-1"><AlertTriangle className="size-4" /> {error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Skill'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
