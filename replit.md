# Рабочая среда (режим Кота)

A warm, glassmorphic Russian-language AI "work environment" for a psychologist/lecturer named Кот — transcribe recordings, prepare lectures, and build presentations in a calm, reassuring single-page interface. Transcription is fully functional (real audio upload → OpenAI transcription → saved to Postgres). Lecture and slides flows are still simulated client-side.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (binds to `PORT`, mounted at `/api` via the proxy)
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

- Transcription is backend-backed: `artifacts/kot` (React) uploads audio to `artifacts/api-server` (Express) at `/api/transcriptions/upload`, which transcribes via the OpenAI AI Integration and persists segments to Postgres (Drizzle). Lecture and slides flows remain simulated client-side with timers.
- Contract-first: endpoints are defined in `lib/api-spec/openapi.yaml`; React Query hooks and Zod schemas are generated via `pnpm --filter @workspace/api-spec run codegen`. The upload endpoint is multipart and handled manually (not in the OpenAPI spec).
- Transcription pipeline (`artifacts/api-server/src/lib/transcription.ts`): every recording (any size, any format) → ffmpeg decodes and re-encodes to mono 16 kHz mp3, splitting into 10-min chunks (`splitAudioIntoChunks`) → each mp3 chunk transcribed via `gpt-4o-transcribe` (bounded concurrency) → per-chunk structuring pass (json_object) that splits into segments, optionally wraps personal data (names/cities/addresses) in `[[...]]` markers and labels speakers ("Вы"/"Собеседник") → segments stitched in order. Names are preserved (not destroyed): when hiding is on, the client renders each `[[name]]` as a clickable «имя скрыто» chip that reveals the real name (visible only to Кот) and re-serializes the markers on edit. If the structuring JSON fails to parse, the fallback still masks (secondary wrap pass, then a capitalized-word heuristic) so names never leak.
- OpenAI access is via the Replit AI Integration (`@workspace/integrations-openai-ai-server`), using `AI_INTEGRATIONS_OPENAI_*` env vars — no user-supplied API key.
- Transcription models cap each request at 1500 s (25 min) and 25 MB — the duration cap is the real bottleneck, so long recordings are split server-side with ffmpeg (available in the env). Because ffmpeg always normalizes the input to mp3 first, broad input formats work (m4a, mp3, wav, ogg/opus, webm, aac, amr, wma, video containers, …); the upload filter accepts any `audio/*` or `video/*` type (audio-only webm reports `video/webm`) or a recognised extension. Upload uses multer disk storage with a 1 GB cap; oversized files get a friendly Russian error on `LIMIT_FILE_SIZE` (413). Audio is split in a temp dir and deleted after transcription.
- Faithful port of a fully-designed HTML prototype — the bespoke CSS design system lives in `src/index.css` rather than being rewritten as Tailwind utilities.
- Theme switching uses a `data-theme="light|dark"` attribute on `<html>` (matching the prototype), not the shadcn `.dark` class.
- Single-page screen switching via app context state, not the router.

## Product

A calm, humanized AI work environment (in Russian) for Кот:
- **Расшифровать запись** (working, real): drag-and-drop or pick an audio recording → real transcription → editable transcript saved to the database, with privacy options (hide patient names, mark speakers). Hidden names show as «имя скрыто» and reveal on click (visible only to Кот); the downloaded .txt keeps them masked when hiding is on. Edits auto-save on blur; "Сохранить текст" downloads a .txt. Saved recordings appear under "Продолжить начатое" on the home screen.
- **Подготовить лекцию** (coming soon): topic + duration + optional book → generated chapters.
- **Собрать презентацию** (coming soon): pick a lecture → generated slide grid.
- **Как это работает**: a plain-language explainer page.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
