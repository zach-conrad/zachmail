import { isBuiltInSplit, isUuid } from '@zachmail/core'

/** Route guard: a built-in split, or something shaped like a custom split's rule id. */
export const isSplitKey = (s: string): boolean => isBuiltInSplit(s) || isUuid(s)
