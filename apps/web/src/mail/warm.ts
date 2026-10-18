import type { DataClient } from '../data/client'

const PREFETCH_TOP = 50

/**
 * ZachHub opens on Today, so Mail's list may not be on screen when the first sync lands.
 * Once it does, fetch the bodies for the top of the Important split anyway, so the first
 * thread opened after `G M` is as instant as it would be from the inbox.
 */
export function warmMailAfterSync(client: DataClient): () => void {
  let syncing = client.getStatus().syncing
  const off = client.subscribeStatus(() => {
    const s = client.getStatus()
    const finished = syncing && !s.syncing && !s.error
    syncing = s.syncing
    if (!finished) return
    off()
    void client.api
      .listThreads({ split: 'important' }, 0, PREFETCH_TOP)
      .then((rows) => client.api.ensureBodies(rows.map((r) => r.id)))
      .catch(() => {})
  })
  return off
}
