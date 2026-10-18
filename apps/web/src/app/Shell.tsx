import { useNavigate } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Composer } from '../compose/Composer'
import { FollowUps } from '../followups/FollowUps'
import { newDraft } from '../compose/draft'
import { Inbox } from '../inbox/Inbox'
import { SearchView } from '../search/SearchView'
import { splitTabs, type FolderRow, type SplitKey } from '@zachhub/core'
import { REMINDERS } from '@zachhub/local-store'
import { useData } from '../data/DataProvider'
import { SplitRulesEditor } from '../splits/SplitRulesEditor'
import { runCommand, useCommands } from '../lib/useCommands'
import { AppHeader } from './AppHeader'
import { useHub } from './HubShell'
import { UndoToast } from './UndoToast'
import { rememberMailSplit } from '../hub/modules'
import { usePaletteItems, type PaletteItem } from '../hub/palette'

// Settings panes load on first open so they never weigh on the initial bundle.
const NotificationSettingsPane = lazy(() => import('../notifications/NotificationSettingsPane'))
const SnippetsEditor = lazy(() =>
  import('../compose/SnippetsEditor').then((m) => ({ default: m.SnippetsEditor })),
)

type Overlay = 'rules' | 'notifications' | 'followUps' | 'snippets' | null

/** Mail: split tabs, the inbox or search, and mail's own settings panes. */
export function Shell({
  split,
  openThread,
  searchQuery,
}: {
  split: SplitKey
  openThread: string | null
  /** Search asked for from outside Mail (⌘K's "Search mail for …"). */
  searchQuery: string | null
}) {
  const navigate = useNavigate()
  const hub = useHub()
  const { compose, accounts, client, splitRules, editSplitRule } = useData()
  useSyncExternalStore(compose.subscribe, compose.getVersion)
  const sheet = compose.sheet
  const tabs = useMemo(() => splitTabs(splitRules ?? []), [splitRules])
  const [folders, setFolders] = useState<FolderRow[]>([])
  const [overlay, setOverlay] = useState<Overlay>(null)
  // Search replaces the list while open (design §3.5); null when not searching. Each new
  // search asked for from outside starts a fresh search view.
  const [search, setSearch] = useState<{ text: string; n: number } | null>(
    searchQuery === null ? null : { text: searchQuery, n: 0 },
  )
  const [asked, setAsked] = useState(searchQuery)
  if (searchQuery !== asked) {
    setAsked(searchQuery)
    if (searchQuery !== null) setSearch((s) => ({ text: searchQuery, n: (s?.n ?? 0) + 1 }))
  }
  const open = (o: Exclude<Overlay, null>) => setOverlay(overlay === o ? null : o)
  const blocked = !!overlay || hub.overlayOpen

  const goSplit = (id: SplitKey) => void navigate({ to: '/inbox/$split', params: { split: id } })
  useEffect(() => rememberMailSplit(split), [split])
  // Drop the asked-for query from the URL so a reload doesn't search again.
  useEffect(() => {
    if (searchQuery !== null)
      void navigate({ to: '/inbox/$split', params: { split }, search: {}, replace: true })
  }, [searchQuery, split, navigate])
  const cycle = (dir: 1 | -1) => {
    // From Reminders, tab goes to the first split and shift+tab to the last.
    const i = tabs.findIndex((s) => s.key === split)
    const next = i < 0 ? (dir === 1 ? 0 : tabs.length - 1) : i + dir
    goSplit(tabs[(next + tabs.length) % tabs.length]!.key)
  }

  // A custom split whose rule was deleted (here or on another device) falls back to Important.
  const known = split === REMINDERS || splitRules === null || tabs.some((t) => t.key === split)
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
    'go.inbox': () => {
      setSearch(null)
      goSplit('important')
    },
    'nav.search': () => setSearch((s) => ({ text: '', n: (s?.n ?? 0) + 1 })),
    'go.reminders': () => {
      setSearch(null)
      goSplit(REMINDERS)
    },
    'compose.new': () => {
      const first = accounts.keys().next().value
      if (first) compose.open(compose.resume(null) ?? newDraft(first))
    },
    'app.splitRules': () => open('rules'),
    'app.notifications': () => open('notifications'),
    'app.snippets': () => open('snippets'),
    'go.followUps': () => open('followUps'),
    ...(overlay ? { 'nav.back': () => setOverlay(null) } : {}),
  })

  const view = useMemo(() => ({ split }), [split])
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
  usePaletteItems(extra)

  return (
    <div className="shell">
      <AppHeader split={split} tabs={tabs} onPalette={() => runCommand('app.palette')} />
      <main className="main">
        {search !== null ? (
          <SearchView
            key={search.n}
            initial={search.text}
            active={!blocked && !sheet}
            onExit={() => setSearch(null)}
          />
        ) : (
          <Inbox key={split} view={view} active={!blocked && !sheet} openThread={openThread} />
        )}
      </main>
      {sheet && <Composer key={sheet.id} initial={sheet} />}
      <UndoToast />
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
      {overlay === 'notifications' && (
        <Suspense fallback={null}>
          <NotificationSettingsPane
            tabs={tabs}
            accounts={[...accounts.values()]}
            onClose={() => setOverlay(null)}
          />
        </Suspense>
      )}
      {overlay === 'followUps' && <FollowUps onClose={() => setOverlay(null)} />}
      {overlay === 'snippets' && (
        <Suspense fallback={null}>
          <SnippetsEditor onClose={() => setOverlay(null)} />
        </Suspense>
      )}
    </div>
  )
}
