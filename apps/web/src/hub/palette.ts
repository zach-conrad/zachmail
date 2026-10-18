import type { ModuleId } from '@zachhub/core'
import { useLayoutEffect, useRef } from 'react'

export interface PaletteItem {
  id: string
  label: string
  /** Secondary text after the label (a sender, a due date). */
  detail?: string
  keys?: string
  run: () => void
}

/** Entity results one module adds to the universal ⌘K as you type (design H6). */
export interface PaletteSource {
  module: Exclude<ModuleId, 'today'>
  /** Results for `query`, best first. Local-first: no network on the keystroke path. */
  search(query: string): Promise<PaletteItem[]>
  /** The free-text fallback at the end of this module's group ("Search mail for …"). */
  fallback?(query: string): PaletteItem
}

/** Group order in the palette: Tasks · Docs · Mail · Commands. */
export const GROUP_ORDER = ['tasks', 'docs', 'mail', 'commands'] as const
export type PaletteGroup = (typeof GROUP_ORDER)[number]
export const GROUP_LABEL: Record<PaletteGroup, string> = {
  tasks: 'Tasks',
  docs: 'Docs',
  mail: 'Mail',
  commands: 'Commands',
}

/**
 * `in:tasks`, `in:docs`, `in:mail` or `in:commands` limits the palette to one group; the
 * token is taken out of what the sources see. Mail's own `in:inbox` etc. pass through.
 */
export function scopeQuery(raw: string): { group: PaletteGroup | null; text: string } {
  const m = /(?:^|\s)in:(tasks|docs|mail|commands)(?=\s|$)/i.exec(raw)
  if (!m) return { group: null, text: raw.trim() }
  const text = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).replace(/\s+/g, ' ')
  return { group: m[1]!.toLowerCase() as PaletteGroup, text: text.trim() }
}

// Commands a mounted view adds to the palette (Mail's "Go to Newsletters"), newest last.
const extras = new Set<{ current: PaletteItem[] }>()

/** Adds `items` to the palette's Commands group while the calling view is mounted. */
export function usePaletteItems(items: PaletteItem[]) {
  const ref = useRef(items)
  useLayoutEffect(() => {
    ref.current = items
  })
  useLayoutEffect(() => {
    extras.add(ref)
    return () => void extras.delete(ref)
  }, [])
}

export const paletteExtras = (): PaletteItem[] => [...extras].flatMap((r) => r.current)
