import type { CommandId, ModuleId, SplitKey } from '@zachhub/core'
import { lazyRouteComponent } from '@tanstack/react-router'

// Each import() here is one module's route chunk, with its own size-limit entry. Nothing in a
// module runs at shell startup; the shell only knows these rows (ZACHHUB_PLAN.md §8).
export const TodayRoute = lazyRouteComponent(() => import('../today/TodayModule'), 'TodayModule')
export const MailRoute = lazyRouteComponent(() => import('../mail/MailModule'), 'MailModule')
export const TasksRoute = lazyRouteComponent(() => import('../tasks/TasksModule'), 'TasksModule')
export const DocsRoute = lazyRouteComponent(() => import('../docs/DocsModule'), 'DocsModule')

export interface HubModule {
  id: ModuleId
  label: string
  go: CommandId
  preload: () => Promise<unknown>
}

export const modules: readonly HubModule[] = [
  { id: 'today', label: 'Today', go: 'go.today', preload: async () => TodayRoute.preload?.() },
  { id: 'mail', label: 'Mail', go: 'go.mail', preload: async () => MailRoute.preload?.() },
  { id: 'tasks', label: 'Tasks', go: 'go.tasks', preload: async () => TasksRoute.preload?.() },
  { id: 'docs', label: 'Docs', go: 'go.docs', preload: async () => DocsRoute.preload?.() },
]

/** Which module a path belongs to. */
export function moduleOf(pathname: string): ModuleId {
  if (pathname.startsWith('/inbox')) return 'mail'
  if (pathname.startsWith('/tasks')) return 'tasks'
  if (pathname.startsWith('/docs')) return 'docs'
  return 'today'
}

// Going back to Mail lands on the split you left it on.
let lastSplit: SplitKey = 'important'
export const lastMailSplit = () => lastSplit
export const rememberMailSplit = (split: SplitKey) => void (lastSplit = split)

/** Warms every module chunk once the browser is idle after first paint. */
export function preloadModulesOnIdle(): () => void {
  const run = () => modules.forEach((m) => void m.preload().catch(() => {}))
  const idle = window.requestIdleCallback?.(run, { timeout: 3000 })
  const timer = idle === undefined ? setTimeout(run, 1500) : undefined
  return () => {
    if (idle !== undefined) window.cancelIdleCallback(idle)
    clearTimeout(timer)
  }
}
