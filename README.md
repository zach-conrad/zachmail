# ZachMail

A private, keyboard-first, Superhuman-style mail client for all of Zach's accounts.
Web at **mail.zachconrad.dev**, plus macOS (Tauri) and iOS (Expo) apps.

Speed is the #1 requirement: every user action updates the UI from local state in the same
frame, and the perf budgets (architecture §1a) are CI gates. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

| Path              | What                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| `apps/web`        | React 19 + Vite SPA (also the Tauri frontend)                         |
| `apps/api`        | Hono API, bundled into one Vercel Function at `/api/*`                |
| `apps/worker`     | Node job worker for Fly.io (sync, outbox, schedulers)                 |
| `hub/core`        | Wire types, sync client, keymap registry (keys, palette, cheat sheet) |
| `hub/db`          | Drizzle schema + SQL migrations (Supabase Postgres)                   |
| `hub/engine`      | Job handlers shared by the worker and API                             |
| `hub/local-store` | Client SQLite replica                                                 |
| `hub/ai`          | Claude client and prompts                                             |
| `hub/tokens`      | Design tokens (`tokens.json` → CSS variables; Swift theme later)      |
| `hub/config`      | Shared tsconfig and ESLint                                            |
| `modules/mail/*`  | Mail-only packages: `providers` (Gmail, Graph), `mime`                |
| `infra`           | Vercel build output assembly, Fly config                              |

## Develop

```sh
pnpm install
pnpm --filter @zachhub/web dev     # http://localhost:5173 (demo mode without Supabase env)
pnpm --filter @zachhub/api dev     # http://localhost:8787/api, needs SUPABASE_URL + ALLOWED_EMAILS
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm size
```

## One-time setup (production)

1. **Supabase**: create the project, then apply `hub/db/migrations/*.sql` in order
   (`DATABASE_URL=... pnpm --filter @zachhub/db migrate`). Insert your email into
   `allowed_users`. Enable Auth → Hooks → _Before User Created_ →
   `public.hook_before_user_created`. Enable the Google provider and passkeys. Create the
   Vault secret `zachmail_token_key` (32 random bytes, base64: `openssl rand -base64 32`);
   it encrypts provider refresh tokens.
2. **Google Cloud** (Gmail): create an OAuth client (Web) with redirect URI
   `https://mail.zachconrad.dev/api/accounts/callback/gmail`, enable the Gmail API, and set
   the consent screen to **In production** (in "Testing", refresh tokens expire after 7 days).
   For push: create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` the
   Publisher role on it, and add a push subscription to
   `https://mail.zachconrad.dev/webhooks/gmail` with authentication enabled (a service
   account of yours; the audience is the webhook URL).
3. **Microsoft** (Outlook / Microsoft 365, optional): in the Entra admin center
   (entra.microsoft.com → App registrations → New registration) create an app for
   "Accounts in any organizational directory and personal Microsoft accounts", with the Web
   redirect URI `https://mail.zachconrad.dev/api/accounts/callback/graph`. Under API
   permissions add Microsoft Graph delegated `Mail.ReadWrite`, `Mail.Send`,
   `MailboxSettings.Read`, `User.Read`, `offline_access`; under Certificates & secrets make a
   client secret (note its expiry). Work tenants that block user consent, which GoDaddy-managed
   Microsoft 365 tenants often do, need a tenant admin to approve the app once: either
   "Grant admin consent" on the API permissions page, or the in-app flow
   (`POST /api/accounts/connect/graph?admin=1`), which the callback suggests on its own when
   Microsoft says admin approval is needed. Sign-in through a federated tenant (GoDaddy,
   Okta, ADFS) is Microsoft's normal redirect; nothing to configure.
4. **Vercel**: import this repo (root directory = repo root; `vercel.json` handles the build).
   Add the domain `mail.zachconrad.dev` and a CNAME to `cname.vercel-dns.com`. Env:

   | Variable                                             | Value                                             |
   | ---------------------------------------------------- | ------------------------------------------------- |
   | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase project URL and publishable key          |
   | `SUPABASE_URL`                                       | same URL (server side)                            |
   | `ALLOWED_EMAILS`                                     | your login email                                  |
   | `DATABASE_URL`                                       | Supabase pooler URL, transaction mode (port 6543) |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`           | the OAuth client                                  |
   | `GMAIL_PUBSUB_TOPIC`                                 | `projects/<project>/topics/<topic>`               |
   | `GMAIL_PUSH_AUDIENCE`                                | `https://mail.zachconrad.dev/webhooks/gmail`      |
   | `GMAIL_PUSH_SERVICE_ACCOUNT`                         | the push subscription's service account email     |
   | `OAUTH_STATE_SECRET`, `IMAGE_PROXY_SECRET`           | random strings (`openssl rand -hex 32`)           |
   | `SUPABASE_SERVICE_ROLE_KEY`                          | service role key (signs attachment uploads)       |
   | `ANTHROPIC_API_KEY` (optional)                       | Claude API key; AI writing help is off without it |
   | `VAPID_PUBLIC_KEY`                                   | Web Push public key (see step 4)                  |
   | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`     | the Entra app (Outlook accounts)                  |
   | `GRAPH_WEBHOOK_SECRET`                               | random string; Outlook push is off without it     |
   | `MICROSOFT_TENANT`                                   | optional; defaults to `common`                    |

5. **Fly.io**: `fly apps create zachmail-worker`, then `fly secrets set` `DATABASE_URL`
   (session mode, port 5432), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_PUBSUB_TOPIC`
   `IMAGE_PROXY_SECRET` (same value as Vercel), plus `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` for attachments, `ANTHROPIC_API_KEY` to turn on AI triage
   (category, one-line summary and needs-reply on new inbox threads), and the same `MICROSOFT_*` and
   `GRAPH_WEBHOOK_SECRET` values as Vercel for Outlook. Set the repo variable `FLY_ENABLED=true`
   and secret `FLY_API_TOKEN` so pushes to `main` deploy it.
   For notifications, generate Web Push keys once (`npx web-push generate-vapid-keys`) and
   set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (`mailto:` you) on the
   worker; the public key also goes to Vercel. Then ⌘K → _Notification settings_ → Turn on.

6. **Claude connector** (optional): lets Claude search, read, triage, draft and send your mail.
   In Supabase → Auth → URL Configuration, add the redirect URL
   `https://mail.zachconrad.dev/api/mcp/oauth/callback`. Vercel already has what it needs
   (`VITE_SUPABASE_PUBLISHABLE_KEY` and `OAUTH_STATE_SECRET`; set `MCP_TOKEN_SECRET` to sign
   connector tokens with their own key, and change it to sign every connector out). Then in
   claude.ai → Settings → Connectors → Add custom connector, use
   `https://mail.zachconrad.dev/api/mcp`, click Connect, sign in with Google and Allow. Claude
   Code: `claude mcp add --transport http zachmail https://mail.zachconrad.dev/api/mcp`.
