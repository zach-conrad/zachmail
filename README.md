# ZachMail

A private, keyboard-first, Superhuman-style mail client for all of Zach's accounts.
Web at **mail.zachconrad.dev**, plus macOS (Tauri) and iOS (Expo) apps.

Speed is the #1 requirement: every user action updates the UI from local state in the same
frame, and the perf budgets (architecture §1a) are CI gates. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

| Path              | What                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| `apps/web`        | React 19 + Vite SPA (also the future Tauri frontend)                  |
| `apps/api`        | Hono API, bundled into one Vercel Function at `/api/*`                |
| `apps/worker`     | Node job worker for Fly.io (sync, outbox, schedulers)                 |
| `packages/core`   | Keymap registry (single source for keys, palette, cheat sheet, menus) |
| `packages/db`     | Drizzle schema + SQL migrations (Supabase Postgres)                   |
| `packages/tokens` | Design tokens (`tokens.json` → CSS variables; Swift theme later)      |
| `packages/config` | Shared tsconfig and ESLint                                            |
| `infra`           | Vercel build output assembly, Fly config                              |

## Develop

```sh
pnpm install
pnpm --filter @zachmail/web dev     # http://localhost:5173 (demo mode without Supabase env)
pnpm --filter @zachmail/api dev     # http://localhost:8787/api, needs SUPABASE_URL + ALLOWED_EMAILS
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm size
```

## One-time setup (production)

1. **Supabase**: create the project, then apply `packages/db/migrations/*.sql` in order
   (`DATABASE_URL=... pnpm --filter @zachmail/db migrate`). Insert your email into
   `allowed_users`. Enable Auth → Hooks → _Before User Created_ →
   `public.hook_before_user_created`. Enable the Google provider and passkeys.
2. **Vercel**: import this repo (root directory = repo root; `vercel.json` handles the build).
   Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `ALLOWED_EMAILS`.
   Add the domain `mail.zachconrad.dev` and a CNAME to `cname.vercel-dns.com`.
3. **Fly.io**: `fly apps create zachmail-worker`, `fly secrets set DATABASE_URL=...`
   (session-mode connection string, port 5432), then set the repo variable `FLY_ENABLED=true`
   and secret `FLY_API_TOKEN` so pushes to `main` deploy it.
