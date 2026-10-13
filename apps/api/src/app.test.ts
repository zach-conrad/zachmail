import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app'

const SUPABASE_URL = 'https://example.supabase.co'
const env = { SUPABASE_URL, ALLOWED_EMAILS: 'zach@example.com', GIT_SHA: 'abc123' }

let sign: (claims: Record<string, unknown>) => Promise<string>
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }
  app = createApp(env, { keys: createLocalJWKSet({ keys: [jwk] }) })
  sign = (claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setSubject('user-1')
      .setExpirationTime('5m')
      .sign(privateKey)
})

const get = (path: string, token?: string) =>
  app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} })

describe('api', () => {
  it('serves health without auth', async () => {
    const res = await get('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sha: 'abc123' })
  })

  it('rejects missing and invalid tokens', async () => {
    expect((await get('/api/me')).status).toBe(401)
    expect((await get('/api/me', 'not-a-jwt')).status).toBe(401)
  })

  it('rejects valid tokens for emails not on the allowlist', async () => {
    expect((await get('/api/me', await sign({ email: 'someone@else.com' }))).status).toBe(403)
  })

  it('admits the allowlisted user', async () => {
    const res = await get('/api/me', await sign({ email: 'Zach@Example.com' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'user-1', email: 'zach@example.com' })
  })
})
