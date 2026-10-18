import { useParams, useSearch } from '@tanstack/react-router'
import { useLayoutEffect } from 'react'
import { Shell } from '../app/Shell'
import { isView } from '../app/splits'
import { endInteraction } from '../lib/perf'

/** The Mail module's route: the inbox, its splits, search and the composer. */
export function MailModule() {
  const { split } = useParams({ from: '/inbox/$split' })
  const { thread, q } = useSearch({ from: '/inbox/$split' })
  useLayoutEffect(() => endInteraction('go.mail'), [])
  return (
    <Shell
      split={isView(split) ? split : 'important'}
      openThread={thread ?? null}
      searchQuery={q ?? null}
    />
  )
}
