import { formatKeys } from '@zachmail/core'
import { isApple } from '../lib/platform'

export function Kbd({ keys }: { keys: string }) {
  return <kbd className="kbd">{formatKeys(keys, isApple)}</kbd>
}
