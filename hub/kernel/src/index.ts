/**
 * The module contract (ZACHHUB_PLAN.md §2.2). A module declares its first-party tables, an API
 * router mounted at /api/<name>, and worker job handlers; the apps assemble whatever
 * @zachhub/modules lists. Kinds are namespaced by module name so two modules can't collide.
 */
import type { EntityKind } from '@zachhub/core'
import { EntityRegistry, HUB_ENTITIES, type Db, type EntityTable } from '@zachhub/db/server'
import type { Hono } from 'hono'

export interface ModuleRouteContext {
  db(): Db
  entities: EntityRegistry
}

export interface ModuleJobContext {
  db: Db
  entities: EntityRegistry
}

export interface ModuleJob {
  kind: string
  userId: string
  payload: Record<string, unknown>
}

export type ModuleJobHandler = (job: ModuleJob) => Promise<void>

/** Routes see the signed-in user as `c.get('user')`, like every /api route. */
export type ModuleRouter = Hono<{ Variables: { user: { id: string } } }>

export interface HubModule {
  /** Lowercase; also the route prefix (/api/<name>) and the prefix of its entity and job kinds. */
  name: string
  entities?: EntityTable[]
  routes?: (ctx: ModuleRouteContext) => ModuleRouter
  jobs?: (ctx: ModuleJobContext) => Record<string, ModuleJobHandler>
}

/** The hub's own entities ('hub.link'). Always installed. */
export const hubModule: HubModule = { name: 'hub', entities: HUB_ENTITIES }

export interface InstalledModules {
  modules: HubModule[]
  entities: EntityRegistry
  /** Every module's job handlers, merged. */
  jobs(ctx: Omit<ModuleJobContext, 'entities'>): Record<string, ModuleJobHandler>
}

const NAME = /^[a-z][a-z0-9]*$/
const owns = (m: HubModule, kind: EntityKind | string) => kind.startsWith(`${m.name}.`)

/** Validates and assembles a module list; throws at startup on any clash. */
export function installModules(list: HubModule[]): InstalledModules {
  const modules = list.some((m) => m.name === 'hub') ? list : [hubModule, ...list]
  const names = new Set<string>()
  for (const m of modules) {
    if (!NAME.test(m.name)) throw new Error(`Bad module name ${m.name}`)
    if (names.has(m.name)) throw new Error(`Module ${m.name} installed twice`)
    names.add(m.name)
    for (const t of m.entities ?? [])
      if (!owns(m, t.kind)) throw new Error(`${m.name} declares foreign entity ${t.kind}`)
  }
  const entities = new EntityRegistry(modules.flatMap((m) => m.entities ?? []))
  return {
    modules,
    entities,
    jobs(ctx) {
      const all: Record<string, ModuleJobHandler> = {}
      for (const m of modules)
        for (const [kind, handler] of Object.entries(m.jobs?.({ ...ctx, entities }) ?? {})) {
          if (!owns(m, kind)) throw new Error(`${m.name} declares foreign job ${kind}`)
          all[kind] = handler
        }
      return all
    },
  }
}
