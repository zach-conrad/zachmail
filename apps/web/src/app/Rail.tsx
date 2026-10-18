import type { AccountRow, ModuleId } from '@zachhub/core'
import { accountColor } from '@zachhub/tokens'
import { Link } from '@tanstack/react-router'
import { useEffect, useState, type ReactNode } from 'react'
import type { DataClient } from '../data/client'
import { lastMailSplit, modules } from '../hub/modules'

const ICONS: Record<ModuleId, ReactNode> = {
  today: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="3" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  tasks: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" />
    </>
  ),
  docs: (
    <>
      <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="rail-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

const IMPORTANT = { split: 'important' } as const

/** Important unread, for the Mail badge. First read waits for idle, then follows changes. */
function useMailBadge(client: DataClient): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let live = true
    const read = () =>
      void client.api.unread(IMPORTANT, Date.now(), 0).then(
        (r) => live && setCount(r.count),
        () => {},
      )
    const idle = window.requestIdleCallback?.(read, { timeout: 2000 })
    const timer = idle === undefined ? setTimeout(read, 500) : undefined
    const off = client.subscribe((e) => e.type === 'changed' && read())
    return () => {
      live = false
      if (idle !== undefined) window.cancelIdleCallback(idle)
      clearTimeout(timer)
      off()
    }
  }, [client])
  return count
}

/**
 * The module rail (ZachHub design H1): a floating glass column, always labeled, that never
 * scrolls (so its blur region is fixed). Account dots and Settings sit at the bottom.
 */
export function Rail({
  current,
  client,
  accounts,
  onSettings,
}: {
  current: ModuleId
  client: DataClient
  accounts: readonly AccountRow[]
  onSettings: () => void
}) {
  const mailBadge = useMailBadge(client)
  const badges: Partial<Record<ModuleId, number>> = { mail: mailBadge }
  return (
    <nav className="rail" aria-label="ZachHub">
      <div className="rail-modules">
        {modules.map((m) => {
          const badge = badges[m.id] ?? 0
          const content = (
            <>
              <span className="rail-glyph">
                <Icon>{ICONS[m.id]}</Icon>
                {badge > 0 && (
                  <span className="rail-badge" aria-label={`${badge} unread`}>
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </span>
              <span className="rail-label">{m.label}</span>
            </>
          )
          const props = {
            className: 'rail-item',
            'aria-current': m.id === current ? ('page' as const) : undefined,
          }
          return m.id === 'mail' ? (
            <Link key={m.id} {...props} to="/inbox/$split" params={{ split: lastMailSplit() }}>
              {content}
            </Link>
          ) : (
            <Link key={m.id} {...props} to={`/${m.id}` as '/today' | '/tasks' | '/docs'}>
              {content}
            </Link>
          )
        })}
      </div>
      <div className="rail-foot">
        {accounts.length > 0 && (
          <div className="rail-accounts">
            {accounts.map((a) => (
              <span
                key={a.id}
                className="dot"
                title={a.email}
                style={{ background: accountColor(a.color) }}
              />
            ))}
          </div>
        )}
        <button className="rail-item" onClick={onSettings} aria-label="Settings">
          <span className="rail-glyph">
            <Icon>
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
            </Icon>
          </span>
        </button>
      </div>
    </nav>
  )
}
