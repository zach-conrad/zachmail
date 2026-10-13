import type { JobHandler } from './runner'

/** Job kinds the worker understands. Provider sync and outbox handlers land in later phases. */
export const handlers: Record<string, JobHandler> = {
  async noop() {},
}
