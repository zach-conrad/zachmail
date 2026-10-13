import { Link } from '@tanstack/react-router'
import { SPLITS, type SplitId } from './splits'
import { Kbd } from './Kbd'

export function AppHeader({ split, onPalette }: { split: SplitId; onPalette: () => void }) {
  return (
    <header className="app-header">
      <span className="brand">ZachMail</span>
      <nav className="splits" aria-label="Splits">
        {SPLITS.map((s) => (
          <Link
            key={s.id}
            to="/inbox/$split"
            params={{ split: s.id }}
            className="split-tab"
            aria-current={s.id === split ? 'page' : undefined}
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
