import { keymap, type CommandId } from '@zachhub/core'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useData } from '../data/DataProvider'
import { lastMailSplit, moduleOf, preloadModulesOnIdle } from '../hub/modules'
import { endInteraction } from '../lib/perf'
import { canRun, useCommands } from '../lib/useCommands'
import { mailPaletteSource } from '../mail/paletteSource'
import { warmMailAfterSync } from '../mail/warm'
import { usePushBridge } from '../notifications/usePushBridge'
import { CheatSheet } from './CheatSheet'
import { CommandPalette } from './CommandPalette'
import { Rail } from './Rail'

type Overlay = 'palette' | 'settings' | 'shortcuts' | null

interface Hub {
  /** A hub overlay (⌘K, `?`) is open: modules underneath stop taking keys. */
  overlayOpen: boolean
}

const HubContext = createContext<Hub>({ overlayOpen: false })
export const useHub = () => useContext(HubContext)

/**
 * ZachHub's frame on web and macOS: the module rail, the open module, and what works in every
 * module (`G H/M/T/D`, ⌘K, `?`, notification clicks).
 */
export function HubShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const current = moduleOf(pathname)
  const { client, accounts, ownEmails } = useData()
  const [overlay, setOverlay] = useState<Overlay>(null)
  // What the views underneath can run, captured before the overlay deactivates them.
  const [available, setAvailable] = useState<CommandId[]>([])
  const open = (o: Exclude<Overlay, null>) => {
    if (overlay === o) return setOverlay(null)
    setAvailable(keymap.map((b) => b.id).filter(canRun))
    setOverlay(o)
  }

  useLayoutEffect(() => {
    if (overlay === 'palette') endInteraction('app.palette')
  }, [overlay])
  useEffect(preloadModulesOnIdle, [])
  useEffect(() => warmMailAfterSync(client), [client])

  const toMail = (search: { thread?: string; q?: string } = {}, split = lastMailSplit()) =>
    void navigate({ to: '/inbox/$split', params: { split }, search })
  usePushBridge(client, (threadId, split) => {
    setOverlay(null)
    toMail({ thread: threadId }, split)
  })

  useCommands({
    'go.today': () => void navigate({ to: '/today' }),
    // Already in Mail: stay on the split you're on.
    'go.mail': () => current !== 'mail' && toMail(),
    'go.tasks': () => void navigate({ to: '/tasks' }),
    'go.docs': () => void navigate({ to: '/docs' }),
    'app.palette': () => open('palette'),
    'app.shortcuts': () => open('shortcuts'),
    ...(overlay ? { 'nav.back': () => setOverlay(null) } : {}),
  })

  const sources = useMemo(
    () => [
      mailPaletteSource(client, ownEmails, {
        thread: (id) => toMail({ thread: id }),
        search: (q) => toMail({ q }),
      }),
    ],
    // toMail only closes over navigate, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, ownEmails],
  )
  const hub = useMemo(() => ({ overlayOpen: overlay !== null }), [overlay])

  return (
    <HubContext.Provider value={hub}>
      <div className="hub">
        <Rail
          current={current}
          client={client}
          accounts={[...accounts.values()]}
          onSettings={() => open('settings')}
        />
        <div className="hub-main">{children}</div>
        {(overlay === 'palette' || overlay === 'settings') && (
          <CommandPalette
            available={available}
            sources={sources}
            only={overlay === 'settings' ? 'app' : undefined}
            onClose={() => setOverlay(null)}
          />
        )}
        {overlay === 'shortcuts' && (
          <CheatSheet available={available} onClose={() => setOverlay(null)} />
        )}
      </div>
    </HubContext.Provider>
  )
}
