'use client';

/*
 * Client Profile → Overview.
 *
 * The master row, EDITABLE IN PLACE. It replaces two older surfaces at once:
 * the read-only OverviewPanel that listed twelve fields as static cards, and
 * the "Edit Basic Info" button that opened ClientFormDialog on top of the
 * dialog you were already in. One less modal, one less click, and the value
 * you are reading is the field you are editing.
 *
 * ClientFormDialog still owns CREATE — that flow orchestrates document uploads
 * and the primary/secondary SPOC upsert after the insert, none of which apply
 * to an edit. Deliberately NOT refactored into one shared field component: the
 * two forms have different layouts (legacy two-column create form vs. this
 * form + checklist split) and different field sets, so a shared component would
 * need a layout prop for every group — an abstraction over one real shape.
 * They share the constants and the PUT endpoint, which is the part that matters.
 *
 * ─── THE FOUR NAMES ─────────────────────────────────────────────────────────
 * client_name is the master/legal name. The other three are presentation:
 *   display_name   how it reads in the CRM
 *   billing_name   how it reads on an invoice (PRE-EXISTING legacy column —
 *                  ClientDaoImpl writes it, the invoice module reads it as
 *                  invoiceName; this screen did not introduce it)
 *   tech_app_name  how it reads on a technician's phone, where a job card has
 *                  very little width
 * display_name and tech_app_name arrive with
 * migrations/executed/2026-08-25-client-profile-names.sql. Until it is applied
 * the detail payload has no such KEYS at all (the endpoint SELECTs *), so the
 * two inputs are hidden rather than shown-and-silently-discarded — updateClient
 * drops writes to columns the DB does not have.
 *
 * ─── WHAT THE COMP SHOWS THAT THE DATA DOES NOT MEAN ────────────────────────
 * Two labels in the design comp describe something other than what the column
 * holds, and the columns win:
 *   Booking cut-off   the comp shows a clock time ("4:00 PM"); booking_cut_off
 *                     is an INTEGER NUMBER OF HOURS (Joi caps it at 48) and is
 *                     consumed as hours by job.service.js. Rendered as hours.
 *   Collected by      the comp shows a person ("Aditi Rao (EasyFix Ops)");
 *                     collected_by is a legacy 3-value enum for which PARTY
 *                     collects (Easyfixer / Easyfix / Client), not a user FK.
 *                     Rendered as the enum.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, RotateCcw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetchOnce, invalidateFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import { COLLECTED_BY_OPTIONS, type ClientDetail } from '@/lib/client-types';
import { DocumentChecklist } from '@/components/client/DocumentChecklist';
import { SectionShell } from '@/components/client/SectionShell';

type City = { city_id: number; city_name: string };

/*
 * Local form shape. Everything is a STRING — including the numeric fields —
 * because a controlled <input> round-trips strings and coercing on every
 * keystroke makes "12" briefly unrepresentable while you delete the 2.
 * Coercion happens once, on submit.
 */
type FormState = {
  clientName: string;
  displayName: string;
  billingName: string;
  techAppName: string;
  clientType: string;
  referenceCode: string;
  clientEmail: string;
  clientAddress: string;
  bookingCutOff: string;
  collectedBy: string;
  building: string;
  landmark: string;
  cityId: string;
  pincode: string;
  travelDistance: string;
  maxOrders: string;
  couponCode: string;
  monthlyRevenue: string;
  cinNumber: string;
  panNumber: string;
  mouContact: string;
};

const str = (v: unknown) => (v == null ? '' : String(v));

function seed(c: ClientDetail): FormState {
  const r = c as Record<string, unknown>;
  return {
    clientName:     str(c.client_name),
    displayName:    str(r.display_name),
    billingName:    str(r.billing_name),
    techAppName:    str(r.tech_app_name),
    clientType:     str(c.client_type) || 'b2b',
    referenceCode:  str(c.reference_code),
    clientEmail:    str(c.client_email),
    clientAddress:  str(c.client_address),
    bookingCutOff:  str(c.booking_cut_off),
    collectedBy:    str(c.collected_by),
    building:       str(r.building),
    landmark:       str(r.landmark),
    cityId:         str(r.client_city_id ?? c.city_id),
    pincode:        str(r.client_pincode),
    travelDistance: str(c.travel_distance),
    maxOrders:      str(c.max_orders),
    couponCode:     str(r.coupon_code),
    monthlyRevenue: c.monthly_revenue == null ? '' : String(c.monthly_revenue),
    cinNumber:      str(r.tan_number),
    panNumber:      str(r.client_pan_number),
    mouContact:     str(r.client_aadhaar),
  };
}

export function ProfileOverviewSection({
  client, canEdit, onSaved,
}: {
  client: ClientDetail;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => seed(client));
  const [snapshot, setSnapshot] = useState<FormState>(() => seed(client));
  const [saving, setSaving] = useState(false);

  // Re-seed when the row is refetched (e.g. after a save elsewhere on the
  // page) or when the route swaps to a different client.
  useEffect(() => {
    const next = seed(client);
    setForm(next);
    setSnapshot(next);
  }, [client]);

  const { data: cities } = useFetchOnce<City[]>('/shared/lookup/cities?limit=1000');
  const cityOptions = useMemo(
    () => (cities ?? []).map((c) => ({ value: c.city_id, label: c.city_name })),
    [cities],
  );

  /*
   * Column-probe gate. hasOwnProperty is true as soon as the column EXISTS
   * (the value may still be null) and false when the migration has not run —
   * see the header note on why hiding beats showing a dead field.
   */
  const hasDisplayName = Object.prototype.hasOwnProperty.call(client, 'display_name');
  const hasTechAppName = Object.prototype.hasOwnProperty.call(client, 'tech_app_name');

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(snapshot),
    [form, snapshot],
  );

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /*
   * "Client name auto-fills the three names below" (per the comp). Only fields
   * that are EMPTY or still mirroring the previous master name follow along —
   * a name ops deliberately set to something different is never overwritten.
   */
  function setClientName(value: string) {
    setForm((f) => {
      const follows = (v: string) => v === '' || v === f.clientName;
      return {
        ...f,
        clientName: value,
        displayName: follows(f.displayName) ? value : f.displayName,
        billingName: follows(f.billingName) ? value : f.billingName,
        techAppName: follows(f.techAppName) ? value : f.techAppName,
      };
    });
  }

  async function save() {
    if (!canEdit || saving) return;
    if (!form.clientName.trim()) {
      showToast({ variant: 'error', message: 'Client Name is required.' });
      return;
    }
    if (form.pincode && !/^[0-9]{6}$/.test(form.pincode)) {
      showToast({ variant: 'error', message: 'Pincode must be 6 digits.' });
      return;
    }

    /*
     * Text fields send '' so an operator can CLEAR one — the Joi schema allows
     * '' on each of them and the column is nullable. Numeric fields cannot:
     * Joi.number() rejects '', so a blank omits the key and leaves the column
     * as-is. monthlyRevenue is the exception the schema allows null for, so it
     * is the one number that can actually be cleared.
     */
    const payload: Record<string, unknown> = {
      clientName:    form.clientName.trim(),
      clientType:    form.clientType,
      referenceCode: form.referenceCode,
      clientEmail:   form.clientEmail,
      clientAddress: form.clientAddress,
      building:      form.building,
      landmark:      form.landmark,
      pincode:       form.pincode,
      couponCode:    form.couponCode,
      cinNumber:     form.cinNumber,
      panNumber:     form.panNumber,
      mouContact:    form.mouContact,
      billingName:   form.billingName,
      monthlyRevenue: form.monthlyRevenue.trim() === '' ? null : Number(form.monthlyRevenue),
    };
    if (hasDisplayName) payload.displayName = form.displayName;
    if (hasTechAppName) payload.techAppName = form.techAppName;

    const num = (key: string, raw: string) => {
      if (raw.trim() === '') return;
      const n = Number(raw);
      if (Number.isFinite(n)) payload[key] = n;
    };
    num('bookingCutOff', form.bookingCutOff);
    num('collectedBy', form.collectedBy);
    num('cityId', form.cityId);
    num('travelDistance', form.travelDistance);
    num('maxOrders', form.maxOrders);

    setSaving(true);
    try {
      await api.put(`/admin/clients/${client.client_id}`, payload as never);
      invalidateFetch((k) => k.startsWith('/admin/clients'));
      setSnapshot(form);
      onSaved();
      showToast({ variant: 'success', message: 'Client updated.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Save failed.' });
    } finally { setSaving(false); }
  }

  const ro = !canEdit;

  return (
    <SectionShell
      title="Overview"
      note={canEdit
        ? 'The client master. Edit any field, then Save Changes.'
        : 'The client master. Read-only — you do not hold the Client Edit permission.'}
    >
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-6">
        {/* ── Left: the master fields ──────────────────────────────── */}
        <div className="space-y-4">
          <Field label="Client Name (Auto-Fills The Three Names Below)" required>
            <Input value={form.clientName} disabled={ro} maxLength={255}
              onChange={(e) => setClientName(e.target.value)} />
          </Field>

          <Row>
            {hasDisplayName && (
              <Field label="CRM Display Name" hint="How this client reads in CRM lists.">
                <Input value={form.displayName} disabled={ro} maxLength={255}
                  onChange={(e) => set('displayName', e.target.value)} />
              </Field>
            )}
            <Field label="Billing Name" hint="The name printed on invoices.">
              <Input value={form.billingName} disabled={ro} maxLength={255}
                onChange={(e) => set('billingName', e.target.value)} />
            </Field>
          </Row>

          {hasTechAppName && (
            <Field label="Technician-App Name" hint="Short form shown on a technician's job card.">
              <Input value={form.techAppName} disabled={ro} maxLength={255}
                onChange={(e) => set('techAppName', e.target.value)} />
            </Field>
          )}

          <Row>
            <Field label="Type">
              <select
                className="border rounded h-9 px-2 text-sm w-full bg-background disabled:opacity-60"
                value={form.clientType}
                disabled={ro}
                onChange={(e) => set('clientType', e.target.value)}
              >
                <option value="b2b">B2B</option>
                <option value="b2c">B2C</option>
              </select>
            </Field>
            <Field label="Reference Code" hint="Also the code behind this client's public booking link.">
              <Input value={form.referenceCode} disabled={ro} maxLength={50}
                onChange={(e) => set('referenceCode', e.target.value)} />
            </Field>
          </Row>

          <Field label="Email">
            <Input type="email" value={form.clientEmail} disabled={ro} maxLength={255}
              onChange={(e) => set('clientEmail', e.target.value)} />
          </Field>

          <Field label="Registered Address">
            <textarea
              className="border rounded px-2 py-1.5 text-sm w-full bg-background min-h-[72px] disabled:opacity-60"
              value={form.clientAddress}
              disabled={ro}
              maxLength={500}
              onChange={(e) => set('clientAddress', e.target.value)}
            />
          </Field>

          <Row>
            <Field label="Building">
              <Input value={form.building} disabled={ro} maxLength={200}
                onChange={(e) => set('building', e.target.value)} />
            </Field>
            <Field label="Landmark">
              <Input value={form.landmark} disabled={ro} maxLength={200}
                onChange={(e) => set('landmark', e.target.value)} />
            </Field>
          </Row>

          <Row>
            <Field label="City">
              <SearchSelect
                value={form.cityId === '' ? '' : Number(form.cityId)}
                onChange={(v) => set('cityId', v)}
                options={cityOptions}
                disabled={ro}
                placeholder="Select a city…"
              />
            </Field>
            <Field label="Pincode">
              <Input value={form.pincode} disabled={ro} maxLength={6} inputMode="numeric"
                onChange={(e) => set('pincode', e.target.value.replace(/\D/g, ''))} />
            </Field>
          </Row>

          <Row>
            <Field label="Booking Cut-off (Hours)" hint="Lead time before an appointment can be booked. 0–48.">
              <Input type="number" min={0} max={48} value={form.bookingCutOff} disabled={ro}
                onChange={(e) => set('bookingCutOff', e.target.value)} />
            </Field>
            <Field label="Collected By" hint="Which party collects payment on a job.">
              <select
                className="border rounded h-9 px-2 text-sm w-full bg-background disabled:opacity-60"
                value={form.collectedBy}
                disabled={ro}
                onChange={(e) => set('collectedBy', e.target.value)}
              >
                <option value="">— Not Set —</option>
                {COLLECTED_BY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
          </Row>

          <Row>
            <Field label="Travel Distance (Km)">
              <Input type="number" min={0} value={form.travelDistance} disabled={ro}
                onChange={(e) => set('travelDistance', e.target.value)} />
            </Field>
            <Field label="Max Orders" hint="Legacy form label was 'Min Orders'; the column is max_orders.">
              <Input type="number" min={0} value={form.maxOrders} disabled={ro}
                onChange={(e) => set('maxOrders', e.target.value)} />
            </Field>
          </Row>

          <Row>
            <Field label="Coupon Code">
              <Input value={form.couponCode} disabled={ro} maxLength={50}
                onChange={(e) => set('couponCode', e.target.value)} />
            </Field>
            <Field label="Monthly Revenue (₹)">
              <Input type="number" min={0} value={form.monthlyRevenue} disabled={ro}
                onChange={(e) => set('monthlyRevenue', e.target.value)} />
            </Field>
          </Row>

          <Row>
            <Field label="CIN Number" hint="Stored on the legacy tan_number column.">
              <Input value={form.cinNumber} disabled={ro} maxLength={100}
                onChange={(e) => set('cinNumber', e.target.value)} />
            </Field>
            <Field label="PAN Number">
              <Input value={form.panNumber} disabled={ro} maxLength={50}
                onChange={(e) => set('panNumber', e.target.value)} />
            </Field>
          </Row>

          <Field label="MOU Contact" hint="Stored on the legacy client_aadhaar column.">
            <Input value={form.mouContact} disabled={ro} maxLength={200}
              onChange={(e) => set('mouContact', e.target.value)} />
          </Field>

          <div className="text-xs text-muted-foreground border-t pt-3">
            Client ID <span className="font-mono">{client.client_id}</span>
            {client.insert_date && <> · Created {formatDate(String(client.insert_date))}</>}
            {client.update_date != null && <> · Updated {formatDate(String(client.update_date))}</>}
          </div>

          {canEdit && (
            <div className="flex items-center gap-2 border-t pt-3">
              <Button onClick={save} disabled={!dirty || saving}>
                {saving ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Save className="size-4 mr-1" />}
                {saving ? 'Saving…' : 'Save Changes'}
              </Button>
              <Button variant="outline" onClick={() => setForm(snapshot)} disabled={!dirty || saving}>
                <RotateCcw className="size-4 mr-1" /> Discard
              </Button>
              {dirty && <span className="text-xs text-warning-strong">Unsaved changes</span>}
            </div>
          )}
        </div>

        {/* ── Right: documents + imagery ───────────────────────────── */}
        <DocumentChecklist clientId={client.client_id} canEdit={canEdit} />
      </div>
    </SectionShell>
  );
}

/* ── Field/Row primitives — local, because they exist only for this grid ── */

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>;
}

function Field({
  label, hint, required, children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">
        {label}{required && <span className="text-urgent"> *</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
