import type { TasksBackend } from '@zachhub/tasks-web'
import type { DataClient } from './client'

/** The tasks module's view of the data worker: hub entities in the replica, synced by the worker. */
export const tasksBackend = (client: DataClient): TasksBackend => ({
  read: (kind) => client.api.entities(kind),
  write: (writes) => client.api.entityWrite(writes),
  onChange: (fn) =>
    client.subscribe((e) => {
      if (e.type === 'changed') fn()
    }),
})
