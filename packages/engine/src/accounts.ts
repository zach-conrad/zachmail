import {
  loadCredentials,
  loadTokenKey,
  saveCredentials,
  type Db,
  type Queryable,
} from '@zachmail/db/server'
import { GmailProvider, refreshAccessToken, type FetchLike } from '@zachmail/providers/gmail'
import {
  GraphProvider,
  MicrosoftTokenError,
  refreshMicrosoftToken,
  type GraphSyncState,
} from '@zachmail/providers/graph'
import { ProviderAuthError, type MailProvider, type SyncState } from '@zachmail/providers'
import { createHmac } from 'node:crypto'
import type { EngineConfig } from './config'

export interface AccountRecord {
  id: string
  userId: string
  provider: 'gmail' | 'graph' | 'imap'
  email: string
  status: string
  syncState: SyncState
}

export async function getAccount(db: Queryable, accountId: string): Promise<AccountRecord | null> {
  const [row] = await db.query<AccountRecord>(
    `SELECT id, user_id AS "userId", provider, email, status, sync_state AS "syncState" FROM accounts WHERE id = $1`,
    [accountId],
  )
  return row ?? null
}

/** The secret Graph echoes in every notification for an account, proving it came from us. */
export const graphClientState = (webhookSecret: string, accountId: string) =>
  createHmac('sha256', webhookSecret).update(`graph:${accountId}`).digest('hex')

/** Whether the account can be pushed to: Gmail needs Pub/Sub, Graph a webhook secret. */
export function canWatch(config: EngineConfig, account: AccountRecord) {
  if (account.provider === 'gmail') return !!config.google.pubsubTopic
  if (account.provider === 'graph') return !!config.microsoft?.webhookSecret
  return false
}

/**
 * Builds provider clients for accounts, caching access tokens in memory until shortly before
 * they expire. One instance per process (worker or warm API function).
 */
export class ProviderFactory {
  private key: Promise<Buffer> | null = null
  private tokens = new Map<string, { token: string; expiresAt: number }>()
  /** Refreshes in flight, so parallel requests share one (Microsoft rotates the token). */
  private refreshing = new Map<string, Promise<string>>()

  constructor(
    private db: Db,
    private config: EngineConfig,
    private fetchImpl: FetchLike = fetch,
    private opts: { maxRetries?: number } = {},
  ) {}

  private tokenKey() {
    return (this.key ??= loadTokenKey(this.db, this.config.tokenKey))
  }

  async encryptionKey() {
    return this.tokenKey()
  }

  forAccount(account: AccountRecord): MailProvider & { gmail?: GmailProvider } {
    const tokens = { getAccessToken: (force?: boolean) => this.accessToken(account, force) }
    if (account.provider === 'graph') {
      const ms = this.config.microsoft
      if (!ms) throw new Error('Outlook accounts need MICROSOFT_CLIENT_ID and _SECRET')
      return new GraphProvider({
        tokens,
        fetch: this.fetchImpl,
        maxRetries: this.opts.maxRetries,
        wellKnown: (account.syncState as GraphSyncState).wellKnown,
        notifications: ms.webhookSecret
          ? {
              url: `${this.config.appOrigin}/webhooks/graph`,
              clientState: graphClientState(ms.webhookSecret, account.id),
            }
          : undefined,
      })
    }
    if (account.provider !== 'gmail')
      throw new Error(`Provider ${account.provider} is not supported yet`)
    const gmail = new GmailProvider({
      fetch: this.fetchImpl,
      pubsubTopic: this.config.google.pubsubTopic,
      maxRetries: this.opts.maxRetries,
      tokens,
    })
    return Object.assign(gmail, { gmail })
  }

  private async accessToken(account: AccountRecord, force = false): Promise<string> {
    const cached = this.tokens.get(account.id)
    if (!force && cached && cached.expiresAt - 60_000 > Date.now()) return cached.token
    const inFlight = this.refreshing.get(account.id)
    if (inFlight) return inFlight
    const p = this.refresh(account).finally(() => this.refreshing.delete(account.id))
    this.refreshing.set(account.id, p)
    return p
  }

  private async refresh(account: AccountRecord): Promise<string> {
    const secret = await loadCredentials(this.db, await this.tokenKey(), account.id)
    if (!secret.refreshToken) throw new ProviderAuthError('No refresh token stored')
    const t =
      account.provider === 'graph'
        ? await this.refreshGraph(account, secret.refreshToken)
        : await this.refreshGoogle(secret.refreshToken)
    this.tokens.set(account.id, { token: t.accessToken, expiresAt: t.expiresAt.getTime() })
    return t.accessToken
  }

  private async refreshGoogle(refreshToken: string) {
    try {
      return await refreshAccessToken(this.config.google, refreshToken, this.fetchImpl)
    } catch (err) {
      // invalid_grant = revoked or expired refresh token: Zach must reconnect the account.
      if ((err as { code?: string }).code === 'invalid_grant')
        throw new ProviderAuthError('Refresh token revoked')
      throw err
    }
  }

  private async refreshGraph(account: AccountRecord, refreshToken: string) {
    const ms = this.config.microsoft
    if (!ms) throw new Error('Outlook accounts need MICROSOFT_CLIENT_ID and _SECRET')
    try {
      const t = await refreshMicrosoftToken(ms, refreshToken, this.fetchImpl)
      // Microsoft rotates refresh tokens; keep the newest so the grant never ages out.
      if (t.refreshToken && t.refreshToken !== refreshToken)
        await saveCredentials(this.db, await this.tokenKey(), {
          accountId: account.id,
          userId: account.userId,
          secret: { refreshToken: t.refreshToken },
          scopes: t.scope.split(' '),
        })
      return t
    } catch (err) {
      if (err instanceof MicrosoftTokenError && err.needsReauth)
        throw new ProviderAuthError(err.message)
      throw err
    }
  }
}
