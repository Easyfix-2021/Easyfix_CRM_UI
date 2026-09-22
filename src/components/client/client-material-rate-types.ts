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
 */

export type ClientMaterialRateBrand = { brand_id: number; brand_name: string };

export type ClientMaterialRateStateEntry = {
  state_price_id: number;
  price: number;
  state_ids: number[];
};

export type ClientMaterialRateGroup = {
  group_id: number;
  price: number;
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

/* GET /admin/clients/:clientId/material-rates/options — master materials not
   yet on this client's card, for the Add Material picker. */
export type ClientMaterialRateOption = {
  material_id: number;
  material_name: string;
};
