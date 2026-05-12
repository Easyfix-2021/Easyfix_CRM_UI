# Easyfix_CRM_UI — Project Instructions for Claude

Next.js 15 App Router + Tailwind + shadcn-style components. Consumes `EasyFix_Backend`
at `/api/admin/*`, `/api/auth/*`, `/api/shared/*`.

**Master spec**: `/Users/harshit/Documents/GitHub/EasyFix Docs/EasyFix_Platform_Blueprint.md` §6.
This repo is the CRM (staff-facing) frontend — formerly tracked as Phase 1B. The migration is complete across all phases as of 2026-05-12.

## Visual style (match legacy EasyFix_CRM)

- **Font**: Mulish (loaded via `next/font/google` in `layout.tsx`).
- **Sidebar**: dark slate (Metronic-style) — `bg-sidebar` token resolved in `globals.css`.
- **Palette**: Metronic blue `#2E86DE`-ish for primary actions, warm orange accent for escalations,
  status-coloured pill badges matching legacy `job_status` codes.
- **Density**: compact data tables (`.data-table` utility in `globals.css`) — legacy jobs/easyfixers
  are dense; match the density.
- **Icons**: `lucide-react`.

## Architecture

- **Route groups**: `app/login/` is public; `app/(authed)/` has the sidebar+navbar layout.
- **Auth**: JWT token in `localStorage` (`crm_auth_token`) + httpOnly cookie from backend.
  `lib/api.ts` wraps fetch, includes `credentials: 'include'`, and adds `Authorization: Bearer`
  when token is present.
- **API base**: `NEXT_PUBLIC_API_URL` (default `http://localhost:5100/api`).
- **Port**: `5180` (matches blueprint + `EasyFix_Backend` CORS allowlist).

## Step-by-step status (blueprint §10 Phase 1B)

- [x] Step 1: Scaffold Next.js + Tailwind + shadcn-style components (Button, Input, Card, Label, Badge, Tabs, Dialog)
- [x] Step 2: Login page + OTP (2-step flow: identifier → 4-digit OTP)
- [x] Step 3: Sidebar + Navbar + protected route group
- [x] Step 4: Dashboard with 6 stat cards + recent jobs table
- [x] Step 5: Easyfixer list + new + detail (CRUD)
- [x] Step 6: Job list (7 status tabs) + new + detail
- [x] Step 7: Excel upload page with dry-run toggle and per-row report table
- [x] Step 8: Job owner change (dialog on detail page)
- [x] Step 9: Auto-assignment preview + commit UI

## Local dev

```bash
cp .env.example .env.local
npm install
npm run dev              # http://localhost:5180
npm run build && npm start
```

The backend (`EasyFix_Backend`) must be running on :5100 for API calls to succeed. Next.js
`rewrites` in `next.config.mjs` proxy `/api/*` → backend, so the browser never hits the backend
origin directly (avoids CORS issues on same-origin cookie handling).

## Next phase

Phase 4 (Client Dashboard UI) and Phase 5 (Technician Mobile App) live in separate repos
(`Client_UI` and `EasyFixer_App`). This repo stays focused on the internal CRM.

## Important Rules
- Never modify code outside the scope of the current task. Do not touch files, functions, or flows unrelated to what the user has explicitly asked for.
- Always build/compile the project after making changes to catch errors before sharing the final summary.
- Write optimized code and reuse existing utilities. Check if equivalent logic already exists before writing new helpers.
- Always share a summary at the end of each response: (1) what was the issue, (2) findings/root cause, (3) changes made and where.
