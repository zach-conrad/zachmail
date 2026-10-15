import type { MessageBody } from '@zachhub/core'
import type { Queryable } from '@zachhub/db/server'
import { sanitizeEmailHtml, textToHtml } from '@zachhub/mime'
import { getAccount, type ProviderFactory } from './accounts'
import { proxiedImageUrl } from './imageProxy'

/**
 * Returns the sanitized body for a message, fetching and caching it from the provider on first
 * use. Returns null when the message doesn't exist for this user.
 */
export async function getMessageBody(
  db: Queryable,
  providers: ProviderFactory,
  imageProxySecret: string,
  userId: string,
  messageId: string,
): Promise<{ body: MessageBody; fetched: boolean } | null> {
  const [cached] = await db.query<{ html: string | null; has_remote_images: boolean }>(
    `SELECT b.html, b.has_remote_images FROM message_bodies b WHERE b.message_id = $1 AND b.user_id = $2`,
    [messageId, userId],
  )
  if (cached?.html != null) {
    return {
      body: { messageId, html: cached.html, hasRemoteImages: cached.has_remote_images },
      fetched: false,
    }
  }

  const [msg] = await db.query<{ account_id: string; provider_message_id: string }>(
    `SELECT account_id, provider_message_id FROM messages WHERE id = $1 AND user_id = $2`,
    [messageId, userId],
  )
  if (!msg) return null
  const account = await getAccount(db, msg.account_id)
  if (!account) return null

  const raw = await providers.forAccount(account).fetchBody(msg.provider_message_id)
  const { html, hasRemoteImages } = raw.html
    ? sanitizeEmailHtml(raw.html, { proxyImage: (u) => proxiedImageUrl(u, imageProxySecret) })
    : { html: textToHtml(raw.text ?? ''), hasRemoteImages: false }

  await db.query(
    `INSERT INTO message_bodies (message_id, user_id, html, text, has_remote_images)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (message_id) DO UPDATE SET html = excluded.html, text = excluded.text,
       has_remote_images = excluded.has_remote_images, fetched_at = now()`,
    [messageId, userId, html, raw.text, hasRemoteImages],
  )
  await db.query(`UPDATE messages SET body_status = 'cached' WHERE id = $1`, [messageId])
  return { body: { messageId, html, hasRemoteImages }, fetched: true }
}
