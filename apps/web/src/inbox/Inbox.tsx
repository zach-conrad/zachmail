import type { CommandId, MailOp, SimpleOpKind, SplitKey } from '@zachmail/core'
import type { ThreadDetail, ThreadListItem } from '@zachmail/local-store'
import { replyDraft } from '../compose/draft'
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
import { dueTime } from '../lib/format'
import { useCommands } from '../lib/useCommands'
import { InboxZero } from './InboxZero'
import { LabelPicker, type LabelChoice } from './LabelPicker'
import { SnoozePicker } from './SnoozePicker'
import { ThreadList } from './ThreadList'
import { ThreadView } from './ThreadView'

const PREFETCH_TOP = 50

const TIMED: CommandId[] = [
  'thread.done',
  'thread.undone',
  'thread.trash',
  'thread.spam',
  'thread.mute',
  'thread.snooze',
  'thread.star',
  'thread.toggleRead',
  'undo',
]

const describe = (verb: string, rows: ThreadListItem[]) =>
  rows.length === 1
    ? `${verb} · “${rows[0]!.subject || '(no subject)'}”`
    : `${verb} · ${rows.length} conversations`

/** One split (or Reminders): the virtualized list, the reading pane and their keyboard model. */
export function Inbox({ split, active }: { split: SplitKey; active: boolean }) {
  const { client, threads, triage, compose, ownEmails } = useData()
  const model = useMemo(() => new ListModel(client, { split }), [client, split])
  const version = useSyncExternalStore(model.subscribe, model.getVersion)
  const count = model.count

  const [focus, setFocus] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const focusId = model.get(focus)?.id ?? null
  // The thread the user meant, so focus follows it when new mail shifts the list.
  const wanted = useRef<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [picker, setPicker] = useState<'label' | 'move' | 'snooze' | null>(null)

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
        } else if (e.type === 'bodies') {
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
    for (const id of TIMED) endInteraction(id)
  }, [version, selected])
  useLayoutEffect(() => {
    if (!openId) endInteraction('nav.back')
  }, [openId])

  // Opening an unread thread marks it read (no toast, not on the undo stack).
  useEffect(() => {
    const row = model.get(focus)
    if (openId && row?.id === openId && row.unread)
      triage.run({ kind: 'read', threadIds: [openId] }, 'Mark read', model, true)
    // Only on open: focus and model are read as of then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId])

  const move = (to: number) => {
    const max = (count ?? 1) - 1
    const i = Math.max(0, Math.min(max, to))
    const id = model.get(i)?.id ?? null
    wanted.current = id
    setFocus(i)
    if (openId && id) setOpenId(id)
  }

  /** Selected threads, else the focused one: what a triage command acts on. */
  const targets = (): ThreadListItem[] => {
    if (selected.size) {
      const rows: ThreadListItem[] = []
      for (let i = 0; i < (count ?? 0) && rows.length < selected.size; i++) {
        const r = model.get(i)
        if (r && selected.has(r.id)) rows.push(r)
      }
      return rows
    }
    const r = model.get(focus)
    return r ? [r] : []
  }

  /** Runs an op on the targets; focus lands on the next thread, like Superhuman. */
  const act = (op: MailOp, label: string) => {
    const removed = triage.run(op, label, model)
    setSelected(new Set())
    if (!removed.length) return
    const before = removed.filter((r) => r.index < focus).length
    const left = model.count ?? 0
    const i = Math.max(0, Math.min(left - 1, focus - before))
    const next = model.get(i)?.id ?? null
    wanted.current = next
    setFocus(i)
    if (openId && removed.some((r) => r.item.id === openId)) setOpenId(next)
  }

  const simple = (kind: SimpleOpKind, verb: string) => {
    const rows = targets()
    if (rows.length) act({ kind, threadIds: rows.map((r) => r.id) }, describe(verb, rows))
  }

  const toggle = (flag: 'unread' | 'starred') => {
    const rows = targets()
    if (!rows.length) return
    const on = !rows[0]![flag]
    if (flag === 'unread') simple(on ? 'unread' : 'read', on ? 'Marked unread' : 'Marked read')
    else simple(on ? 'star' : 'unstar', on ? 'Starred' : 'Unstarred')
  }

  // Labels are per account; the picker offers names and maps each to every account's folder.
  const choices = (rows: ThreadListItem[]): LabelChoice[] => {
    const accounts = new Set(rows.map((r) => r.accountId))
    const names = new Map<string, string[]>()
    for (const f of triage.folders)
      if (f.kind === 'custom' && accounts.has(f.accountId))
        names.set(f.name, [...(names.get(f.name) ?? []), f.id])
    return [...names]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, ids]) => ({
        name,
        on: rows.every((r) => r.folderIds.some((f) => ids.includes(f))),
      }))
  }

  const applyLabel = (mode: 'label' | 'move', name: string) => {
    const rows = targets()
    const byAccount = new Map<string, ThreadListItem[]>()
    for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r])
    const on = mode === 'label' && choices(rows).find((c) => c.name === name)?.on
    for (const [accountId, group] of byAccount) {
      const folder = triage.folders.find(
        (f) => f.accountId === accountId && f.kind === 'custom' && f.name === name,
      )
      if (!folder) continue
      const inbox = triage.folders.find((f) => f.accountId === accountId && f.kind === 'inbox')
      const threadIds = group.map((r) => r.id)
      const op: MailOp =
        mode === 'move'
          ? { kind: 'label', threadIds, add: [folder.id], remove: inbox ? [inbox.id] : [] }
          : on
            ? { kind: 'label', threadIds, add: [], remove: [folder.id] }
            : { kind: 'label', threadIds, add: [folder.id], remove: [] }
      const verb = mode === 'move' ? `Moved to ${name}` : on ? `Removed ${name}` : `Labeled ${name}`
      act(op, describe(verb, group))
    }
  }

  /** h: archive now, back in the inbox (unread) at `until`. */
  const snooze = (until: number) => {
    const rows = targets()
    if (rows.length)
      act(
        { kind: 'snooze', threadIds: rows.map((r) => r.id), until },
        describe(`Snoozed until ${dueTime(until)}`, rows),
      )
  }

  /** r / a / f: open the thread (if needed) with a reply or forward under it. */
  const reply = (kind: 'reply' | 'replyAll' | 'forward') => {
    const id = openId ?? focusId
    if (!id) return
    if (!openId) setOpenId(id)
    const resumed = compose.resume(id)
    if (resumed && resumed.kind === kind) return compose.open(resumed)
    const start = (detail: ThreadDetail) => {
      const last = detail.messages[detail.messages.length - 1]
      const body = last ? detail.bodies[last.id]?.html : undefined
      compose.open(replyDraft(detail, kind, ownEmails, body))
    }
    const warm = threads.get(id)
    if (warm) start(warm)
    else void threads.load(id).then((d) => d && start(d))
  }

  const select = (i: number, extend: boolean) => {
    const id = model.get(focus)?.id
    if (!id) return
    const next = new Set(selected)
    if (extend) next.add(id)
    else if (!next.delete(id)) next.add(id)
    if (extend) {
      const to = model.get(i)?.id
      if (to) next.add(to)
      move(i)
    }
    setSelected(next)
  }

  useCommands(
    active && !picker
      ? {
          'nav.next': () => move(focus + 1),
          'nav.prev': () => move(focus - 1),
          'nav.open': () => {
            if (focusId) setOpenId(focusId)
          },
          'nav.back': () => (selected.size ? setSelected(new Set()) : setOpenId(null)),
          'thread.done': () => simple('archive', 'Done'),
          'thread.undone': () => simple('inbox', 'Moved to Inbox'),
          'thread.trash': () => simple('trash', 'Trashed'),
          'thread.spam': () => simple('spam', 'Marked as spam'),
          'thread.mute': () => simple('mute', 'Muted'),
          'thread.star': () => toggle('starred'),
          'thread.toggleRead': () => toggle('unread'),
          'thread.label': () => targets().length && setPicker('label'),
          'thread.move': () => targets().length && setPicker('move'),
          'thread.snooze': () => targets().length && setPicker('snooze'),
          'compose.reply': () => reply('reply'),
          'compose.replyAll': () => reply('replyAll'),
          'compose.forward': () => reply('forward'),
          'select.toggle': () => select(focus, false),
          'select.extendDown': () => select(focus + 1, true),
          'select.extendUp': () => select(focus - 1, true),
          undo: () => {
            const d = triage.undo()
            if (!d?.removed.length) return
            // The rows came back where they were; focus the first of them.
            const first = Math.min(...d.removed.map((r) => r.index))
            wanted.current = d.removed.find((r) => r.index === first)!.item.id
            setFocus(first)
          },
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

  const pickerEl =
    picker === 'snooze' ? (
      <SnoozePicker title="Remind me" onPick={snooze} onClose={() => setPicker(null)} />
    ) : (
      picker && (
        <LabelPicker
          mode={picker}
          choices={choices(targets())}
          onPick={(name) => applyLabel(picker, name)}
          onClose={() => setPicker(null)}
        />
      )
    )

  if (count === 0)
    return split === 'reminders' ? (
      <section className="zero" aria-live="polite">
        <p className="muted">Nothing snoozed. Press H on a thread to bring it back later.</p>
      </section>
    ) : (
      <InboxZero hero={split === 'important'} />
    )

  return (
    <div className="panes" data-open={openId ? '' : undefined}>
      <div className="list-pane">
        <ThreadList model={model} focus={focus} selected={selected} onActivate={onActivate} />
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
      {pickerEl}
    </div>
  )
}
