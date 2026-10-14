import { loadCredentials, loadTokenKey, type Db, type Queryable } from '@zachmail/db/server'
import { GmailProvider, refreshAccessToken, type FetchLike } from '@zachmail/providers/gmail'
import { ProviderAuthError, type MailProvider, type SyncState } from '@zachmail/providers'
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

/**
 * Builds provider clients for accounts, caching access tokens in memory until shortly before
 * they expire. One instance per process (worker or warm API function).
 */
export class ProviderFactory {
  private key: Promise<Buffer> | null = null
  private tokens = new Map<string, { token: string; expiresAt: number }>()

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
    if (account.provider !== 'gmail')
      throw new Error(`Provider ${account.provider} is not supported yet`)
    const gmail = new GmailProvider({
      fetch: this.fetchImpl,
      pubsubTopic: this.config.google.pubsubTopic,
      maxRetries: this.opts.maxRetries,
      tokens: { getAccessToken: (force) => this.accessToken(account, force) },
    })
    return Object.assign(gmail, { gmail })
  }

  private async accessToken(account: AccountRecord, force = false): Promise<string> {
    const cached = this.tokens.get(account.id)
    if (!force && cached && cached.expiresAt - 60_000 > Date.now()) return cached.token
    const secret = await loadCredentials(this.db, await this.tokenKey(), account.id)
    if (!secret.refreshToken) throw new ProviderAuthError('No refresh token stored')
    try {
      const t = await refreshAccessToken(this.config.google, secret.refreshToken, this.fetchImpl)
      this.tokens.set(account.id, { token: t.accessToken, expiresAt: t.expiresAt.getTime() })
      return t.accessToken
    } catch (err) {
      // invalid_grant = revoked or expired refresh token: Zach must reconnect the account.
      if ((err as { code?: string }).code === 'invalid_grant')
        throw new ProviderAuthError('Refresh token revoked')
      throw err
    }
  }
}
