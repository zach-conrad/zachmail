/** The modules this build ships, in rail order. Add a module here to install it everywhere. */
import { installModules } from '@zachhub/kernel'
import { tasksModule } from '@zachhub/tasks-api'

export const installed = installModules([tasksModule])
