import { useNavigate } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Composer } from '../compose/Composer'
import { newDraft } from '../compose/draft'
import { Inbox } from '../inbox/Inbox'
import { endInteraction } from '../lib/perf'
import { keymap, splitTabs, type CommandId, type FolderRow, type SplitKey } from '@zachmail/core'
import { useData } from '../data/DataProvider'
import { SplitRulesEditor } from '../splits/SplitRulesEditor'
import { canRun, useCommands } from '../lib/useCommands'
import { AppHeader } from './AppHeader'
import { CheatSheet } from './CheatSheet'
import { CommandPalette, type PaletteItem } from './CommandPalette'
import { UndoToast } from './UndoToast'

type Overlay = 'palette' | 'shortcuts' | 'rules' | null

export function Shell({ split }: { split: SplitKey }) {
  const navigate = useNavigate()
  const { compose, accounts, client, splitRules, editSplitRule } = useData()
  useSyncExternalStore(compose.subscribe, compose.getVersion)
  const sheet = compose.sheet
  const tabs = useMemo(() => splitTabs(splitRules ?? []), [splitRules])
  const [folders, setFolders] = useState<FolderRow[]>([])
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

  const goSplit = (id: SplitKey) => void navigate({ to: '/inbox/$split', params: { split: id } })
  const cycle = (dir: 1 | -1) => {
    const i = tabs.findIndex((s) => s.key === split)
    goSplit(tabs[(i + dir + tabs.length) % tabs.length]!.key)
  }

  // A custom split whose rule was deleted (here or on another device) falls back to Important.
  const known = splitRules === null || tabs.some((t) => t.key === split)
  useEffect(() => {
    if (!known) goSplit('important')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known])

  useEffect(() => {
    if (overlay === 'rules') void client.api.folders().then(setFolders)
  }, [client, overlay])

  useCommands({
    // Tab moves between fields while the rules editor is open.
    ...(overlay === 'rules'
      ? {}
      : { 'nav.nextSplit': () => cycle(1), 'nav.prevSplit': () => cycle(-1) }),
    'go.inbox': () => goSplit('important'),
    'app.palette': () => open('palette'),
    'app.shortcuts': () => open('shortcuts'),
    'compose.new': () => {
      const first = accounts.keys().next().value
      if (first) compose.open(compose.resume(null) ?? newDraft(first))
    },
    'app.splitRules': () => open('rules'),
    ...(overlay ? { 'nav.back': () => setOverlay(null) } : {}),
  })

  const extra = useMemo<PaletteItem[]>(
    () =>
      tabs
        .filter((s) => s.key !== split)
        .map((s) => ({
          id: `split.${s.key}`,
          label: `Go to ${s.label}`,
          run: () => goSplit(s.key),
        })),
    // goSplit only closes over navigate, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [split, tabs],
  )

  return (
    <div className="shell">
      <AppHeader split={split} tabs={tabs} onPalette={() => open('palette')} />
      <main className="main">
        <Inbox key={split} split={split} active={!overlay && !sheet} />
      </main>
      {sheet && <Composer key={sheet.id} initial={sheet} />}
      <UndoToast />
      {overlay === 'palette' && (
        <CommandPalette available={available} extra={extra} onClose={() => setOverlay(null)} />
      )}
      {overlay === 'rules' && (
        <SplitRulesEditor
          rules={splitRules ?? []}
          accounts={[...accounts.values()]}
          folders={folders}
          onSave={(rule) => editSplitRule(rule.id, rule)}
          onDelete={(id) => editSplitRule(id, null)}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === 'shortcuts' && (
        <CheatSheet available={available} onClose={() => setOverlay(null)} />
      )}
    </div>
  )
}
