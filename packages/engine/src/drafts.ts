import {
  enqueueJob,
  loadDraft,
  markDraftSynced,
  purgeDraft,
  type Db,
  type SendPayload,
} from '@zachmail/db/server'
import type { MailProvider } from '@zachmail/providers'
import { buildOutgoing } from './outbox'

export const DRAFT_JOB = 'draft.sync'

/** Autosave lands at the provider once typing pauses, coalescing saves in between. */
const DEBOUNCE_MS = 2_000

export const enqueueDraftSync = (db: Db, userId: string, draftId: string, debounce = false) =>
  enqueueJob(db, {
    userId,
    kind: DRAFT_JOB,
    payload: { draftId },
    dedupeKey: `draft:${draftId}`,
    runAt: debounce ? new Date(Date.now() + DEBOUNCE_MS) : undefined,
  })

/** Brings the provider's copy of a draft up to date, or removes it when the draft is deleted. */
export async function syncDraft(db: Db, draftId: string, provider: MailProvider) {
  const draft = await loadDraft(db, draftId)
  if (!draft) return
  if (draft.deleted) {
    if (draft.providerDraftId) await provider.deleteDraft(draft.providerDraftId)
    await purgeDraft(db, draft.id, draft.version)
    return
  }
  if (draft.syncedVersion >= draft.version) return
  const { raw, providerThreadId } = await buildOutgoing(
    db,
    draft.accountId,
    draft.payload as SendPayload,
  )
  const providerDraftId = await provider.saveDraft(raw, {
    providerDraftId: draft.providerDraftId,
    providerThreadId,
  })
  await markDraftSynced(db, draft.id, draft.version, providerDraftId)
}
