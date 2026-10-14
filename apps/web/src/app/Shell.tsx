import { useNavigate } from '@tanstack/react-router'
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Composer } from '../compose/Composer'
import { newDraft } from '../compose/draft'
import { useData } from '../data/DataProvider'
import { Inbox } from '../inbox/Inbox'
import { SearchView } from '../search/SearchView'
import { endInteraction } from '../lib/perf'
import { keymap, type CommandId } from '@zachmail/core'
import { canRun, useCommands } from '../lib/useCommands'
import { AppHeader } from './AppHeader'
import { CheatSheet } from './CheatSheet'
import { CommandPalette, type PaletteItem } from './CommandPalette'
import { SPLITS, type SplitId } from './splits'
import { UndoToast } from './UndoToast'

type Overlay = 'palette' | 'shortcuts' | null

export function Shell({ split }: { split: SplitId }) {
  const navigate = useNavigate()
  const { compose, accounts } = useData()
  useSyncExternalStore(compose.subscribe, compose.getVersion)
  const sheet = compose.sheet
  const [overlay, setOverlay] = useState<Overlay>(null)
  // Search replaces the list while open (design §3.5); null when not searching.
  const [search, setSearch] = useState<string | null>(null)
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

  const goSplit = (id: SplitId) => void navigate({ to: '/inbox/$split', params: { split: id } })
  const cycle = (dir: 1 | -1) => {
    const i = SPLITS.findIndex((s) => s.id === split)
    goSplit(SPLITS[(i + dir + SPLITS.length) % SPLITS.length]!.id)
  }

  useCommands({
    'nav.nextSplit': () => cycle(1),
    'nav.prevSplit': () => cycle(-1),
    'go.inbox': () => {
      setSearch(null)
      goSplit('important')
    },
    'nav.search': () => setSearch(''),
    'app.palette': () => open('palette'),
    'app.shortcuts': () => open('shortcuts'),
    'compose.new': () => {
      const first = accounts.keys().next().value
      if (first) compose.open(compose.resume(null) ?? newDraft(first))
    },
    ...(overlay ? { 'nav.back': () => setOverlay(null) } : {}),
  })

  const view = useMemo(() => ({ split }), [split])
  const extra = useMemo<PaletteItem[]>(
    () =>
      SPLITS.filter((s) => s.id !== split).map((s) => ({
        id: `split.${s.id}`,
        label: `Go to ${s.label}`,
        run: () => goSplit(s.id),
      })),
    // goSplit only closes over navigate, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [split],
  )

  return (
    <div className="shell">
      <AppHeader split={split} onPalette={() => open('palette')} />
      <main className="main">
        {search !== null ? (
          <SearchView initial={search} active={!overlay && !sheet} onExit={() => setSearch(null)} />
        ) : (
          <Inbox key={split} view={view} active={!overlay && !sheet} />
        )}
      </main>
      {sheet && <Composer key={sheet.id} initial={sheet} />}
      <UndoToast />
      {overlay === 'palette' && (
        <CommandPalette
          available={available}
          extra={extra}
          onSearch={(q) => setSearch(q)}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === 'shortcuts' && (
        <CheatSheet available={available} onClose={() => setOverlay(null)} />
      )}
    </div>
  )
}
