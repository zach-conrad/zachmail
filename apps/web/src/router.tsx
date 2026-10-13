import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { Shell } from './app/Shell'
import { isSplit } from './app/splits'
import { LoginScreen } from './auth/LoginScreen'
import { useAuth } from './auth/session'

function Root() {
  const auth = useAuth()
  if (auth.status === 'loading') return null
  if (auth.status === 'signedOut') return <LoginScreen />
  return <Outlet />
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
  beforeLoad: ({ params }) => {
    if (!isSplit(params.split))
      throw redirect({ to: '/inbox/$split', params: { split: 'important' } })
  },
  component: function InboxRoute() {
    const { split } = inboxRoute.useParams()
    return <Shell split={isSplit(split) ? split : 'important'} />
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
