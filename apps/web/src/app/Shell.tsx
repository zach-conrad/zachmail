import { useNavigate } from '@tanstack/react-router'
import { useLayoutEffect, useState } from 'react'
import { Inbox } from '../inbox/Inbox'
import { endInteraction } from '../lib/perf'
import { useCommands } from '../lib/useCommands'
import { AppHeader } from './AppHeader'
import { SPLITS, type SplitId } from './splits'

export function Shell({ split }: { split: SplitId }) {
  const navigate = useNavigate()
  const [paletteOpen, setPaletteOpen] = useState(false)

  useLayoutEffect(() => {
    if (paletteOpen) endInteraction('app.palette')
  }, [paletteOpen])

  const cycle = (dir: 1 | -1) => {
    const i = SPLITS.findIndex((s) => s.id === split)
    const next = SPLITS[(i + dir + SPLITS.length) % SPLITS.length]!
    void navigate({ to: '/inbox/$split', params: { split: next.id } })
  }

  useCommands({
    'nav.nextSplit': () => cycle(1),
    'nav.prevSplit': () => cycle(-1),
    'go.inbox': () => void navigate({ to: '/inbox/$split', params: { split: 'important' } }),
    'app.palette': () => setPaletteOpen((o) => !o),
    ...(paletteOpen ? { 'nav.back': () => setPaletteOpen(false) } : {}),
  })

  return (
    <div className="shell">
      <AppHeader split={split} onPalette={() => setPaletteOpen(true)} />
      <main className="main">
        <Inbox key={split} split={split} active={!paletteOpen} />
      </main>
      {paletteOpen && (
        <div className="palette-backdrop" onClick={() => setPaletteOpen(false)}>
          <div
            className="palette"
            role="dialog"
            aria-label="Command palette"
            onClick={(e) => e.stopPropagation()}
          >
            <input autoFocus className="palette-input" placeholder="Type a command or search…" />
          </div>
        </div>
      )}
    </div>
  )
}
