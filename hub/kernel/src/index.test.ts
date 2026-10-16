import type { HubNotice } from '@zachhub/core'
import { describe, expect, it } from 'vitest'
import { HUB_NOTIFY_JOB, enqueueHubNotify, installModules, type HubModule } from './index'

const table = (kind: string) => ({
  kind,
  table: 'tasks.tasks',
  fields: { title: { column: 'title', type: 'text' as const } },
})

describe('installModules', () => {
  it('always installs the hub module and registers every entity', () => {
    const got = installModules([{ name: 'tasks', entities: [table('tasks.task')] }])
    expect(got.modules.map((m) => m.name)).toEqual(['hub', 'tasks'])
    expect(got.entities.get('hub.link')).toBeDefined()
    expect(got.entities.get('tasks.task')).toBeDefined()
  })

  it.each<[HubModule[], RegExp]>([
    [[{ name: 'Tasks' }], /Bad module name/],
    [[{ name: 'tasks' }, { name: 'tasks' }], /installed twice/],
    [[{ name: 'tasks', entities: [table('docs.doc')] }], /foreign entity/],
  ])('refuses clashing modules (%#)', (list, error) => {
    expect(() => installModules(list)).toThrow(error)
  })

  it('merges job handlers and refuses ones outside the module', () => {
    const noop = async () => {}
    const ctx = { db: {} as never, notify: async () => 0 }
    const ok = installModules([{ name: 'tasks', jobs: () => ({ 'tasks.remind': noop }) }])
    expect(Object.keys(ok.jobs(ctx))).toEqual([HUB_NOTIFY_JOB, 'tasks.remind'])
    const bad = installModules([{ name: 'tasks', jobs: () => ({ 'mail.sync': noop }) }])
    expect(() => bad.jobs(ctx)).toThrow(/foreign job/)
  })
})

describe('hub notices', () => {
  const alert: HubNotice = {
    kind: 'tasks.alert',
    title: 'Pay rent',
    body: 'Due today',
    deepLink: '/tasks/t1',
    tag: 't1',
  }

  it('hands modules the notifier and pushes queued notices through it', async () => {
    const sent: [string, HubNotice][] = []
    const notify = async (userId: string, n: HubNotice) => (sent.push([userId, n]), 1)
    const ran = installModules([
      {
        name: 'tasks',
        jobs: (ctx) => ({ 'tasks.alert': (j) => ctx.notify(j.userId, alert).then() }),
      },
    ]).jobs({ db: {} as never, notify })
    await ran['tasks.alert']!({ kind: 'tasks.alert', userId: 'u1', payload: {} })
    await ran[HUB_NOTIFY_JOB]!({ kind: HUB_NOTIFY_JOB, userId: 'u2', payload: { notice: alert } })
    // A malformed queued notice is dropped, not retried.
    await ran[HUB_NOTIFY_JOB]!({ kind: HUB_NOTIFY_JOB, userId: 'u3', payload: { notice: {} } })
    expect(sent).toEqual([
      ['u1', alert],
      ['u2', alert],
    ])
  })

  it('queues a validated notice, deduped by kind and tag', async () => {
    const queries: unknown[][] = []
    const db = { query: async (_sql: string, params: unknown[]) => (queries.push(params), []) }
    await enqueueHubNotify(db as never, 'u1', alert)
    expect(queries[0]!.slice(0, 4)).toEqual([
      'u1',
      HUB_NOTIFY_JOB,
      { notice: alert },
      'hub-notify:u1:tasks.alert:t1',
    ])
    await expect(enqueueHubNotify(db as never, 'u1', { ...alert, deepLink: 'x' })).rejects.toThrow(
      /deepLink/,
    )
    expect(queries).toHaveLength(1)
  })
})
