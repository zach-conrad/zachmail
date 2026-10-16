import { describe, expect, it } from 'vitest'
import { backupConfigFromEnv } from '../src/job'
import { S3Client, signRequest } from '../src/s3'
import { fakeS3 } from './fakeS3'

// The worked examples in the AWS SigV4 for S3 docs ("Examples: Signature Calculations").
const aws = {
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const now = new Date('2013-05-24T00:00:00Z')

describe('signRequest', () => {
  it('matches the AWS GET object example', () => {
    const h = signRequest(aws, {
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      query: {},
      headers: { Range: 'bytes=0-9' },
      payloadHash: EMPTY,
      now,
    })
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })

  it('matches the AWS list objects example', () => {
    const h = signRequest(aws, {
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/',
      query: { 'max-keys': '2', prefix: 'J' },
      headers: {},
      payloadHash: EMPTY,
      now,
    })
    expect(h.authorization).toContain(
      'Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    )
  })
})

describe('S3Client', () => {
  const config = {
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    bucket: 'backups',
    region: 'auto',
    accessKeyId: 'id',
    secretAccessKey: 'secret',
  }

  it('puts, gets, lists across pages and deletes with path-style URLs', async () => {
    const s3 = fakeS3({ pageSize: 2 })
    const client = new S3Client(config, s3.fetch)
    for (const k of ['p/a b.gz', 'p/b.gz', 'p/c.gz', 'other.gz'])
      await client.put(k, new Uint8Array([1, 2, 3]))
    expect(s3.requests[0]).toMatch(
      /^PUT https:\/\/acct\.r2\.cloudflarestorage\.com\/backups\/p\/a%20b\.gz$/,
    )
    expect(await client.get('p/b.gz')).toEqual(new Uint8Array([1, 2, 3]))
    expect(await client.get('missing')).toBeNull()
    expect((await client.list('p/')).map((o) => o.key)).toEqual(['p/a b.gz', 'p/b.gz', 'p/c.gz'])
    await client.delete('p/b.gz')
    expect([...s3.objects.keys()].sort()).toEqual(['other.gz', 'p/a b.gz', 'p/c.gz'])
  })

  it('reports provider errors with their code', async () => {
    const client = new S3Client(
      config,
      async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
    )
    await expect(client.put('k', new Uint8Array())).rejects.toThrow('403 AccessDenied')
  })
})

describe('backupConfigFromEnv', () => {
  const base = {
    BACKUP_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
    BACKUP_S3_BUCKET: 'zach-backups',
    BACKUP_S3_ACCESS_KEY_ID: 'kid',
    BACKUP_S3_SECRET_ACCESS_KEY: 'sk',
  }

  it('is off until every essential is set', () => {
    expect(backupConfigFromEnv({})).toBeNull()
    expect(backupConfigFromEnv({ ...base, BACKUP_S3_BUCKET: '' })).toBeNull()
  })

  it('defaults to R2 region, 30 days and 10:00 UTC', () => {
    expect(backupConfigFromEnv(base)).toEqual({
      s3: {
        endpoint: base.BACKUP_S3_ENDPOINT,
        bucket: 'zach-backups',
        region: 'auto',
        accessKeyId: 'kid',
        secretAccessKey: 'sk',
      },
      prefix: 'zachhub/',
      retentionDays: 30,
      hourUtc: 10,
    })
  })

  it('takes B2 region, prefix, retention and hour', () => {
    const c = backupConfigFromEnv({
      ...base,
      BACKUP_S3_REGION: 'us-west-004',
      BACKUP_PREFIX: 'hub',
      BACKUP_RETENTION_DAYS: '45',
      BACKUP_HOUR_UTC: '3',
    })
    expect(c).toMatchObject({ prefix: 'hub/', retentionDays: 45, hourUtc: 3 })
    expect(c!.s3.region).toBe('us-west-004')
    expect(() => backupConfigFromEnv({ ...base, BACKUP_HOUR_UTC: '24' })).toThrow('BACKUP_HOUR_UTC')
  })
})
