/**
 * The Claude connector's tools. Reads go straight to the Postgres mirror (one query each, no
 * provider round trip except for message bodies not cached yet); writes reuse the same outbox,
 * draft and send paths as the apps, so every device sees Claude's changes on its next pull.
 */
import {
  InvalidOpsError,
  InvalidSendError,
  parseDraftRequest,
  parseOpsRequest,
  parseSendRequest,
  type Address,
} from '@zachhub/core'
import {
  SendRejectedError,
  acceptOps,
  acceptSend,
  cancelSend,
  nudge,
  saveDraft,
} from '@zachhub/db/server'
import { enqueueDraftSync, enqueueOutboxFlush, getMessageBody } from '@zachhub/engine'
import { htmlToText, parseAddressList, replySubject, textToHtml } from '@zachhub/mime'
import { randomUUID } from 'node:crypto'
import type { Deps } from '../deps'

export interface Tool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

/** A message for Claude: the call was fine but the request can't be done as asked. */
export class ToolError extends Error {
  override name = 'ToolError'
}

type Args = Record<string, unknown>
type Handler = (deps: Deps, userId: string, args: Args) => Promise<unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRIAGE = [
  'archive',
  'inbox',
  'trash',
  'spam',
  'read',
  'unread',
  'star',
  'unstar',
  'mute',
  'unmute',
] as const
const BODY_CHARS = 20_000
const BODIES_PER_THREAD = 10

const str = { type: 'string' } as const
const strList = (description: string) => ({ type: 'array', items: str, description })
const uuidList = (description: string) => ({
  type: 'array',
  items: { type: 'string', format: 'uuid' },
  minItems: 1,
  maxItems: 200,
  description,
})

const compose = {
  account_id: {
    type: 'string',
    description:
      'Account to send from (list_accounts). Optional for replies (uses the account that got the message) or with one account.',
  },
  to: strList('Recipients, "Name <email>" or bare email. Replies default to the sender.'),
  cc: strList('Cc recipients.'),
  bcc: strList('Bcc recipients.'),
  subject: { type: 'string', description: 'Subject. Replies default to "Re: <original>".' },
  body: { type: 'string', description: 'Plain-text body. Blank lines separate paragraphs.' },
  reply_to_message_id: {
    type: 'string',
    description: 'Message id (from get_thread) being answered; threads the reply correctly.',
  },
}

export const TOOLS: Tool[] = [
  {
    name: 'list_accounts',
    title: 'List accounts',
    description:
      "Lists Zach's connected mail accounts with their folders/labels (ids, kinds, unread counts). Call this first to get account and folder ids.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search_threads',
    title: 'Search mail',
    description:
      'Finds conversations across all accounts, newest first. Every word in `query` must appear in the subject, snippet or participants. Combine with filters; with no arguments it returns the latest inbox threads.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match (case-insensitive).' },
        from: { type: 'string', description: 'Sender name or address contains this.' },
        folder: {
          type: 'string',
          description:
            'Folder kind (inbox, sent, drafts, starred, important, archive, trash, spam), label name, or folder id. Defaults to inbox unless query or from is given.',
        },
        account_id: { type: 'string', description: 'Only this account.' },
        unread: { type: 'boolean', description: 'Only unread (true) or read (false).' },
        starred: { type: 'boolean' },
        after: { type: 'string', description: 'ISO date; last message on or after.' },
        before: { type: 'string', description: 'ISO date; last message before.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_thread',
    title: 'Read conversation',
    description:
      'Returns a conversation with its messages (headers, plain-text bodies, attachment names), oldest first. Bodies of older messages beyond the latest 10 are snippets only.',
    inputSchema: {
      type: 'object',
      properties: { thread_id: { type: 'string', description: 'Thread id from search_threads.' } },
      required: ['thread_id'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'triage_threads',
    title: 'Triage conversations',
    description:
      'Applies one action to conversations, exactly like the app does: archive, inbox (move back), trash, spam, read, unread, star, unstar, mute (archive now and future replies), unmute.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_ids: uuidList('Thread ids.'),
        action: { type: 'string', enum: TRIAGE },
      },
      required: ['thread_ids', 'action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'label_threads',
    title: 'Label conversations',
    description:
      'Adds and/or removes labels (folders) on conversations. Labels are names or folder ids from list_accounts. To move a thread, add the label and then archive it.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_ids: uuidList('Thread ids.'),
        add: strList('Labels to add.'),
        remove: strList('Labels to remove.'),
      },
      required: ['thread_ids'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'save_draft',
    title: 'Save draft',
    description:
      "Saves a draft in Zach's mailbox (shows up in ZachMail and the provider's Drafts) without sending. Prefer this over send_email unless Zach clearly asked to send. Pass draft_id to update an earlier draft.",
    inputSchema: {
      type: 'object',
      properties: {
        ...compose,
        draft_id: { type: 'string', description: 'Draft id returned earlier, to replace it.' },
      },
      required: ['body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'send_email',
    title: 'Send email',
    description:
      'Sends an email for real. Only use when Zach explicitly asked to send. It leaves after a 10 second undo window (cancel_send stops it) or at send_at.',
    inputSchema: {
      type: 'object',
      properties: {
        ...compose,
        send_at: { type: 'string', description: 'ISO time to send later.' },
      },
      required: ['body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'cancel_send',
    title: 'Cancel send',
    description: 'Stops a message from send_email that has not gone out yet.',
    inputSchema: {
      type: 'object',
      properties: { send_id: { type: 'string', description: 'The id send_email returned.' } },
      required: ['send_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
]

const HANDLERS: Record<string, Handler> = {
  list_accounts,
  search_threads,
  get_thread,
  triage_threads,
  label_threads,
  save_draft,
  send_email,
  cancel_send,
}

export async function callTool(deps: Deps, userId: string, name: string, args: Args) {
  const handler = HANDLERS[name]
  if (!handler) throw new ToolError(`Unknown tool: ${name}`)
  try {
    return await handler(deps, userId, args ?? {})
  } catch (err) {
    if (
      err instanceof InvalidOpsError ||
      err instanceof InvalidSendError ||
      err instanceof SendRejectedError
    )
      throw new ToolError(err.message)
    throw err
  }
}

// ---- reads ----

async function list_accounts(deps: Deps, userId: string) {
  const db = deps.db()
  const [accounts, folders] = await Promise.all([
    db.query<{
      id: string
      provider: string
      email: string
      name: string | null
      status: string
      last_synced_at: Date | null
    }>(
      `SELECT id, provider, email, coalesce(short_name, display_name) AS name, status, last_synced_at
       FROM accounts WHERE user_id = $1 ORDER BY color, created_at`,
      [userId],
    ),
    db.query<{ id: string; account_id: string; name: string; kind: string; unread: number }>(
      `SELECT id, account_id, name, kind, unread_count AS unread FROM folders
       WHERE user_id = $1 ORDER BY kind <> 'custom', name`,
      [userId],
    ),
  ])
  return {
    accounts: accounts.map((a) => ({
      ...a,
      folders: folders
        .filter((f) => f.account_id === a.id)
        .map(({ id, name, kind, unread }) => ({ id, name, kind, unread })),
    })),
  }
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

async function search_threads(deps: Deps, userId: string, a: Args) {
  const params: unknown[] = [userId]
  const p = (v: unknown) => `$${params.push(v)}`
  const where = ['t.user_id = $1']

  const query = optString(a.query, 'query')
  for (const term of (query ?? '').split(/\s+/).filter(Boolean).slice(0, 10)) {
    const t = p(like(term))
    where.push(`(t.subject ILIKE ${t} OR t.snippet ILIKE ${t} OR t.participants::text ILIKE ${t})`)
  }
  const from = optString(a.from, 'from')
  if (from)
    where.push(
      `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m."from"::text ILIKE ${p(like(from))})`,
    )
  const folder = optString(a.folder, 'folder') ?? (query || from ? undefined : 'inbox')
  if (folder) {
    const f = p(folder)
    where.push(
      `EXISTS (SELECT 1 FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
        WHERE tf.thread_id = t.id AND (f.kind::text = ${f} OR f.id::text = ${f} OR lower(f.name) = lower(${f})))`,
    )
  }
  const accountId = optString(a.account_id, 'account_id')
  if (accountId) where.push(`t.account_id::text = ${p(accountId)}`)
  if (typeof a.unread === 'boolean') where.push(`t.unread = ${p(a.unread)}`)
  if (typeof a.starred === 'boolean') where.push(`t.starred = ${p(a.starred)}`)
  const after = optDate(a.after, 'after')
  if (after) where.push(`t.last_message_at >= ${p(after)}`)
  const before = optDate(a.before, 'before')
  if (before) where.push(`t.last_message_at < ${p(before)}`)
  const limit = clampInt(a.limit, 20, 1, 50)
  const offset = clampInt(a.offset, 0, 0, 10_000)

  const rows = await deps.db().query<Record<string, unknown>>(
    `SELECT t.id, acc.email AS account, t.subject, t.snippet, t.participants,
       t.last_message_at, t.message_count, t.unread, t.starred, t.muted,
       t.has_attachments,
       ARRAY(SELECT f.name FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
             WHERE tf.thread_id = t.id ORDER BY f.name) AS labels
     FROM threads t JOIN accounts acc ON acc.id = t.account_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.last_message_at DESC
     LIMIT ${limit + 1} OFFSET ${offset}`,
    params,
  )
  return {
    threads: rows.slice(0, limit),
    ...(rows.length > limit ? { next_offset: offset + limit } : {}),
  }
}

async function get_thread(deps: Deps, userId: string, a: Args) {
  const threadId = uuid(a.thread_id, 'thread_id')
  const db = deps.db()
  const [thread] = await db.query<Record<string, unknown>>(
    `SELECT t.id, t.account_id, acc.email AS account, t.subject, t.participants,
       t.last_message_at, t.unread, t.starred, t.muted,
       ARRAY(SELECT f.name FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
             WHERE tf.thread_id = t.id ORDER BY f.name) AS labels
     FROM threads t JOIN accounts acc ON acc.id = t.account_id
     WHERE t.id = $1 AND t.user_id = $2`,
    [threadId, userId],
  )
  if (!thread) throw new ToolError('No such thread')
  const messages = await db.query<{
    id: string
    from: Address | null
    to: Address[]
    cc: Address[]
    date: Date
    subject: string
    snippet: string
    unread: boolean
    html: string | null
    text: string | null
    attachments: { filename: string; mime: string; size: number }[]
  }>(
    `SELECT m.id, m."from", m."to", m.cc, m.date, m.subject, m.snippet, m.unread, b.html, b.text,
       coalesce((SELECT json_agg(json_build_object('filename', x.filename, 'mime', x.mime, 'size', x.size))
         FROM attachments x WHERE x.message_id = m.id AND NOT x.inline), '[]'::json) AS attachments
     FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id
     WHERE m.thread_id = $1 AND m.user_id = $2 ORDER BY m.date`,
    [threadId, userId],
  )
  const withBody = new Set(messages.slice(-BODIES_PER_THREAD).map((m) => m.id))
  const missing = messages.filter((m) => withBody.has(m.id) && m.html == null && m.text == null)
  // Uncached bodies come from the provider, in parallel; one failure doesn't sink the thread.
  const fetched = new Map<string, string>()
  if (missing.length) {
    const secret = deps.engineConfig().imageProxySecret
    await Promise.all(
      missing.map(async (m) => {
        try {
          const r = await getMessageBody(db, deps.providers(), secret, userId, m.id)
          if (r) fetched.set(m.id, r.body.html)
        } catch (err) {
          console.error('mcp body fetch', m.id, err)
        }
      }),
    )
  }
  return {
    ...thread,
    messages: messages.map(({ html, text, snippet, ...m }) => {
      const body = withBody.has(m.id)
        ? text?.trim() || htmlToText(html ?? fetched.get(m.id) ?? '') || snippet
        : undefined
      return {
        ...m,
        ...(body !== undefined
          ? { body: body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}\n[…truncated]` : body }
          : { snippet }),
      }
    }),
  }
}

// ---- writes ----

async function applyOp(deps: Deps, userId: string, op: unknown) {
  const id = randomUUID()
  const { ops } = parseOpsRequest({ ops: [{ id, at: Date.now(), op }] })
  const db = deps.db()
  const { accepted, rejected, accounts } = await acceptOps(db, userId, ops)
  for (const accountId of accounts) await enqueueOutboxFlush(db, userId, accountId)
  if (accepted.length) await nudge(db, userId)
  if (rejected.length) throw new ToolError(rejected[0]!.error)
  return { ok: true, op_id: id }
}

async function triage_threads(deps: Deps, userId: string, a: Args) {
  if (!TRIAGE.includes(a.action as never))
    throw new ToolError(`action must be one of ${TRIAGE.join(', ')}`)
  return applyOp(deps, userId, { kind: a.action, threadIds: a.thread_ids })
}

async function label_threads(deps: Deps, userId: string, a: Args) {
  const add = strings(a.add, 'add')
  const remove = strings(a.remove, 'remove')
  if (!add.length && !remove.length) throw new ToolError('Give labels to add or remove')
  const wanted = [...add, ...remove]
  const folders = await deps.db().query<{ id: string; name: string }>(
    `SELECT id, name FROM folders WHERE user_id = $1
       AND (id::text = ANY($2::text[]) OR lower(name) = ANY($3::text[]))`,
    [userId, wanted, wanted.map((w) => w.toLowerCase())],
  )
  // A name can exist in several accounts; the server keeps only each thread's own account's.
  const resolve = (list: string[]) =>
    list.flatMap((w) => {
      const ids = folders
        .filter((f) => f.id === w || f.name.toLowerCase() === w.toLowerCase())
        .map((f) => f.id)
      if (!ids.length) throw new ToolError(`No label named "${w}" (see list_accounts)`)
      return ids
    })
  return applyOp(deps, userId, {
    kind: 'label',
    threadIds: a.thread_ids,
    add: resolve(add),
    remove: resolve(remove),
  })
}

/** Fills in reply defaults and the account, then returns the shared outgoing fields. */
async function outgoing(deps: Deps, userId: string, a: Args) {
  const db = deps.db()
  const replyTo = a.reply_to_message_id ? uuid(a.reply_to_message_id, 'reply_to_message_id') : null
  let accountId = a.account_id ? uuid(a.account_id, 'account_id') : null
  let to = addresses(a.to, 'to')
  let subject = optString(a.subject, 'subject')

  if (replyTo) {
    const [parent] = await db.query<{
      account_id: string
      from: Address | null
      reply_to: Address[]
      subject: string
    }>(
      `SELECT account_id, "from", reply_to, subject FROM messages WHERE id = $1 AND user_id = $2`,
      [replyTo, userId],
    )
    if (!parent) throw new ToolError('The message being answered does not exist')
    accountId ??= parent.account_id
    if (!to.length) to = parent.reply_to.length ? parent.reply_to : parent.from ? [parent.from] : []
    subject ??= replySubject(parent.subject)
  }
  if (!accountId) {
    const accounts = await db.query<{ id: string; email: string }>(
      `SELECT id, email FROM accounts WHERE user_id = $1 AND status <> 'disabled' ORDER BY color`,
      [userId],
    )
    if (accounts.length !== 1)
      throw new ToolError(
        accounts.length
          ? `Pick account_id: ${accounts.map((x) => `${x.email} = ${x.id}`).join(', ')}`
          : 'No mail accounts are connected',
      )
    accountId = accounts[0]!.id
  }
  const body = optString(a.body, 'body') ?? ''
  return {
    accountId,
    to,
    cc: addresses(a.cc, 'cc'),
    bcc: addresses(a.bcc, 'bcc'),
    subject: subject ?? '',
    html: textToHtml(body),
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
  }
}

async function save_draft(deps: Deps, userId: string, a: Args) {
  const id = a.draft_id ? uuid(a.draft_id, 'draft_id') : randomUUID()
  const req = parseDraftRequest(await outgoing(deps, userId, a))
  const db = deps.db()
  const version = await saveDraft(db, userId, id, req)
  if (version === null) throw new ToolError('That draft or account is not yours')
  await enqueueDraftSync(db, userId, id, true)
  return { draft_id: id, account_id: req.accountId, to: req.to, subject: req.subject }
}

async function send_email(deps: Deps, userId: string, a: Args) {
  const sendAt = optDate(a.send_at, 'send_at')
  const req = parseSendRequest({
    id: randomUUID(),
    ...(await outgoing(deps, userId, a)),
    ...(sendAt ? { sendAt: sendAt.getTime() } : {}),
  })
  const db = deps.db()
  const at = await acceptSend(db, userId, req)
  await enqueueOutboxFlush(db, userId, req.accountId, new Date(at))
  return {
    send_id: req.id,
    sends_at: new Date(at).toISOString(),
    to: req.to,
    subject: req.subject,
  }
}

async function cancel_send(deps: Deps, userId: string, a: Args) {
  const undone = await cancelSend(deps.db(), userId, uuid(a.send_id, 'send_id'))
  if (!undone) throw new ToolError('Too late: it has already been sent (or never existed)')
  return { cancelled: true }
}

// ---- argument helpers ----

function optString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new ToolError(`${field} must be a string`)
  return v
}

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ToolError(`${field} must be an id`)
  return v
}

function strings(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
    throw new ToolError(`${field} must be a list of strings`)
  return v as string[]
}

function addresses(v: unknown, field: string): Address[] {
  return strings(typeof v === 'string' ? [v] : v, field).flatMap((s) => {
    const parsed = parseAddressList(s)
    if (!parsed.length) throw new ToolError(`${field}: "${s}" is not an email address`)
    return parsed.map((p) => (p.name ? { email: p.email, name: p.name } : { email: p.email }))
  })
}

function optDate(v: unknown, field: string): Date | undefined {
  const s = optString(v, field)
  if (!s) return undefined
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) throw new ToolError(`${field} must be an ISO date`)
  return d
}

function clampInt(v: unknown, dflt: number, min: number, max: number) {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt
  return Math.min(Math.max(n, min), max)
}
