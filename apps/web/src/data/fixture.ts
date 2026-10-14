import {
  emptyDeletes,
  emptyRows,
  type AccountRow,
  type Address,
  type FolderRow,
  type MessageBody,
  type MessageRow,
  type SyncTransport,
  type ThreadRow,
} from '@zachmail/core'

// Deterministic demo mailbox: the same seed always yields the same 20k threads, so perf runs
// compare like with like. Loaded only in demo mode (dynamic import in the worker).

const DAY = 86_400_000
const CHUNK = 1000

const ACCOUNTS: AccountRow[] = [
  ['acc-personal', 'zach@gmail.example', 'Personal', 4],
  ['acc-work', 'zach@work.example', 'Work', 3],
  ['acc-dev', 'zach@zachconrad.dev', 'zachconrad.dev', 5],
].map(([id, email, short, color]) => ({
  id: id as string,
  provider: 'gmail',
  email: email as string,
  displayName: 'Zach Conrad',
  shortName: short as string,
  color: color as number,
  status: 'ok',
  lastSyncedAt: null,
  lastError: null,
}))

const LABELS = ['Clients', 'Receipts', 'Travel', 'Waiting']
const FIRST = ['Ana', 'Jordan', 'Sam', 'Priya', 'Lena', 'Marcus', 'Chen', 'Olivia', 'Noah', 'Ivy']
const LAST = ['Ruiz', 'Lee', 'Patel', 'Kim', 'Okafor', 'Novak', 'Haas', 'Moreau', 'Silva', 'Berg']
const NEWS = ['Stratechery', 'The Verge', 'Morning Brew', 'Hacker Newsletter', 'Figma', 'Linear']
const BOTS = [
  ['GitHub', 'notifications@github.com'],
  ['Stripe', 'receipts@stripe.com'],
  ['Vercel', 'no-reply@vercel.com'],
  ['Google', 'no-reply@accounts.google.com'],
  ['Calendar', 'calendar-notification@google.com'],
] as const
const TOPICS = [
  'Q4 plan',
  'dinner Friday?',
  'Design review notes',
  'Contract draft',
  'Trip photos',
  'Quick question',
  'Offsite agenda',
  'Invoice #',
  'Follow up',
  'Launch checklist',
  'Weekend plans',
  'Intro: ',
]
const WORDS =
  'the quick brown fox jumps over lazy dog plan launch review ship build fast mail inbox draft notes team call friday next week thanks great idea sounds good attached latest numbers update'.split(
    ' ',
  )

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: () => number, a: readonly T[]) => a[Math.floor(r() * a.length)]!
const sentence = (r: () => number, n: number) => {
  const w = Array.from({ length: n }, () => pick(r, WORDS))
  w[0] = w[0]!.charAt(0).toUpperCase() + w[0]!.slice(1)
  return w.join(' ') + '.'
}

type Kind = 'human-important' | 'human-other' | 'newsletter' | 'notification'

function kindFor(r: () => number): Kind {
  const x = r()
  return x < 0.4
    ? 'human-important'
    : x < 0.55
      ? 'human-other'
      : x < 0.8
        ? 'newsletter'
        : 'notification'
}

/** Every thread and message for an N-thread mailbox, newest first, in CHUNK-sized slices. */
export function* fixtureChunks(n: number, now = Date.now()) {
  const folders: FolderRow[] = ACCOUNTS.flatMap((a) => [
    ...(['inbox', 'important', 'sent', 'archive', 'trash', 'spam', 'starred'] as const).map(
      (kind) => ({
        id: `${a.id}:${kind}`,
        accountId: a.id,
        providerId: kind.toUpperCase(),
        name: kind,
        kind,
        unreadCount: 0,
        totalCount: 0,
      }),
    ),
    ...LABELS.map((name) => ({
      id: `${a.id}:label:${name}`,
      accountId: a.id,
      providerId: `Label_${name}`,
      name,
      kind: 'custom' as const,
      unreadCount: 0,
      totalCount: 0,
    })),
  ])
  yield { ...emptyRows(), accounts: ACCOUNTS, folders }

  const r = rng(42)
  const span = 90 * DAY
  for (let start = 0; start < n; start += CHUNK) {
    const threads: ThreadRow[] = []
    const messages: MessageRow[] = []
    for (let i = start; i < Math.min(n, start + CHUNK); i++) {
      const account = ACCOUNTS[i % 7 === 0 ? 2 : i % 3 === 0 ? 1 : 0]!
      const me: Address = { name: 'Zach Conrad', email: account.email }
      const kind = kindFor(r)
      let from: Address
      if (kind === 'newsletter') {
        const name = pick(r, NEWS)
        from = { name, email: `hello@${name.toLowerCase().replace(/\W/g, '')}.example` }
      } else if (kind === 'notification') {
        const [name, email] = pick(r, BOTS)
        from = { name, email }
      } else {
        const f = pick(r, FIRST)
        const l = pick(r, LAST)
        from = { name: `${f} ${l}`, email: `${f}.${l}@example.com`.toLowerCase() }
      }
      const id = `t${i}`
      const last = now - Math.floor((i / n) * span) - Math.floor(r() * 60_000)
      const count = kind.startsWith('human') ? 1 + Math.floor(r() * 4) : 1
      const subject =
        kind === 'notification'
          ? `[zachmail] ${sentence(r, 4).slice(0, -1)}`
          : pick(r, TOPICS) + (r() < 0.5 ? '' : ` ${Math.floor(r() * 900 + 100)}`)
      const unread = i < 40 ? r() < 0.6 : r() < 0.08
      const folderIds = [`${account.id}:inbox`]
      if (kind === 'human-important') folderIds.push(`${account.id}:important`)
      for (let k = 0; k < count; k++) {
        const mine = k % 2 === 1
        const date = last - (count - 1 - k) * Math.floor(r() * 6 * 3_600_000 + 600_000)
        messages.push({
          id: `${id}m${k}`,
          threadId: id,
          accountId: account.id,
          from: mine ? me : from,
          to: [mine ? from : me],
          cc: [],
          replyTo: [],
          subject: k ? `Re: ${subject}` : subject,
          snippet: sentence(r, 14),
          date,
          unread: unread && k === count - 1,
          starred: false,
          hasAttachments: false,
          listUnsubscribe: kind === 'newsletter' ? `<mailto:unsub@${from.email}>` : null,
          rfc822MessageId: null,
          bodyStatus: 'cached',
        })
      }
      threads.push({
        id,
        accountId: account.id,
        subject,
        snippet: messages[messages.length - 1]!.snippet,
        participants: count > 1 ? [from, me] : [from],
        lastMessageAt: last,
        messageCount: count,
        unread,
        starred: r() < 0.03,
        hasAttachments: r() < 0.1,
        folderIds,
      })
    }
    yield { threads, messages }
  }
}

/** A transport that serves the fixture as if it came from /api/bootstrap and /api/sync. */
export function fixtureTransport(n: number): SyncTransport {
  return {
    async *bootstrap() {
      for (const rows of fixtureChunks(n)) yield { rows }
      yield { seq: 1 }
    },
    async delta(since) {
      return { seq: since, more: false, upserts: emptyRows(), deletes: emptyDeletes(), ops: [] }
    },
  }
}

const PIXEL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="160"><rect width="560" height="160" fill="#5B4BDB"/></svg>',
  )

/** Pre-sanitized HTML in the shape the server sends (remote images parked in data-zm-src). */
export function fixtureBody(messageId: string): MessageBody {
  let h = 0
  for (const c of messageId) h = (h * 31 + c.charCodeAt(0)) | 0
  const r = rng(h)
  const paras = Array.from({ length: 2 + Math.floor(r() * 5) }, () => `<p>${sentence(r, 30)}</p>`)
  const img = r() < 0.3
  if (img) paras.splice(1, 0, `<p><img data-zm-src="${PIXEL}" alt="Banner" width="560"></p>`)
  return {
    messageId,
    html: `<div>${paras.join('')}<p>— ${pick(r, FIRST)}</p></div>`,
    hasRemoteImages: img,
  }
}
