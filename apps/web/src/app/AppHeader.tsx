import type { SplitKey, SplitTab } from '@zachhub/core'
import { Link } from '@tanstack/react-router'
import { Kbd } from './Kbd'

export function AppHeader({
  split,
  tabs,
  onPalette,
}: {
  split: SplitKey
  tabs: readonly SplitTab[]
  onPalette: () => void
}) {
  return (
    <header className="app-header">
      <nav className="splits" aria-label="Splits">
        {tabs.map((s) => (
          <Link
            key={s.key}
            to="/inbox/$split"
            params={{ split: s.key }}
            className="split-tab"
            aria-current={s.key === split ? 'page' : undefined}
          >
            {s.label}
          </Link>
        ))}
      </nav>
      <div className="header-right">
        <button className="palette-hint" onClick={onPalette} aria-label="Command palette">
          Search or run a command <Kbd keys="mod+k" />
        </button>
        <span className="scope-pill" title="Account scope">
          All accounts
        </span>
      </div>
    </header>
  )
}
