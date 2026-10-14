import { describe, expect, it } from 'vitest'
import { DEFAULT_UNDO_MS, InvalidSendError, parseSendRequest } from './send'

const ID = '00000000-0000-4000-8000-000000000001'
const ok = { id: ID, accountId: ID, to: [{ email: 'a@x.com', name: 'A' }], subject: 's', html: 'h' }

describe('parseSendRequest', () => {
  it('accepts a minimal message and fills defaults', () => {
    expect(parseSendRequest(ok)).toEqual({ ...ok, cc: [], bcc: [], undoMs: DEFAULT_UNDO_MS })
  })

  it('rejects bad input', () => {
    const bad = [
      { ...ok, id: 'x' },
      { ...ok, to: [] },
      { ...ok, to: [{ email: 'a@x.com\r\nBcc: evil@x.com' }] },
      { ...ok, undoMs: 60_000 },
      { ...ok, replyToMessageId: 'x' },
      { ...ok, html: 5 },
    ]
    for (const b of bad) expect(() => parseSendRequest(b)).toThrow(InvalidSendError)
  })
})
