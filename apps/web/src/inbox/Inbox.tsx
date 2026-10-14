import type { SplitId } from '@zachmail/core'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react'
import { useData } from '../data/DataProvider'
import { ListModel } from '../data/listModel'
import { beginInteraction, endInteraction, markOnce } from '../lib/perf'
import { useCommands } from '../lib/useCommands'
import { InboxZero } from './InboxZero'
import { ThreadList } from './ThreadList'
import { ThreadView } from './ThreadView'

const PREFETCH_TOP = 50

/** One split: the virtualized list, the reading pane and their keyboard model. */
export function Inbox({ split, active }: { split: SplitId; active: boolean }) {
  const { client, threads } = useData()
  const model = useMemo(() => new ListModel(client, { split }), [client, split])
  const version = useSyncExternalStore(model.subscribe, model.getVersion)
  const count = model.count

  const [focus, setFocus] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const focusId = model.get(focus)?.id ?? null
  // The thread the user meant, so focus follows it when new mail shifts the list.
  const wanted = useRef<string | null>(null)

  // Threads worth keeping warm: the open one, the focused one and its neighbours.
  const keepKey = [openId, focusId, model.get(focus - 1)?.id, model.get(focus + 1)?.id]
    .filter(Boolean)
    .join(' ')
  const keep = useRef<string[]>([])
  useLayoutEffect(() => {
    keep.current = keepKey ? keepKey.split(' ') : []
  }, [keepKey])

  useEffect(
    () =>
      client.subscribe((e) => {
        if (e.type === 'changed') {
          void model.refresh()
          threads.invalidate(null, keep.current)
        } else {
          threads.invalidate(e.threadIds, e.threadIds)
        }
      }),
    [client, model, threads],
  )

  // Re-find the wanted thread after a refresh; if it left this view, focus stays put
  // (which lands on the next thread, like auto-advance).
  useEffect(() => {
    const id = wanted.current
    if (!id || model.get(focus)?.id === id) return
    let live = true
    void client.api.indexOfThread(model.query, id).then((i) => {
      if (live && i >= 0) setFocus(i)
    })
    return () => {
      live = false
    }
  }, [client, model, version, focus])

  // Body prefetch: the top of the inbox once, then the focused thread and its neighbours.
  const primed = useRef(false)
  useEffect(() => {
    if (primed.current || !model.get(0)) return
    primed.current = true
    markOnce('inbox-ready')
    const ids = Array.from({ length: PREFETCH_TOP }, (_, i) => model.get(i)?.id).filter(
      (x): x is string => !!x,
    )
    void client.api.ensureBodies(ids)
  }, [client, model, version])
  useEffect(() => {
    if (keepKey) threads.prefetch(keepKey.split(' '))
  }, [threads, keepKey])

  useLayoutEffect(() => {
    endInteraction('nav.next')
    endInteraction('nav.prev')
  }, [focus])
  useLayoutEffect(() => {
    if (!openId) endInteraction('nav.back')
  }, [openId])

  const move = (to: number) => {
    const max = (count ?? 1) - 1
    const i = Math.max(0, Math.min(max, to))
    const id = model.get(i)?.id ?? null
    wanted.current = id
    setFocus(i)
    if (openId && id) setOpenId(id)
  }

  useCommands(
    active
      ? {
          'nav.next': () => move(focus + 1),
          'nav.prev': () => move(focus - 1),
          'nav.open': () => {
            if (focusId) setOpenId(focusId)
          },
          'nav.back': () => setOpenId(null),
        }
      : {},
  )

  const onActivate = useCallback(
    (i: number, e: MouseEvent) => {
      beginInteraction('nav.open', e.timeStamp)
      const id = model.get(i)?.id ?? null
      wanted.current = id
      setFocus(i)
      setOpenId(id)
    },
    [model],
  )

  if (count === 0) return <InboxZero hero={split === 'important'} />

  return (
    <div className="panes" data-open={openId ? '' : undefined}>
      <div className="list-pane">
        <ThreadList model={model} focus={focus} onActivate={onActivate} />
      </div>
      <div className="reader-pane">
        {openId ? (
          <ThreadView key={openId} threadId={openId} active={active} />
        ) : (
          <div className="reader-empty muted">
            {count === null ? '' : `${count.toLocaleString()} conversations`}
          </div>
        )}
      </div>
    </div>
  )
}
