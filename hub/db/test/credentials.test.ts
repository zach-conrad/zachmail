import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '../src/server/credentials'

describe('secret encryption', () => {
  const key = randomBytes(32)

  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret('refresh-token', key)
    const b = encryptSecret('refresh-token', key)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(decryptSecret(a, key)).toBe('refresh-token')
  })

  it('rejects tampered ciphertext and wrong keys', () => {
    const enc = encryptSecret('secret', key)
    const bytes = Buffer.from(enc.ciphertext, 'base64')
    bytes[0] = bytes[0]! ^ 1
    expect(() => decryptSecret({ ...enc, ciphertext: bytes.toString('base64') }, key)).toThrow()
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow()
  })
})
