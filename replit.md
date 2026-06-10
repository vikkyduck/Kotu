# Рабочая среда (режим Кота)

A warm, glassmorphic Russian-language AI "work environment" for a psychologist/lecturer named Кот — transcribe recordings, prepare lectures, and build presentations in a calm, reassuring single-page interface. All flows are currently simulated client-side (no backend).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/kot/` — the main web app (React + Vite), served at root path `/`
  - `src/components/` — screen components: `Home`, `Transcribe`, `Lecture`, `Slides`, `How`, `TopBar`, `FixSheet`, `Toast`
  - `src/hooks/use-app.tsx` — global state/navigation context
  - `src/hooks/use-theme.ts` — light/dark theme (data-theme attribute on <html>, persisted to localStorage)
  - `src/hooks/use-liquid-light.ts` — pointer-tracking glass highlight effect
  - `src/lib/celebrate.ts` — particle/ring success animation
  - `src/lib/icons.tsx` — inline SVG icon set
  - `src/index.css` — full design system (custom properties, light/dark themes, component styles, keyframes)
- `attached_assets/kot-prototype_*.html` — original source prototype; `kot-prototype-clean.html` is the font-stripped readable copy

## Architecture decisions

- Frontend-only: every flow (transcription, lecture, slides) is simulated client-side with timers. No backend, no OpenAPI/codegen, no DB.
- Faithful port of a fully-designed HTML prototype — the bespoke CSS design system lives in `src/index.css` rather than being rewritten as Tailwind utilities.
- Theme switching uses a `data-theme="light|dark"` attribute on `<html>` (matching the prototype), not the shadcn `.dark` class.
- Single-page screen switching via app context state, not the router.

## Product

A calm, humanized AI work environment (in Russian) for Кот:
- **Расшифровать запись** (working): upload an audio recording → simulated processing → editable transcript with privacy options (hide patient names, mark speakers) and per-line "fix it" helpers.
- **Подготовить лекцию** (coming soon): topic + duration + optional book → generated chapters.
- **Собрать презентацию** (coming soon): pick a lecture → generated slide grid.
- **Как это работает**: a plain-language explainer page.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
