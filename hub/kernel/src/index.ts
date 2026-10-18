/**
 * The module contract (ZACHHUB_PLAN.md §2.2). A module declares its first-party tables, an API
 * router mounted at /api/<name>, and worker job handlers; the apps assemble whatever
 * @zachhub/modules lists. Kinds are namespaced by module name so two modules can't collide.
 */
import {
  InvalidHubNoticeError,
  parseHubNotice,
  type EntityKind,
  type HubNotice,
} from '@zachhub/core'
import {
  EntityRegistry,
  HUB_ENTITIES,
  enqueueJob,
  type Db,
  type EntityTable,
} from '@zachhub/db/server'
import type { Hono } from 'hono'

export interface ModuleRouteContext {
  db(): Db
  entities: EntityRegistry
}

export interface ModuleJobContext {
  db: Db
  entities: EntityRegistry
  /**
   * The hub notifier (engine/notify.ts): pushes `notice` to the user's devices, honoring their
   * notification switch. Resolves to how many devices it reached (0 when push isn't set up).
   * Throws InvalidHubNoticeError on a malformed notice.
   */
  notify(userId: string, notice: HubNotice): Promise<number>
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

export const HUB_NOTIFY_JOB = 'hub.notify'

/**
 * Queues a notice for the worker to push, for API routes (which never send themselves).
 * Validated here so a bad notice fails the request, not a job. A tagged notice still waiting
 * in the queue absorbs a repeat with the same kind and tag.
 */
export async function enqueueHubNotify(db: Db, userId: string, notice: HubNotice) {
  const n = parseHubNotice(notice)
  await enqueueJob(db, {
    userId,
    kind: HUB_NOTIFY_JOB,
    payload: { notice: n },
    dedupeKey: n.tag ? `hub-notify:${userId}:${n.kind}:${n.tag}` : undefined,
  })
}

/** The hub's own entities ('hub.link') and queued notices. Always installed. */
export const hubModule: HubModule = {
  name: 'hub',
  entities: HUB_ENTITIES,
  jobs: (ctx) => ({
    async [HUB_NOTIFY_JOB](job) {
      let notice: HubNotice
      try {
        notice = parseHubNotice(job.payload.notice)
      } catch (err) {
        // Retrying can't fix a malformed notice; drop it.
        if (!(err instanceof InvalidHubNoticeError)) throw err
        console.error(JSON.stringify({ msg: 'bad hub notice', error: err.message }))
        return
      }
      await ctx.notify(job.userId, notice)
    },
  }),
}

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
