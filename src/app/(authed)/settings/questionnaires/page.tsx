'use client';

/*
 * Manage Questionnaires — list + detail viewer.
 *
 * Backend: /api/admin/questionnaires
 *   GET  /                       → all questionnaires (tbl_questionaire)
 *   GET  /:id/details            → questions for one questionnaire (tbl_questionaire_details)
 *   POST /                       → create new (name only)
 *
 * Mirrors the legacy `manageQuestionaire.vm` + `manageQuestionaireDetail.vm`.
 * Note the legacy typo "questionaire" (one 'n') is preserved in table/column
 * names per the EasyFix schema convention.
 */

import { useEffect, useState } from 'react';
import { ClipboardList, Plus, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

type QRow = Record<string, unknown> & {
  id: number;
  q_name?: string | null;
  name?: string | null;     // legacy fallback column
  status?: number | null;
  created_date?: string | null;
};

type QDetailRow = Record<string, unknown> & {
  id: number;
  questionaire_id: number;
  question_text?: string | null;
  question?: string | null;
  type?: string | null;
};

export default function ManageQuestionnairesPage() {
  const { me } = useMe();
  // Legacy keyspace: isClientQuestionaire is the canonical permission key.
  const can = actionFlags(me, ['isClientQuestionaire']);

  const [rows, setRows] = useState<QRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [details, setDetails] = useState<Map<number, QDetailRow[]>>(new Map());
  const [addOpen, setAddOpen] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const data = await api.get<QRow[]>('/admin/questionnaires');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load questionnaires');
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if (!details.has(id)) {
      try {
        const d = await api.get<QDetailRow[]>(`/admin/questionnaires/${id}/details`);
        setDetails((m) => new Map(m).set(id, Array.isArray(d) ? d : []));
      } catch (e) {
        // Surface inline; don't block other rows.
        setDetails((m) => new Map(m).set(id, []));
        setError(e instanceof ApiError ? e.message : 'Failed to load questionnaire details');
      }
    }
  }

  function nameOf(r: QRow) {
    return String(r.q_name ?? r.name ?? `(unnamed #${r.id})`);
  }
  function textOf(d: QDetailRow) {
    return String(d.question_text ?? d.question ?? `(no text — #${d.id})`);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ClipboardList className="size-6" /> Manage Questionnaires
          </h1>
          <p className="text-sm text-muted-foreground">
            Per-client questionnaire templates surfaced to technicians at job-completion time.
            Click a row to view its questions.
          </p>
        </div>
        {can.isClientQuestionaire && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4 mr-1" /> New Questionnaire
          </Button>
        )}
      </div>

      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      {loading && (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">Loading…</CardContent></Card>
      )}

      {!loading && rows.length === 0 && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          No questionnaires defined yet.
        </CardContent></Card>
      )}

      {!loading && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r) => {
            const open = expanded.has(r.id);
            const Chev = open ? ChevronDown : ChevronRight;
            const d = details.get(r.id);
            return (
              <Card key={r.id}>
                <CardContent className="p-0">
                  <button
                    type="button"
                    onClick={() => void toggleExpand(r.id)}
                    className="w-full text-left px-4 py-3 flex items-center gap-2 hover:bg-muted/40 transition-colors"
                  >
                    <Chev className="size-4 text-muted-foreground shrink-0" />
                    <span className="font-medium flex-1 truncate">{nameOf(r)}</span>
                    <span className="text-[10px] font-mono text-muted-foreground">#{r.id}</span>
                  </button>
                  {open && (
                    <div className="border-t px-4 py-3 text-sm">
                      {d == null && <div className="text-muted-foreground italic">Loading details…</div>}
                      {d != null && d.length === 0 && <div className="text-muted-foreground italic">No questions in this questionnaire.</div>}
                      {d != null && d.length > 0 && (
                        <ol className="list-decimal ml-5 space-y-1">
                          {d.map((q) => (
                            <li key={q.id}>
                              <span>{textOf(q)}</span>
                              {q.type && <span className="ml-2 text-[10px] uppercase rounded bg-blue-50 text-blue-700 px-1.5 py-0.5">{String(q.type)}</span>}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AddQuestionnaireDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={async (name) => {
          await api.post('/admin/questionnaires', { name });
          setAddOpen(false);
          await load();
        }}
      />
    </div>
  );
}

function AddQuestionnaireDialog({ open, onClose, onSubmit }: {
  open: boolean; onClose: () => void; onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(''); setErr(null); } }, [open]);
  async function go() {
    if (!name.trim()) { setErr('Name is required'); return; }
    setLoading(true); setErr(null);
    try { await onSubmit(name.trim()); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Save failed'); }
    finally { setLoading(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New Questionnaire</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='e.g. "Standard installation QC"'
          />
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={loading} />
            <Button onClick={go} disabled={loading}>{loading ? 'Saving…' : 'Create'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
