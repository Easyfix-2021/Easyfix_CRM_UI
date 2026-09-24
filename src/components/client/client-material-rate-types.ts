/*
 * Types for the client Materials rate-card section (RateCardsTab.tsx +
 * ClientMaterialRateDialog.tsx). Mirrors the phase-1 manage-materials shapes
 * (settings/manage-materials/types.ts) scoped by client, per sub-project C:
 * EasyFix_Backend/docs/superpowers/specs/2026-09-18-client-material-rates-design.md
 *
 * The backend for this contract is being written in parallel and the spec's
 * "API" section doesn't spell out the exact GET /material-rates response
 * shape — these field names (`master_price_today` in particular, needed to
 * compare against `master_price_seen` for the review flag) are this side's
 * best-effort mirror of the spec's data model + phase-1 naming conventions.
 * See the delivery report for what was assumed.
 *
 * 2026-09-24 tx_share redesign (owner-approved): every group and every state
 * override now also carries `tx_share`; the picker moved to picking a
 * MATERIAL-BRAND PAIR straight from the new master-rows endpoint (below)
 * rather than a free brand multi-select — see ClientMaterialPriceEditor.tsx.
 */

export type ClientMaterialRateBrand = { brand_id: number; brand_name: string };

export type ClientMaterialRateStateEntry = {
  state_price_id: number;
  price: number;
  tx_share: number;
  state_ids: number[];
};

export type ClientMaterialRateGroup = {
  group_id: number;
  price: number;
  tx_share: number;
  brands: ClientMaterialRateBrand[];
  states: ClientMaterialRateStateEntry[];
  /* Master price when this group's price was last saved/accepted. Null =
     never flagged (pre-column row, or a data fix) — never show the banner. */
  master_price_seen: number | null;
  /* Today's resolved master price for this group's brand set — compared
     against master_price_seen to raise the review flag. */
  master_price_today: number | null;
};

export type ClientMaterialRateItem = {
  material_id: number;
  material_name: string;
  groups: ClientMaterialRateGroup[];
};

/* A single material_id used as an Edit dialog's target identity — no groups
   attached (the dialog is always seeded from the full `ClientMaterialRateItem`
   it's opened for). */
export type ClientMaterialRateOption = {
  material_id: number;
  material_name: string;
};

/* GET /admin/clients/:clientId/material-rates/master-rows?search=&limit= —
   one row per MATERIAL-BRAND pair (brand_id/brand_name null = "No Brand"),
   with the master price and per-state master prices, for the Add Materials
   picker. `label` is the ready-to-render "Adapter 5A - Havells" / "Adapter
   5A" string. */
export type MasterMaterialStatePrice = { state_id: number; state_name: string; price: number };
export type MasterMaterialRateRow = {
  material_id: number;
  material_name: string;
  brand_id: number | null;
  brand_name: string | null;
  label: string;
  price: number;
  state_prices: MasterMaterialStatePrice[];
};
export type MasterMaterialRateRowsResponse = { items: MasterMaterialRateRow[] };
