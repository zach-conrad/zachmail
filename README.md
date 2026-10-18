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
| `hub/backup`      | Nightly offsite backup, settings export, restore script               |
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

6. **Offsite backup** (the only backup while Supabase is on the free plan): every night the worker
   writes first-party data (accounts without tokens, split rules, snippets, drafts, reminders,
   notification rules, plus contacts for reading) as gzipped NDJSON to an S3-compatible bucket
   and deletes copies older than 30 days. Mail itself is not in it; a resync brings it back.
   - **Cloudflare R2** (default): create a bucket and an R2 API token with Object Read & Write
     on it. Endpoint `https://<account id>.r2.cloudflarestorage.com`, region `auto`.
   - **Backblaze B2**: create a private bucket and an application key for it. Endpoint
     `https://s3.<region>.backblazeb2.com`, region e.g. `us-west-004`.

   `fly secrets set` on the worker:

   | Variable                                                 | Value                                  |
   | -------------------------------------------------------- | -------------------------------------- |
   | `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`                 | from above; the job is off while unset |
   | `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | the token or application key           |
   | `BACKUP_S3_REGION`                                       | optional; `auto` (R2) by default       |
   | `BACKUP_PREFIX`                                          | optional; `zachhub/` by default        |
   | `BACKUP_RETENTION_DAYS`, `BACKUP_HOUR_UTC`               | optional; `30` and `10` (3 am Pacific) |

   The worker logs `ALERT backup failed` or `ALERT no good backup in 48h` when something is
   wrong, and `GET /api/backup/status` shows the last run. `GET /api/export` downloads the same
   file for your own data (the settings Export button).

   **Restore** into a database with migrations applied (`DATABASE_URL` in session mode):

   ```sh
   pnpm --filter @zachhub/backup backups                 # list the bucket (BACKUP_S3_* set)
   pnpm --filter @zachhub/backup restore --dry-run       # newest backup, report only
   pnpm --filter @zachhub/backup restore                 # newest backup
   pnpm --filter @zachhub/backup restore --file zachhub-export-2026-10-15.ndjson.gz
   ```

   Add `--user <uuid>` when the new project gave you a new user id. Rows that already exist are
   kept, so running it twice is safe. Accounts come back as "needs reauth": reconnect each one
   and mail resyncs. Reminders and dismissed nudges tied to a thread only come back while
   that thread is still in the database.

7. **Claude connector** (optional): lets Claude search, read, triage, draft and send your mail.
   In Supabase → Auth → URL Configuration, add the redirect URL
   `https://mail.zachconrad.dev/api/mcp/oauth/callback`. Vercel already has what it needs
   (`VITE_SUPABASE_PUBLISHABLE_KEY` and `OAUTH_STATE_SECRET`; set `MCP_TOKEN_SECRET` to sign
   connector tokens with their own key, and change it to sign every connector out). Then in
   claude.ai → Settings → Connectors → Add custom connector, use
   `https://mail.zachconrad.dev/api/mcp`, click Connect, sign in with Google and Allow. Claude
   Code: `claude mcp add --transport http zachmail https://mail.zachconrad.dev/api/mcp`.
