# Deep Skill flow icons (Figma exports)

The Deep Skills picker on the public **profile-update** form (and, later, the tech
app) shows an illustration icon per **service category** and a small icon per
**service type**. These are NOT in the database — drop the exported Figma art here.

## Where

- `categories/<slug>.png`      — category grid + rollup tiles
- `service-types/<slug>.png`   — left service-type rail icons

## Naming (`<slug>`)

The slug is derived from the category / service-type **name** exactly as it comes
from the DB: lowercased, trimmed, every run of non-alphanumeric characters
replaced by a single `-`, and leading/trailing `-` removed.

Examples:
- `Carpenter`                          → `categories/carpenter.png`
- `Electrical`                         → `categories/electrical.png`
- `Fitness Machines`                   → `categories/fitness-machines.png`
- `Wooden Furniture Installation`      → `service-types/wooden-furniture-installation.png`
- `Digital Lock - (Mobile Setting)`   → `service-types/digital-lock-mobile-setting.png`

## Format

- Square PNG (transparent background), ~120×120 px is plenty (rendered 34–44 px).
- Until a file exists for a given name, the UI shows a coloured first-letter tile,
  so the flow works with or without the art. Add files incrementally.

The slug function lives in `src/app/public/profile-update/[token]/page.tsx`
(`dsSlug`). Keep it in sync if the naming rule ever changes.
