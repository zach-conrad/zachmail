import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { lazy, Suspense, useMemo } from 'react'
import { Shell } from './app/Shell'
import { isSplitKey } from './app/splits'
import { LoginScreen } from './auth/LoginScreen'
import { useAuth } from './auth/session'
import { DataProvider, useData } from './data/DataProvider'
import { tasksBackend } from './data/tasksBackend'
import { demoMode } from './lib/supabase'

// The tasks module is its own chunk: mail's initial bundle never pays for it (plan §7).
const TasksScreen = lazy(() => import('@zachhub/tasks-web'))

function Root() {
  const auth = useAuth()
  if (auth.status === 'loading') return null
  if (auth.status === 'signedOut') return <LoginScreen />
  return (
    <DataProvider>
      <Outlet />
    </DataProvider>
  )
}

const rootRoute = createRootRoute({ component: Root })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/inbox/$split', params: { split: 'important' } })
  },
})

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox/$split',
  // `thread` opens a conversation on arrival (a notification click in a fresh window).
  validateSearch: (s: Record<string, unknown>): { thread?: string } =>
    typeof s.thread === 'string' ? { thread: s.thread } : {},
  beforeLoad: ({ params }) => {
    if (!isSplitKey(params.split))
      throw redirect({ to: '/inbox/$split', params: { split: 'important' } })
  },
  component: function InboxRoute() {
    const { split } = inboxRoute.useParams()
    const { thread } = inboxRoute.useSearch()
    return <Shell split={isSplitKey(split) ? split : 'important'} openThread={thread ?? null} />
  },
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
  component: function TasksRoute() {
    const { view } = tasksRoute.useParams()
    const navigate = tasksRoute.useNavigate()
    const { client } = useData()
    const backend = useMemo(() => tasksBackend(client), [client])
    return (
      <Suspense fallback={null}>
        <TasksScreen
          view={view}
          demo={demoMode && Number(new URLSearchParams(location.search).get('tasks') ?? 60)}
          backend={backend}
          onNavigate={(to) => void navigate({ to: '/tasks/$view', params: { view: to } })}
          onGoMail={() => void navigate({ to: '/inbox/$split', params: { split: 'important' } })}
        />
      </Suspense>
    )
  },
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, inboxRoute, tasksIndexRoute, tasksRoute]),
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
