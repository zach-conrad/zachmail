/**
 * Demo mailbox shaped exactly like the sync protocol (packages/core/src/sync/protocol.ts), used until
 * the iOS replica pulls from /api/bootstrap. Times are relative to `now` so the demo always looks fresh.
 */
import type {
  AccountRow,
  Address,
  FolderKind,
  FolderRow,
  MessageBody,
  MessageRow,
  Rows,
  ThreadRow,
} from '@zachmail/core'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const accounts: AccountRow[] = [
  {
    id: 'acc-personal',
    provider: 'gmail',
    email: 'zach@gmail.com',
    displayName: 'Zach Conrad',
    shortName: 'Personal',
    color: 4,
    status: 'ok',
    lastSyncedAt: null,
    lastError: null,
  },
  {
    id: 'acc-work',
    provider: 'gmail',
    email: 'zach@acme.co',
    displayName: 'Zach Conrad',
    shortName: 'Work',
    color: 3,
    status: 'ok',
    lastSyncedAt: null,
    lastError: null,
  },
  {
    id: 'acc-dev',
    provider: 'gmail',
    email: 'hi@zachconrad.dev',
    displayName: 'Zach Conrad',
    shortName: 'Dev',
    color: 5,
    status: 'ok',
    lastSyncedAt: null,
    lastError: null,
  },
]

const kinds: FolderKind[] = ['inbox', 'sent', 'drafts', 'trash', 'spam', 'starred', 'important']
const folders: FolderRow[] = accounts.flatMap((a) =>
  kinds.map((kind) => ({
    id: `${a.id}:${kind}`,
    accountId: a.id,
    providerId: kind.toUpperCase(),
    name: kind[0]!.toUpperCase() + kind.slice(1),
    kind,
    unreadCount: 0,
    totalCount: 0,
  })),
)

interface Seed {
  account: 'personal' | 'work' | 'dev'
  subject: string
  /** Oldest first. `me` marks a message Zach sent. */
  messages: { from: Address | 'me'; ago: number; text: string }[]
  unread?: boolean
  starred?: boolean
  attachment?: boolean
  unsubscribe?: boolean
  /** Not in the inbox (already done). */
  done?: boolean
}

const p = (name: string, email: string): Address => ({ name, email })
const ana = p('Ana Ruiz', 'ana@acme.co')
const jordan = p('Jordan Lee', 'jordan.lee@gmail.com')
const priya = p('Priya Shah', 'priya@acme.co')
const mom = p('Mom', 'linda.conrad@icloud.com')
const sam = p('Sam Okafor', 'sam@okafor.design')

const seeds: Seed[] = [
  {
    account: 'work',
    subject: 'Q4 plan — draft',
    unread: true,
    attachment: true,
    messages: [
      { from: 'me', ago: 2 * DAY, text: 'Ana, can you pull together the Q4 plan before Thursday?' },
      {
        from: ana,
        ago: 1 * DAY,
        text: 'On it. Do you want headcount in the same doc or separate?',
      },
      { from: 'me', ago: 20 * HOUR, text: 'Same doc is fine.' },
      {
        from: ana,
        ago: 38 * MIN,
        text: 'Hey Zach, attached is the first pass of the Q4 plan. The hiring section still needs numbers from finance, but the roadmap and milestones are ready for a look.',
      },
    ],
  },
  {
    account: 'personal',
    subject: 'Re: dinner Friday',
    unread: true,
    messages: [
      { from: 'me', ago: 5 * HOUR, text: 'Still on for Friday? I can book somewhere near you.' },
      { from: jordan, ago: 1 * HOUR, text: 'Yes! 7:30 works. Pick anywhere with a patio.' },
    ],
  },
  {
    account: 'personal',
    subject: 'Your receipt from Linear',
    unread: true,
    unsubscribe: false,
    messages: [
      {
        from: p('Stripe', 'receipts+acct@stripe.com'),
        ago: 9 * MIN,
        text: 'Receipt #2231-0045. Amount paid $16.00. Linear Standard, monthly.',
      },
    ],
  },
  {
    account: 'dev',
    subject: '[zachmail] Phase 1 Gmail read path (#2)',
    unread: true,
    messages: [
      {
        from: p('GitHub', 'notifications@github.com'),
        ago: 25 * MIN,
        text: 'zach-conrad requested your review on this pull request.',
      },
    ],
  },
  {
    account: 'work',
    subject: 'Design review moved to 3pm',
    starred: true,
    messages: [
      {
        from: priya,
        ago: 3 * HOUR,
        text: 'Small change: design review is now at 3pm in the big room. Same agenda.',
      },
    ],
  },
  {
    account: 'personal',
    subject: 'Thanksgiving plans',
    messages: [
      { from: 'me', ago: 3 * DAY, text: 'Thinking of flying in the Tuesday before.' },
      {
        from: mom,
        ago: 6 * HOUR,
        text: 'Tuesday is perfect. Dad will pick you up. Bring a sweater, it has been cold!',
      },
    ],
  },
  {
    account: 'dev',
    subject: 'Logo concepts for zachconrad.dev',
    attachment: true,
    unread: true,
    messages: [
      {
        from: sam,
        ago: 2 * HOUR,
        text: 'Three directions attached. I lean toward the second one, the serif mark feels most like you.',
      },
    ],
  },
  {
    account: 'personal',
    subject: 'The Sunday Edition: slow software',
    unsubscribe: true,
    messages: [
      {
        from: p('Stratechery', 'email@stratechery.com'),
        ago: 14 * HOUR,
        text: 'This week: why the fastest apps feel calm, and what local-first means for the next decade of software.',
      },
    ],
  },
  {
    account: 'personal',
    subject: 'Morning Brew ☕️ The rate cut nobody expected',
    unsubscribe: true,
    unread: true,
    messages: [
      {
        from: p('Morning Brew', 'crew@morningbrew.com'),
        ago: 7 * HOUR,
        text: 'Good morning. Markets rallied after a surprise cut, and a startup wants to put data centers at sea.',
      },
    ],
  },
  {
    account: 'dev',
    subject: 'Your Vercel deployment is ready',
    messages: [
      {
        from: p('Vercel', 'no-reply@vercel.com'),
        ago: 4 * HOUR,
        text: 'mail.zachconrad.dev was deployed to production in 41s.',
      },
    ],
  },
  {
    account: 'work',
    subject: 'Offsite venue options',
    unread: true,
    messages: [
      {
        from: priya,
        ago: 26 * HOUR,
        text: 'Shortlisted three venues for the January offsite. Can you rank them by Friday?',
      },
    ],
  },
  {
    account: 'personal',
    subject: 'Your flight to SFO is confirmed',
    attachment: true,
    messages: [
      {
        from: p('United Airlines', 'unitedairlines@news.united.com'),
        ago: 2 * DAY,
        text: 'Confirmation K7Q2XL. Departs Nov 24, 8:05 AM.',
      },
    ],
  },
  {
    account: 'work',
    subject: 'Weekly metrics',
    unsubscribe: true,
    messages: [
      {
        from: p('Acme Analytics', 'reports@acme.co'),
        ago: 30 * HOUR,
        text: 'Active users up 4.2% week over week. Churn flat.',
      },
    ],
  },
  {
    account: 'personal',
    subject: 'Photos from the lake',
    attachment: true,
    done: true,
    messages: [
      {
        from: jordan,
        ago: 4 * DAY,
        text: 'Finally uploaded these. The sunset ones came out great.',
      },
    ],
  },
  {
    account: 'work',
    subject: 'Contract renewal',
    done: true,
    messages: [
      { from: ana, ago: 5 * DAY, text: 'Legal signed off. Renewal goes through on the 1st.' },
    ],
  },
]

const accountId = (s: Seed) => `acc-${s.account}`

export interface DemoMailbox {
  rows: Rows
  bodies: Record<string, MessageBody>
}

export function demoMailbox(now: number): DemoMailbox {
  const threads: ThreadRow[] = []
  const messages: MessageRow[] = []
  const bodies: Record<string, MessageBody> = {}

  seeds.forEach((s, i) => {
    const acc = accounts.find((a) => a.id === accountId(s))!
    const me: Address = { name: acc.displayName ?? undefined, email: acc.email }
    const threadId = `t${i + 1}`
    const msgs = s.messages.map((m, j): MessageRow => {
      const from = m.from === 'me' ? me : m.from
      const last = j === s.messages.length - 1
      const id = `${threadId}m${j + 1}`
      const text = m.text
      bodies[id] = { messageId: id, html: `<p>${text}</p>`, hasRemoteImages: false }
      return {
        id,
        threadId,
        accountId: acc.id,
        from,
        to: [m.from === 'me' ? (s.messages.find((x) => x.from !== 'me')?.from as Address) : me],
        cc: [],
        replyTo: [],
        subject: j === 0 ? s.subject : `Re: ${s.subject}`,
        snippet: text.slice(0, 120),
        date: now - m.ago,
        unread: last && !!s.unread && m.from !== 'me',
        starred: !!s.starred,
        hasAttachments: last && !!s.attachment,
        listUnsubscribe: s.unsubscribe ? `<mailto:unsubscribe@${from.email.split('@')[1]}>` : null,
        rfc822MessageId: `<${id}@demo.zachmail>`,
        bodyStatus: 'cached',
      }
    })
    messages.push(...msgs)
    const last = msgs[msgs.length - 1]!
    const people = new Map<string, Address>()
    for (const m of msgs) if (m.from) people.set(m.from.email, m.from)
    const folderIds = s.done ? [] : [`${acc.id}:inbox`]
    if (msgs.some((m) => m.from?.email === acc.email)) folderIds.push(`${acc.id}:sent`)
    if (s.starred) folderIds.push(`${acc.id}:starred`)
    threads.push({
      id: threadId,
      accountId: acc.id,
      subject: s.subject,
      snippet: last.snippet,
      participants: [...people.values()],
      lastMessageAt: last.date,
      messageCount: msgs.length,
      unread: msgs.some((m) => m.unread),
      starred: !!s.starred,
      hasAttachments: msgs.some((m) => m.hasAttachments),
      folderIds,
    })
  })

  return { rows: { accounts, folders, threads, messages }, bodies }
}
