import type {
  BackfillPage,
  IncrementalResult,
  MailProvider,
  ProviderChange,
  SentRef,
  ProviderMessage,
  RawBody,
  SearchPage,
  SyncBatch,
  SyncState,
  WatchResult,
} from '../types'
import { decodeBase64Url, mapLimit } from '../util'
import { GmailApi, GmailHttpError, type FetchLike, type TokenSource } from './api'
import { METADATA_HEADERS, extractBody, normalizeLabel, normalizeMessage } from './normalize'
import type { GmailHistoryRecord, GmailLabel, GmailMessage, GmailThread } from './types'

export interface GmailSyncState extends SyncState {
  historyId?: string
}

export interface GmailProviderOptions {
  tokens: TokenSource
  /** Pub/Sub topic for users.watch, e.g. projects/<p>/topics/gmail-push. */
  pubsubTopic?: string
  fetch?: FetchLike
  /** Parallel Gmail requests per sync (Gmail allows ~250 quota units/s per user). */
  concurrency?: number
  /** Retries of rate-limited / 5xx requests before giving up (default 4). */
  maxRetries?: number
}

export class GmailProvider implements MailProvider {
  private api: GmailApi
  private concurrency: number

  constructor(private opts: GmailProviderOptions) {
    this.api = new GmailApi(opts.tokens, opts.fetch, opts.maxRetries)
    this.concurrency = opts.concurrency ?? 8
  }

  async profile() {
    return this.api.get<{ emailAddress: string; historyId: string }>('/profile')
  }

  async initialState(): Promise<GmailSyncState> {
    const p = await this.profile()
    return { historyId: p.historyId }
  }

  async listFolders() {
    const { labels = [] } = await this.api.get<{ labels?: GmailLabel[] }>('/labels')
    return labels.map(normalizeLabel).filter((f) => f !== null)
  }

  async backfillPage(
    cursor: string | null,
    opts: { sinceDays?: number; beforeDays?: number } = {},
  ): Promise<BackfillPage> {
    const q = [
      opts.sinceDays ? `newer_than:${opts.sinceDays}d` : '',
      opts.beforeDays ? `older_than:${opts.beforeDays}d` : '',
      '-in:chats',
    ]
      .filter(Boolean)
      .join(' ')
    const list = await this.api.get<{ threads?: { id: string }[]; nextPageToken?: string }>(
      '/threads',
      {
        q,
        maxResults: 50,
        pageToken: cursor ?? undefined,
      },
    )
    const threads = await mapLimit(list.threads ?? [], this.concurrency, (t) =>
      this.api
        .get<GmailThread>(`/threads/${t.id}`, {
          format: 'metadata',
          metadataHeaders: METADATA_HEADERS,
        })
        .catch(notFoundAs(null)),
    )
    const batch: SyncBatch = {
      messages: threads.flatMap((t) => t?.messages ?? []).map(normalizeMessage),
      deletedMessageIds: [],
    }
    if (!cursor) batch.folders = await this.listFolders()
    return { batch, cursor: list.nextPageToken ?? null }
  }

  async incremental(state: GmailSyncState): Promise<IncrementalResult> {
    if (!state.historyId) return { batch: emptyBatch(), next: state, resyncRequired: true }

    const touched = new Set<string>()
    const deleted = new Set<string>()
    let latest: string | undefined
    let pageToken: string | undefined
    try {
      do {
        const page = await this.api.get<{
          history?: GmailHistoryRecord[]
          historyId: string
          nextPageToken?: string
        }>('/history', { startHistoryId: state.historyId, pageToken, maxResults: 500 })
        for (const h of page.history ?? []) {
          for (const x of h.messagesAdded ?? []) touched.add(x.message.id)
          for (const x of h.labelsAdded ?? []) touched.add(x.message.id)
          for (const x of h.labelsRemoved ?? []) touched.add(x.message.id)
          for (const x of h.messagesDeleted ?? []) deleted.add(x.message.id)
        }
        latest = page.historyId
        pageToken = page.nextPageToken
      } while (pageToken)
    } catch (err) {
      // A historyId older than Gmail keeps (about a week) answers 404: start over.
      if (err instanceof GmailHttpError && err.status === 404) {
        return { batch: emptyBatch(), next: {}, resyncRequired: true }
      }
      throw err
    }

    for (const id of deleted) touched.delete(id)
    const ids = [...touched]
    const fetched = await mapLimit(ids, this.concurrency, (id) =>
      this.api
        .get<GmailMessage>(`/messages/${id}`, {
          format: 'metadata',
          metadataHeaders: METADATA_HEADERS,
        })
        .catch(notFoundAs(null)),
    )
    const messages: ProviderMessage[] = []
    fetched.forEach((m, i) => {
      if (m) messages.push(normalizeMessage(m))
      else deleted.add(ids[i]!)
    })

    return {
      batch: {
        folders: touched.size || deleted.size ? await this.listFolders() : undefined,
        messages,
        deletedMessageIds: [...deleted],
      },
      next: { ...state, historyId: latest ?? state.historyId },
    }
  }

  async watch(state: GmailSyncState): Promise<WatchResult> {
    if (!this.opts.pubsubTopic) throw new Error('GmailProvider.watch needs pubsubTopic')
    const r = await this.api.post<{ historyId: string; expiration: string }>('/watch', {
      topicName: this.opts.pubsubTopic,
    })
    // Keep our own (older) cursor if we have one so no history between the two is skipped.
    return {
      state: { ...state, historyId: state.historyId ?? r.historyId },
      expiresAt: new Date(Number(r.expiration)),
    }
  }

  async fetchBody(providerMessageId: string): Promise<RawBody> {
    const m = await this.api.get<GmailMessage>(`/messages/${providerMessageId}`, { format: 'full' })
    if (!m.payload) return { html: null, text: null, attachments: [] }
    return extractBody(m.payload, async (attachmentId) => {
      const a = await this.api.get<{ data: string }>(
        `/messages/${providerMessageId}/attachments/${attachmentId}`,
      )
      return a.data
    })
  }

  async fetchAttachment(
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Uint8Array> {
    const a = await this.api.get<{ data: string }>(
      `/messages/${providerMessageId}/attachments/${providerAttachmentId}`,
    )
    return decodeBase64Url(a.data)
  }

  async apply(providerThreadIds: string[], change: ProviderChange): Promise<void> {
    const add = new Set(change.add)
    const remove = new Set(change.remove)
    if (change.unread !== undefined) (change.unread ? add : remove).add('UNREAD')
    if (change.starred !== undefined) (change.starred ? add : remove).add('STARRED')
    // Trash has its own endpoints; modify can't move messages in or out of it.
    const trash = add.delete('TRASH')
    const untrash = remove.delete('TRASH')
    for (const id of add) remove.delete(id)

    await mapLimit(providerThreadIds, this.concurrency, async (id) => {
      try {
        if (untrash) await this.api.post(`/threads/${id}/untrash`, {})
        if (add.size || remove.size)
          await this.api.post(`/threads/${id}/modify`, {
            addLabelIds: [...add],
            removeLabelIds: [...remove],
          })
        if (trash) await this.api.post(`/threads/${id}/trash`, {})
      } catch (err) {
        notFoundAs(undefined)(err)
      }
    })
  }

  async send(raw: Uint8Array, opts: { providerThreadId?: string } = {}): Promise<SentRef> {
    // Big messages go through the media endpoint; it can't carry threadId, but Gmail threads
    // by In-Reply-To/References and subject, which replies always set.
    const r =
      raw.byteLength > JSON_RAW_LIMIT
        ? await this.api.uploadMessage<{ id: string; threadId: string }>(
            'POST',
            '/messages/send',
            raw,
            { idempotent: false },
          )
        : await this.api.post<{ id: string; threadId: string }>(
            '/messages/send',
            { raw: Buffer.from(raw).toString('base64url'), threadId: opts.providerThreadId },
            { idempotent: false },
          )
    return { providerMessageId: r.id, providerThreadId: r.threadId }
  }

  async saveDraft(
    raw: Uint8Array,
    opts: { providerDraftId?: string | null; providerThreadId?: string },
  ): Promise<string> {
    const large = raw.byteLength > JSON_RAW_LIMIT
    const body = {
      message: { raw: Buffer.from(raw).toString('base64url'), threadId: opts.providerThreadId },
    }
    if (opts.providerDraftId) {
      const path = `/drafts/${opts.providerDraftId}`
      const updated = await (
        large
          ? this.api.uploadMessage<{ id: string }>('PUT', path, raw)
          : this.api.put<{ id: string }>(path, { id: opts.providerDraftId, ...body })
      ).catch(notFoundAs(null))
      if (updated) return updated.id
    }
    const created = large
      ? await this.api.uploadMessage<{ id: string }>('POST', '/drafts', raw)
      : await this.api.post<{ id: string }>('/drafts', body)
    return created.id
  }

  async deleteDraft(providerDraftId: string): Promise<void> {
    await this.api.delete(`/drafts/${providerDraftId}`).catch(notFoundAs(undefined))
  }

  async fetchThreads(providerThreadIds: string[]): Promise<SyncBatch> {
    const threads = await mapLimit(providerThreadIds, this.concurrency, (id) =>
      this.api
        .get<GmailThread>(`/threads/${id}`, {
          format: 'metadata',
          metadataHeaders: METADATA_HEADERS,
        })
        .catch(notFoundAs(null)),
    )
    return {
      messages: threads.flatMap((t) => t?.messages ?? []).map(normalizeMessage),
      deletedMessageIds: [],
    }
  }

  async searchThreads(
    query: string,
    opts: { limit: number; pageToken?: string | null },
  ): Promise<SearchPage> {
    const r = await this.api.get<{ threads?: { id: string }[]; nextPageToken?: string }>(
      '/threads',
      { q: query, maxResults: Math.min(opts.limit, 500), pageToken: opts.pageToken ?? undefined },
    )
    return {
      providerThreadIds: (r.threads ?? []).map((t) => t.id),
      pageToken: r.nextPageToken ?? null,
    }
  }
}

/** Above this, messages are sent as a media upload instead of base64 JSON. */
const JSON_RAW_LIMIT = 4 * 1024 * 1024

const emptyBatch = (): SyncBatch => ({ messages: [], deletedMessageIds: [] })

const notFoundAs =
  <T>(value: T) =>
  (err: unknown): T => {
    if (err instanceof GmailHttpError && err.status === 404) return value
    throw err
  }
