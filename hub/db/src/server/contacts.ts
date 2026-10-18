import type { ContactRow } from '@zachhub/core'
import type { Queryable } from './sql'

/**
 * Contacts derived from the mirror: recipients of sent mail count 3 each, senders 1, with a
 * recency bonus. Zach's own addresses are left out.
 */
export async function readContacts(db: Queryable, userId: string, limit = 2000) {
  return db.query<ContactRow>(
    `WITH sent_folders AS (
       SELECT account_id, provider_id FROM folders WHERE user_id = $1 AND kind = 'sent'
     ), people AS (
       SELECT a->>'email' AS email, a->>'name' AS name, m.date, 3 AS weight
       FROM messages m
       JOIN sent_folders s ON s.account_id = m.account_id AND s.provider_id = ANY(m.provider_labels)
       CROSS JOIN LATERAL jsonb_array_elements(m."to" || m.cc || m.bcc) AS a
       WHERE m.user_id = $1
       UNION ALL
       SELECT m."from"->>'email', m."from"->>'name', m.date, 1
       FROM messages m WHERE m.user_id = $1 AND m."from" IS NOT NULL
     )
     SELECT lower(email) AS email,
       (array_agg(name ORDER BY date DESC) FILTER (WHERE name IS NOT NULL AND name <> ''))[1] AS name,
       (sum(weight) + 10 * exp(-extract(epoch FROM now() - max(date)) / 2592000))::float8 AS score,
       (extract(epoch FROM max(date)) * 1000)::float8 AS "lastAt"
     FROM people
     WHERE email IS NOT NULL AND email <> ''
       AND lower(email) NOT IN (SELECT lower(email) FROM accounts WHERE user_id = $1)
     GROUP BY lower(email)
     ORDER BY score DESC
     LIMIT $2`,
    [userId, limit],
  )
}
