/**
 * The tasks module as the hub installs it (ZACHHUB_PLAN.md §2.2): its first-party entities.
 * Task and list writes go through the kernel's /api/entities and reach devices in sync deltas.
 * Alerts (a `tasks.alert` job), MCP tools and the search indexer join this manifest next.
 */
import type { HubModule } from '@zachhub/kernel'
import { TASKS_ENTITIES } from '@zachhub/tasks-db'

export const tasksModule: HubModule = {
  name: 'tasks',
  entities: TASKS_ENTITIES,
}
