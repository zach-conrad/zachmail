import type {
  BackfillPage,
  IncrementalResult,
  MailProvider,
  ProviderMessage,
  RawBody,
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
}

export class GmailProvider implements MailProvider {
  private api: GmailApi
  private concurrency: number

  constructor(private opts: GmailProviderOptions) {
    this.api = new GmailApi(opts.tokens, opts.fetch)
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
    let latest = state.historyId
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
      next: { ...state, historyId: latest },
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
}

const emptyBatch = (): SyncBatch => ({ messages: [], deletedMessageIds: [] })

const notFoundAs =
  <T>(value: T) =>
  (err: unknown): T => {
    if (err instanceof GmailHttpError && err.status === 404) return value
    throw err
  }
