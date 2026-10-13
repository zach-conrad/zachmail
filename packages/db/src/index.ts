/** Entity names written to `changes.entity`; clients switch on these when applying deltas. */
export const ENTITIES = ['account'] as const
export type Entity = (typeof ENTITIES)[number]
