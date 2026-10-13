import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Queryable } from './sql'

/**
 * Provider secrets (refresh tokens, app passwords) are AES-256-GCM encrypted with a data key
 * kept in Supabase Vault (secret name `zachmail_token_key`, 32 random bytes, base64). Only
 * service-role server code can read the key or the ciphertext.
 */
export async function loadTokenKey(db: Queryable, envFallback?: string): Promise<Buffer> {
  if (envFallback) return parseKey(envFallback)
  const rows = await db.query<{ secret: string }>(
    `SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name = 'zachmail_token_key' LIMIT 1`,
  )
  if (!rows[0]) throw new Error('Vault secret zachmail_token_key is missing')
  return parseKey(rows[0].secret)
}

function parseKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) throw new Error('Token key must be 32 bytes (base64)')
  return key
}

export function encryptSecret(plaintext: string, key: Buffer): { ciphertext: string; iv: string } {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return { ciphertext: body.toString('base64'), iv: iv.toString('base64') }
}

export function decryptSecret(enc: { ciphertext: string; iv: string }, key: Buffer): string {
  const body = Buffer.from(enc.ciphertext, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'))
  decipher.setAuthTag(body.subarray(body.length - 16))
  return Buffer.concat([
    decipher.update(body.subarray(0, body.length - 16)),
    decipher.final(),
  ]).toString('utf8')
}

export interface ProviderSecret {
  refreshToken?: string
  password?: string
}

export async function saveCredentials(
  db: Queryable,
  key: Buffer,
  args: { accountId: string; userId: string; secret: ProviderSecret; scopes?: string[] },
) {
  const enc = encryptSecret(JSON.stringify(args.secret), key)
  await db.query(
    `INSERT INTO account_credentials (account_id, user_id, ciphertext, iv, scopes)
     VALUES ($1, $2, $3, $4, $5::text[])
     ON CONFLICT (account_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv,
       scopes = excluded.scopes, updated_at = now()`,
    [args.accountId, args.userId, enc.ciphertext, enc.iv, args.scopes ?? []],
  )
}

export async function loadCredentials(
  db: Queryable,
  key: Buffer,
  accountId: string,
): Promise<ProviderSecret> {
  const [row] = await db.query<{ ciphertext: string; iv: string }>(
    `SELECT ciphertext, iv FROM account_credentials WHERE account_id = $1`,
    [accountId],
  )
  if (!row) throw new Error(`No credentials for account ${accountId}`)
  return JSON.parse(decryptSecret(row, key)) as ProviderSecret
}
