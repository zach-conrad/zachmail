import { describe, expect, it } from 'vitest'
import { installModules, type HubModule } from './index'

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
    const ok = installModules([{ name: 'tasks', jobs: () => ({ 'tasks.remind': noop }) }])
    expect(Object.keys(ok.jobs({ db: {} as never }))).toEqual(['tasks.remind'])
    const bad = installModules([{ name: 'tasks', jobs: () => ({ 'mail.sync': noop }) }])
    expect(() => bad.jobs({ db: {} as never })).toThrow(/foreign job/)
  })
})
