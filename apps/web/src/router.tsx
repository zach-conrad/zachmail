import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { Shell } from './app/Shell'
import { isView } from './app/splits'
import { LoginScreen } from './auth/LoginScreen'
import { useAuth } from './auth/session'
import { DataProvider } from './data/DataProvider'

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
    if (!isView(params.split))
      throw redirect({ to: '/inbox/$split', params: { split: 'important' } })
  },
  component: function InboxRoute() {
    const { split } = inboxRoute.useParams()
    const { thread } = inboxRoute.useSearch()
    return <Shell split={isView(split) ? split : 'important'} openThread={thread ?? null} />
  },
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, inboxRoute]),
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
