import {
  ProviderError,
  type BackfillPage,
  type FetchLike,
  type IncrementalResult,
  type MailProvider,
  type ProviderChange,
  type ProviderFolder,
  type RawBody,
  type SentRef,
  type SyncBatch,
  type SyncState,
  type TokenSource,
  type WatchResult,
} from '../types'
import { mapLimit } from '../util'
import {
  GRAPH_BASE,
  GraphApi,
  GraphHttpError,
  batchError,
  graphPath,
  type BatchRequest,
  type BatchResponse,
} from './api'
import {
  ATTACHMENT_SELECT,
  HIDDEN_FOLDERS,
  MESSAGE_SELECT,
  normalizeAttachment,
  normalizeFolders,
  normalizeMessage,
} from './normalize'
import type {
  GraphAttachment,
  GraphFolder,
  GraphMessage,
  GraphPage,
  WellKnownFolders,
} from './types'

export interface GraphSyncState extends SyncState {
  /** Per folder id: the deltaLink to resume from, or the nextLink of an unfinished first pass. */
  deltas?: Record<string, string>
  wellKnown?: WellKnownFolders
  subscriptionId?: string
}

export interface GraphProviderOptions {
  tokens: TokenSource
  fetch?: FetchLike
  maxRetries?: number
  /** Parallel Graph requests per sync (Outlook allows 4 concurrent requests per mailbox). */
  concurrency?: number
  /** Well-known folder ids from the sync state, saving a lookup per call. */
  wellKnown?: WellKnownFolders
  /** Change-notification endpoint and the secret Graph echoes back; watch() needs it. */
  notifications?: { url: string; clientState: string }
  /** Delta pages per folder per incremental run before handing back with `more`. */
  maxDeltaPages?: number
}

const PAGE = 100
/** Under Graph's 7-day cap for Outlook resources; the watch job renews daily. */
const SUBSCRIPTION_MS = 3 * 24 * 60 * 60 * 1000
/** Graph rejects requests over 4 MB, and MIME goes up base64-encoded. */
const MIME_LIMIT = 4 * 1024 * 1024
/** Inline images up to this size are embedded into the body as data: URLs. */
const INLINE_IMAGE_LIMIT = 1024 * 1024

const WELL_KNOWN: (keyof WellKnownFolders)[] = [
  'inbox',
  'sentitems',
  'drafts',
  'deleteditems',
  'junkemail',
  'archive',
  ...HIDDEN_FOLDERS,
]

/** Microsoft 365 and Outlook.com through Microsoft Graph. Threads are conversations. */
export class GraphProvider implements MailProvider {
  private api: GraphApi
  private concurrency: number
  private wk: Promise<WellKnownFolders> | null

  constructor(private opts: GraphProviderOptions) {
    this.api = new GraphApi(opts.tokens, opts.fetch, opts.maxRetries)
    this.concurrency = opts.concurrency ?? 4
    this.wk = opts.wellKnown ? Promise.resolve(opts.wellKnown) : null
  }

  async profile(): Promise<{ email: string; name: string | null }> {
    const me = await this.api.get<{
      mail?: string | null
      userPrincipalName?: string
      displayName?: string | null
    }>('/me', { $select: 'mail,userPrincipalName,displayName' })
    const email = me.mail || me.userPrincipalName
    if (!email) throw new ProviderError('Microsoft returned no address for this account', false)
    return { email, name: me.displayName ?? null }
  }

  wellKnown(): Promise<WellKnownFolders> {
    return (this.wk ??= (async () => {
      const res = await this.api.batch<{ id: string }>(
        WELL_KNOWN.map((name) => ({
          method: 'GET',
          url: graphPath(`/me/mailFolders/${name}`, { $select: 'id' }),
        })),
      )
      const out: WellKnownFolders = {}
      res.forEach((r, i) => {
        // A mailbox may lack some (no Archive on old mailboxes, no Conversation History).
        if (r.status === 200) out[WELL_KNOWN[i]!] = r.body.id
        else if (r.status !== 404) throw batchError({ method: 'GET', url: WELL_KNOWN[i]! }, r)
      })
      return out
    })().catch((err: unknown) => {
      this.wk = null
      throw err
    }))
  }

  async initialState(): Promise<GraphSyncState> {
    return { deltas: {}, wellKnown: await this.wellKnown() }
  }

  /** Every mail folder, nested ones included, minus hidden ones. */
  async listFolders(): Promise<ProviderFolder[]> {
    const wk = await this.wellKnown()
    const hidden = new Set(HIDDEN_FOLDERS.map((k) => wk[k]))
    const select = 'id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount'
    type Folder = GraphFolder & { childFolderCount?: number }
    const all: Folder[] = []
    let level = await this.pages<Folder>(
      graphPath('/me/mailFolders', { $select: select, $top: 250 }),
    )
    while (level.length) {
      all.push(...level)
      const parents = level.filter((f) => (f.childFolderCount ?? 0) > 0 && !hidden.has(f.id))
      if (!parents.length) break
      const res = await this.api.batch<GraphPage<Folder>>(
        parents.map((f) => ({
          method: 'GET',
          url: graphPath(`/me/mailFolders/${enc(f.id)}/childFolders`, {
            $select: select,
            $top: 250,
          }),
        })),
      )
      level = []
      for (const r of res) {
        if (r.status === 404) continue
        if (r.status !== 200) throw batchError({ method: 'GET', url: '/childFolders' }, r)
        level.push(...(r.body.value ?? []))
        if (r.body['@odata.nextLink'])
          level.push(...(await this.pages<Folder>(r.body['@odata.nextLink'])))
      }
    }
    return normalizeFolders(all, wk)
  }

  /**
   * Newest mail first across all folders, so the inbox fills fast. Only the recent window:
   * the folder deltas that incremental() runs cover everything older.
   */
  async backfillPage(
    cursor: string | null,
    opts: { sinceDays?: number; beforeDays?: number } = {},
  ): Promise<BackfillPage> {
    if (!cursor && opts.beforeDays) return { batch: emptyBatch(), cursor: null }
    const since = opts.sinceDays
      ? new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString()
      : undefined
    const url =
      cursor ??
      graphPath('/me/messages', {
        $select: MESSAGE_SELECT,
        $filter: since ? `receivedDateTime ge ${since}` : undefined,
        $orderby: 'receivedDateTime desc',
        $top: PAGE,
      })
    const [page, folders] = await Promise.all([
      this.api.get<GraphPage<GraphMessage>>(url),
      cursor ? undefined : this.listFolders(),
    ])
    const messages = page.value ?? []
    return {
      batch: {
        folders,
        messages: await this.normalize(messages),
        deletedMessageIds: [],
      },
      cursor: page['@odata.nextLink'] ?? null,
    }
  }

  async incremental(state: GraphSyncState): Promise<IncrementalResult> {
    if (!state.deltas) return { batch: emptyBatch(), next: state, resyncRequired: true }
    const folders = await this.listFolders()
    const wk = await this.wellKnown()
    // Inbox first, so new mail lands before the first pass over big folders finishes.
    const ids = folders
      .map((f) => f.providerId)
      .sort((a, b) => Number(b === wk.inbox) - Number(a === wk.inbox))
    const { items, links, more } = await this.deltas(ids, state.deltas)

    const changed = new Map<string, GraphMessage>()
    const removed = new Set<string>()
    for (const m of items) {
      if (m['@removed']) removed.add(m.id)
      else changed.set(m.id, m)
    }
    for (const id of changed.keys()) removed.delete(id)
    // Leaving a folder is usually a move (archive, trash), so look before deleting.
    // Partial delta entries are re-read whole.
    const check = [
      ...removed,
      ...[...changed.values()]
        .filter((m) => !m.conversationId || !m.parentFolderId)
        .map((m) => m.id),
    ]
    const deleted: string[] = []
    const current = await this.getMessages(check)
    check.forEach((id, i) => {
      const m = current[i]
      if (m) changed.set(id, m)
      else {
        changed.delete(id)
        deleted.push(id)
      }
    })

    return {
      batch: {
        folders,
        messages: await this.normalize([...changed.values()]),
        deletedMessageIds: deleted,
      },
      next: { ...state, deltas: links, wellKnown: wk },
      more,
    }
  }

  /**
   * One delta pass over each folder: the first page of every folder in one batch, then the
   * folders with more pages one by one, up to maxDeltaPages each.
   */
  private async deltas(folderIds: string[], prev: Record<string, string>) {
    const initial = (id: string) =>
      graphPath(`/me/mailFolders/${enc(id)}/messages/delta`, { $select: MESSAGE_SELECT })
    const maxPages = this.opts.maxDeltaPages ?? 20
    const items: GraphMessage[] = []
    const links: Record<string, string> = {}
    const follow: { id: string; url: string; pages: number }[] = []
    let more = false

    const take = (id: string, page: GraphPage<GraphMessage>, pages: number) => {
      items.push(...(page.value ?? []))
      if (page['@odata.deltaLink']) links[id] = page['@odata.deltaLink']
      else if (page['@odata.nextLink']) follow.push({ id, url: page['@odata.nextLink'], pages })
    }

    const first = await this.api.batch<GraphPage<GraphMessage>>(
      folderIds.map((id) => ({
        method: 'GET',
        url: relative(prev[id] ?? initial(id)),
        prefer: `odata.maxpagesize=${PAGE}`,
      })),
    )
    const restart: string[] = []
    first.forEach((r, i) => {
      const id = folderIds[i]!
      if (r.status === 200) take(id, r.body, 1)
      else if (isExpired(r.status, r.body) && prev[id]) restart.push(id)
      else if (r.status !== 404) throw batchError({ method: 'GET', url: '/messages/delta' }, r)
      // 404: the folder went away since it was listed.
    })
    for (const id of restart) follow.push({ id, url: initial(id), pages: 0 })

    await mapLimit(follow, this.concurrency, async ({ id, url, pages }) => {
      for (;;) {
        if (pages >= maxPages) {
          links[id] = url
          more = true
          return
        }
        let page: GraphPage<GraphMessage>
        try {
          page = await this.api.get<GraphPage<GraphMessage>>(url, {}, { pageSize: PAGE })
        } catch (err) {
          // A first pass left too long expires; start that folder over next run.
          if (
            err instanceof GraphHttpError &&
            isExpired(err.status, { error: { code: err.code } })
          ) {
            more = true
            return
          }
          if (err instanceof GraphHttpError && err.status === 404) return
          throw err
        }
        pages++
        items.push(...(page.value ?? []))
        if (page['@odata.deltaLink']) {
          links[id] = page['@odata.deltaLink']
          return
        }
        if (!page['@odata.nextLink']) return
        url = page['@odata.nextLink']
      }
    })
    return { items, links, more }
  }

  async watch(state: GraphSyncState): Promise<WatchResult> {
    const n = this.opts.notifications
    if (!n) throw new Error('GraphProvider.watch needs notifications')
    const expiresAt = new Date(Date.now() + SUBSCRIPTION_MS)
    if (state.subscriptionId) {
      try {
        await this.api.patch(`/subscriptions/${enc(state.subscriptionId)}`, {
          expirationDateTime: expiresAt.toISOString(),
        })
        return { state, expiresAt }
      } catch (err) {
        if (!(err instanceof GraphHttpError && err.status === 404)) throw err
      }
    }
    // Graph checks the endpoint (validationToken round trip) before this returns.
    const sub = await this.api.post<{ id: string; expirationDateTime: string }>('/subscriptions', {
      changeType: 'created,updated,deleted',
      notificationUrl: n.url,
      lifecycleNotificationUrl: n.url,
      resource: 'me/messages',
      expirationDateTime: expiresAt.toISOString(),
      clientState: n.clientState,
    })
    return {
      state: { ...state, subscriptionId: sub.id },
      expiresAt: new Date(sub.expirationDateTime),
    }
  }

  async fetchBody(providerMessageId: string): Promise<RawBody> {
    const id = enc(providerMessageId)
    const [m, list] = await Promise.all([
      this.api.get<GraphMessage>(`/me/messages/${id}`, { $select: 'body' }),
      this.api.get<GraphPage<GraphAttachment>>(`/me/messages/${id}/attachments`, {
        $select: ATTACHMENT_SELECT,
      }),
    ])
    const attachments = list.value ?? []
    const content = m.body?.content ?? ''
    if (m.body?.contentType !== 'html') return { html: null, text: content, attachments: [] }

    // Inline images reference cid: parts; embed them so the body renders on its own.
    const inline = /cid:/i.test(content)
      ? attachments.filter((a) => a.isInline && (a.size ?? 0) <= INLINE_IMAGE_LIMIT)
      : []
    const full = await this.api.batch<GraphAttachment & { contentBytes?: string }>(
      inline.map((a) => ({ method: 'GET', url: `/me/messages/${id}/attachments/${enc(a.id)}` })),
    )
    const byCid = new Map<string, string>()
    for (const r of full) {
      const a = r.body
      if (r.status !== 200 || !a.contentId || !a.contentBytes) continue
      const cid = a.contentId.replace(/^<|>$/g, '')
      byCid.set(cid.toLowerCase(), `data:${a.contentType ?? 'image/png'};base64,${a.contentBytes}`)
    }
    const html = byCid.size
      ? content.replace(/(["'])cid:([^"']+)\1/gi, (whole, q: string, cid: string) => {
          const data = byCid.get(cid.toLowerCase())
          return data ? `${q}${data}${q}` : whole
        })
      : content
    return { html, text: null, attachments: attachments.map(normalizeAttachment) }
  }

  async fetchAttachment(
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Uint8Array> {
    return this.api.getBytes(
      `/me/messages/${enc(providerMessageId)}/attachments/${enc(providerAttachmentId)}/$value`,
    )
  }

  /**
   * Outlook has one folder per message, so folder changes are moves: added folder → move
   * there; removed folder with nothing added (archive, unlabel) → Archive. Sent copies and
   * drafts stay put except on trash. Read applies to the whole conversation; unread and the
   * flag go on its latest received message, as Outlook does.
   */
  async apply(providerThreadIds: string[], change: ProviderChange): Promise<void> {
    const wk = await this.wellKnown()
    const all = await this.conversationMessages(
      providerThreadIds,
      'id,parentFolderId,isRead,isDraft,flag,receivedDateTime',
    )
    const remove = new Set(change.remove)
    const target = change.add.find((id) => !remove.has(id))
    const staysPut = new Set([wk.sentitems, wk.drafts].filter(Boolean))
    const patches: BatchRequest[] = []
    const moves: BatchRequest[] = []

    for (const msgs of all) {
      const live = msgs.filter((m) => !m.isDraft)
      for (const m of live) {
        const folder = m.parentFolderId ?? ''
        let dest: string | undefined
        if (target) {
          if (folder !== target && (target === wk.deleteditems || !staysPut.has(folder)))
            dest = target
        } else if (remove.has(folder)) {
          if (!wk.archive) throw new ProviderError('This mailbox has no Archive folder', false)
          dest = wk.archive
        }
        if (dest)
          moves.push({
            method: 'POST',
            url: `/me/messages/${enc(m.id)}/move`,
            body: { destinationId: dest },
          })
      }

      const received = live.filter((m) => m.parentFolderId !== wk.sentitems)
      const latest = latestOf(received.length ? received : live)
      const patch = (m: GraphMessage, body: unknown) =>
        patches.push({ method: 'PATCH', url: `/me/messages/${enc(m.id)}`, body })
      if (change.unread === false)
        live.filter((m) => !m.isRead).forEach((m) => patch(m, { isRead: true }))
      if (change.unread === true && latest?.isRead) patch(latest, { isRead: false })
      const flagged = live.filter((m) => m.flag?.flagStatus === 'flagged')
      if (change.starred === true && !flagged.length && latest)
        patch(latest, { flag: { flagStatus: 'flagged' } })
      if (change.starred === false)
        flagged.forEach((m) => patch(m, { flag: { flagStatus: 'notFlagged' } }))
    }

    // Flags before moves: concurrent writes to one item can conflict.
    for (const reqs of [patches, moves]) {
      const res = await this.api.batch(reqs)
      res.forEach((r, i) => {
        if (r.status >= 300 && r.status !== 404) throw batchError(reqs[i]!, r)
      })
    }
  }

  /**
   * Graph only sends drafts it holds, so the MIME becomes a draft first and is then sent.
   * The copy in Sent Items is picked up by the next sync.
   */
  async send(raw: Uint8Array): Promise<SentRef> {
    const draft = await this.createFromMime(raw)
    try {
      await this.api.post(`/me/messages/${enc(draft.id)}/send`, undefined, { idempotent: false })
    } catch (err) {
      // Refused outright: nothing went out, so drop the draft. A 5xx may have sent it.
      if (err instanceof GraphHttpError && err.status < 500)
        await this.deleteDraft(draft.id).catch(() => {})
      throw err
    }
    return { providerMessageId: draft.id, providerThreadId: draft.conversationId ?? draft.id }
  }

  /** Graph can't replace a draft's MIME, so a save makes a new draft and drops the old one. */
  async saveDraft(raw: Uint8Array, opts: { providerDraftId?: string | null }): Promise<string> {
    const created = await this.createFromMime(raw)
    if (opts.providerDraftId) await this.deleteDraft(opts.providerDraftId)
    return created.id
  }

  async deleteDraft(providerDraftId: string): Promise<void> {
    // permanentDelete keeps autosave churn out of Deleted Items.
    await this.api
      .post(`/me/messages/${enc(providerDraftId)}/permanentDelete`)
      .catch(notFoundAs(undefined))
  }

  async fetchThreads(providerThreadIds: string[]): Promise<SyncBatch> {
    const all = await this.conversationMessages(providerThreadIds, MESSAGE_SELECT)
    return { messages: await this.normalize(all.flat()), deletedMessageIds: [] }
  }

  private async createFromMime(raw: Uint8Array) {
    if (Math.ceil(raw.byteLength / 3) * 4 > MIME_LIMIT)
      throw new ProviderError(
        'Outlook accounts take messages up to about 3 MB with attachments for now',
        false,
      )
    return this.api.postMime<{ id: string; conversationId?: string }>('/me/messages', raw)
  }

  /** Messages of each conversation, in input order. */
  private async conversationMessages(ids: string[], select: string): Promise<GraphMessage[][]> {
    const reqs: BatchRequest[] = ids.map((id) => ({
      method: 'GET',
      url: graphPath('/me/messages', {
        $filter: `conversationId eq '${id.replace(/'/g, "''")}'`,
        $select: select,
        $top: 250,
      }),
    }))
    const res = await this.api.batch<GraphPage<GraphMessage>>(reqs)
    return Promise.all(
      res.map(async (r, i) => {
        if (r.status !== 200) throw batchError(reqs[i]!, r)
        const next = r.body['@odata.nextLink']
        return [...(r.body.value ?? []), ...(next ? await this.pages<GraphMessage>(next) : [])]
      }),
    )
  }

  /** Current metadata of messages by id; null for ones that no longer exist. */
  private async getMessages(ids: string[]): Promise<(GraphMessage | null)[]> {
    const reqs: BatchRequest[] = ids.map((id) => ({
      method: 'GET',
      url: graphPath(`/me/messages/${enc(id)}`, { $select: MESSAGE_SELECT }),
    }))
    const res = await this.api.batch<GraphMessage>(reqs)
    return res.map((r, i) => {
      if (r.status === 200) return r.body
      if (r.status === 404) return null
      throw batchError(reqs[i]!, r)
    })
  }

  /** Normalizes messages, loading attachment lists for the ones that have attachments. */
  private async normalize(messages: GraphMessage[]) {
    const need = messages.filter((m) => m.hasAttachments && !m.attachments)
    const reqs: BatchRequest[] = need.map((m) => ({
      method: 'GET',
      url: graphPath(`/me/messages/${enc(m.id)}/attachments`, { $select: ATTACHMENT_SELECT }),
    }))
    const res = await this.api.batch<GraphPage<GraphAttachment>>(reqs)
    const lists = new Map<string, GraphAttachment[]>()
    res.forEach((r: BatchResponse<GraphPage<GraphAttachment>>, i) => {
      if (r.status === 200) lists.set(need[i]!.id, r.body.value ?? [])
      else if (r.status !== 404) throw batchError(reqs[i]!, r)
    })
    return messages.map((m) => normalizeMessage(m, lists.get(m.id) ?? m.attachments ?? []))
  }

  private async pages<T>(url: string): Promise<T[]> {
    const out: T[] = []
    for (let next: string | undefined = url; next;) {
      const page: GraphPage<T> = await this.api.get<GraphPage<T>>(next)
      out.push(...(page.value ?? []))
      next = page['@odata.nextLink']
    }
    return out
  }
}

const enc = encodeURIComponent

const emptyBatch = (): SyncBatch => ({ messages: [], deletedMessageIds: [] })

/** Batch sub-requests take paths relative to /v1.0; delta links come back absolute. */
const relative = (url: string) => (url.startsWith(GRAPH_BASE) ? url.slice(GRAPH_BASE.length) : url)

const latestOf = (msgs: GraphMessage[]) =>
  msgs.reduce<GraphMessage | undefined>(
    (best, m) => (!best || (m.receivedDateTime ?? '') > (best.receivedDateTime ?? '') ? m : best),
    undefined,
  )

/** A delta token Graph no longer honours: that folder starts over. */
function isExpired(status: number, body: unknown): boolean {
  const code = (body as { error?: { code?: string } } | undefined)?.error?.code?.toLowerCase()
  return (
    status === 410 ||
    code === 'syncstatenotfound' ||
    code === 'syncstateinvalid' ||
    code === 'resyncrequired'
  )
}

const notFoundAs =
  <T>(value: T) =>
  (err: unknown): T => {
    if (err instanceof GraphHttpError && err.status === 404) return value
    throw err
  }
