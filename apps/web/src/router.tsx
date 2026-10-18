import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { HubShell } from './app/HubShell'
import { isView } from './app/splits'
import { LoginScreen } from './auth/LoginScreen'
import { useAuth } from './auth/session'
import { DataProvider } from './data/DataProvider'
import { DocsRoute, MailRoute, TasksRoute, TodayRoute } from './hub/modules'

function Root() {
  const auth = useAuth()
  if (auth.status === 'loading') return null
  if (auth.status === 'signedOut') return <LoginScreen />
  return (
    <DataProvider>
      <HubShell>
        <Outlet />
      </HubShell>
    </DataProvider>
  )
}

const rootRoute = createRootRoute({ component: Root })

// ZachHub opens on Today on every platform (design H7).
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/today' })
  },
})

const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/today',
  component: TodayRoute,
})

export interface MailSearch {
  /** Opens a conversation on arrival (a notification click, Today, ⌘K). */
  thread?: string
  /** Opens mail search with this query (⌘K's "Search mail for …"). */
  q?: string
}

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox/$split',
  validateSearch: (s: Record<string, unknown>): MailSearch => ({
    ...(typeof s.thread === 'string' ? { thread: s.thread } : {}),
    ...(typeof s.q === 'string' ? { q: s.q } : {}),
  }),
  beforeLoad: ({ params }) => {
    if (!isView(params.split))
      throw redirect({ to: '/inbox/$split', params: { split: 'important' } })
  },
  component: MailRoute,
})

const tasksIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks',
  beforeLoad: () => {
    throw redirect({ to: '/tasks/$view', params: { view: 'today' } })
  },
})

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$view',
  component: TasksRoute,
})

const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/docs',
  component: DocsRoute,
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    todayRoute,
    inboxRoute,
    tasksIndexRoute,
    tasksRoute,
    docsRoute,
  ]),
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
