import { accountColor, tokens } from '@zachmail/tokens'
import type { ThreadListItem } from '@zachmail/local-store'
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react'
import { useData } from '../data/DataProvider'
import type { ListModel } from '../data/listModel'
import { senderLabel, shortTime } from '../lib/format'

export const ROW = tokens.row.compact
const OVERSCAN = 8

interface Props {
  model: ListModel
  focus: number
  onActivate: (index: number, e: MouseEvent) => void
}

/** Virtualized thread list: fixed-height rows, only what is on screen plus overscan. */
export function ThreadList({ model, focus, onActivate }: Props) {
  useSyncExternalStore(model.subscribe, model.getVersion)
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(800)
  const count = model.count ?? 0

  useLayoutEffect(() => {
    const el = ref.current!
    setHeight(el.clientHeight)
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep the focused row on screen; jump, never animate (design §5.5).
  useLayoutEffect(() => {
    const el = ref.current!
    const top = focus * ROW
    let next = el.scrollTop
    if (top < next) next = top
    else if (top + ROW > next + el.clientHeight) next = top + ROW - el.clientHeight
    if (next !== el.scrollTop) {
      el.scrollTop = next
      setScrollTop(next)
    }
  }, [focus])

  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN)
  const end = Math.min(count, Math.ceil((scrollTop + height) / ROW) + OVERSCAN)
  useEffect(() => model.ensure(start, end), [model, start, end, count])

  const rows = []
  for (let i = start; i < end; i++) {
    rows.push(
      <Row key={i} index={i} item={model.get(i)} focused={i === focus} onActivate={onActivate} />,
    )
  }

  return (
    <div
      ref={ref}
      className="thread-list"
      role="listbox"
      aria-label="Threads"
      aria-activedescendant={model.get(focus) ? `row-${model.get(focus)!.id}` : undefined}
      tabIndex={-1}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div className="thread-list-inner" style={{ height: count * ROW }}>
        {rows}
      </div>
    </div>
  )
}

const Row = memo(function Row({
  index,
  item,
  focused,
  onActivate,
}: {
  index: number
  item: ThreadListItem | undefined
  focused: boolean
  onActivate: Props['onActivate']
}) {
  const { accounts, ownEmails } = useData()
  const style = { transform: `translateY(${index * ROW}px)` }
  if (!item) return <div className="row row-placeholder" style={style} />
  const account = accounts.get(item.accountId)
  const sender = senderLabel(item.participants, ownEmails)
  const when = shortTime(item.lastMessageAt)
  return (
    <div
      id={`row-${item.id}`}
      role="option"
      aria-selected={focused}
      aria-label={[
        item.unread ? 'Unread' : '',
        sender,
        item.subject,
        when,
        account ? `${account.shortName ?? account.email} account` : '',
      ]
        .filter(Boolean)
        .join('. ')}
      className="row"
      data-unread={item.unread || undefined}
      data-focused={focused || undefined}
      style={style}
      onClick={(e) => onActivate(index, e)}
    >
      <span
        className="dot"
        style={{ background: account ? accountColor(account.color) : 'transparent' }}
      />
      <span className="row-sender">
        {sender}
        {item.messageCount > 1 && <span className="row-count">{item.messageCount}</span>}
      </span>
      <span className="row-text">
        <span className="row-subject">{item.subject || '(no subject)'}</span>
        <span className="row-snippet">{item.snippet}</span>
      </span>
      <span className="row-icons" aria-hidden>
        {item.hasAttachments && '📎'}
        {item.starred && '★'}
      </span>
      <time className="row-time" dateTime={new Date(item.lastMessageAt).toISOString()}>
        {when}
      </time>
    </div>
  )
})
