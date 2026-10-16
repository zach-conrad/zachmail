/**
 * Restore and inspect backups.
 *
 *   pnpm --filter @zachhub/backup backups                       # list what the bucket holds
 *   pnpm --filter @zachhub/backup restore                       # newest nightly backup
 *   pnpm --filter @zachhub/backup restore --key zachhub/2026-10-15.ndjson.gz
 *   pnpm --filter @zachhub/backup restore --file ~/Downloads/zachhub-export-2026-10-15.ndjson.gz
 *
 * Flags: --user <uuid> rewrites ownership to that user (a new Supabase project has a new user
 * id); --dry-run reports what would be written and rolls back. Needs DATABASE_URL (session
 * mode, migrations applied) and, for the bucket, the same BACKUP_S3_* the worker uses.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fromPostgresJs } from '@zachhub/db/server'
import postgres from 'postgres'
import { parseBackup } from './format'
import { backupConfigFromEnv } from './job'
import { restoreBackup } from './restore'
import { S3Client } from './s3'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string' },
    key: { type: 'string' },
    user: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
})

function bucket() {
  const config = backupConfigFromEnv()
  if (!config)
    throw new Error('Set BACKUP_S3_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY')
  return { config, s3: new S3Client(config.s3) }
}

async function list() {
  const { config, s3 } = bucket()
  const objects = (await s3.list(config.prefix)).sort((a, b) => a.key.localeCompare(b.key))
  for (const o of objects)
    console.log(`${o.key}\t${(o.size / 1024).toFixed(1)} KB\t${o.lastModified.toISOString()}`)
  if (!objects.length) console.log(`No backups under ${config.prefix}`)
}

async function load(): Promise<{ name: string; bytes: Uint8Array }> {
  if (values.file) {
    // pnpm --filter runs from the package directory; resolve against where the user typed it.
    const path = resolve(process.env.INIT_CWD ?? process.cwd(), values.file)
    return { name: path, bytes: readFileSync(path) }
  }
  const { config, s3 } = bucket()
  let key = values.key
  if (!key) {
    const nightly = (await s3.list(config.prefix))
      .map((o) => o.key)
      .filter((k) => /\d{4}-\d{2}-\d{2}\.ndjson\.gz$/.test(k))
      .sort()
    key = nightly.at(-1)
    if (!key) throw new Error(`No backups under ${config.prefix}`)
  }
  const bytes = await s3.get(key)
  if (!bytes) throw new Error(`No such backup: ${key}`)
  return { name: key, bytes }
}

async function restore() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('Set DATABASE_URL to the database to restore into')
  const { name, bytes } = await load()
  const backup = parseBackup(bytes)
  console.log(
    `Restoring ${name} (made ${backup.header.createdAt})${values['dry-run'] ? ', dry run' : ''}`,
  )
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const report = await restoreBackup(fromPostgresJs(sql as never), backup, {
      userId: values.user,
      dryRun: values['dry-run'],
    })
    for (const t of Object.keys(report.restored))
      console.log(
        `${t.padEnd(24)} ${String(report.restored[t]).padStart(6)} restored  ${report.skipped[t]} skipped`,
      )
    console.log(
      'Skipped rows already existed or point at mail not synced yet. Accounts come back as\n' +
        '"needs reauth": reconnect each one in the app and mail resyncs.',
    )
  } finally {
    await sql.end()
  }
}

const command = positionals[0]
try {
  if (command === 'list') await list()
  else if (command === 'restore') await restore()
  else
    throw new Error(
      'Usage: cli.ts list | restore [--file path | --key key] [--user uuid] [--dry-run]',
    )
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
