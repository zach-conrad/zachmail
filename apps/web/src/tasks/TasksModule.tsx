import { useNavigate, useParams } from '@tanstack/react-router'
import TasksScreen from '@zachhub/tasks-web'
import { useLayoutEffect, useMemo } from 'react'
import { useData } from '../data/DataProvider'
import { tasksBackend } from '../data/tasksBackend'
import { lastMailSplit } from '../hub/modules'
import { endInteraction } from '../lib/perf'
import { demoMode } from '../lib/supabase'

/** Tasks module route: tasks and reminders on the hub replica (ZACHHUB_PLAN.md §3.2). */
export function TasksModule() {
  const { view } = useParams({ from: '/tasks/$view' })
  const navigate = useNavigate()
  const { client } = useData()
  const backend = useMemo(() => tasksBackend(client), [client])
  useLayoutEffect(() => endInteraction('go.tasks'), [])
  return (
    <TasksScreen
      view={view}
      demo={demoMode && Number(new URLSearchParams(location.search).get('tasks') ?? 60)}
      backend={backend}
      onNavigate={(to) => void navigate({ to: '/tasks/$view', params: { view: to } })}
      onGoMail={() =>
        void navigate({ to: '/inbox/$split', params: { split: lastMailSplit() }, search: {} })
      }
    />
  )
}
