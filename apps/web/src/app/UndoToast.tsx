import { useSyncExternalStore } from 'react'
import { useData } from '../data/DataProvider'
import { runCommand } from '../lib/useCommands'
import { Kbd } from './Kbd'

/** Bottom-left capsule after every triage action, with Undo (Z) for 6 s (design §3.1). */
export function UndoToast() {
  const { triage } = useData()
  const toast = useSyncExternalStore(triage.subscribe, triage.getToast)
  if (!toast) return null
  return (
    <div
      key={toast.key}
      className="toast"
      role={toast.error ? 'alert' : 'status'}
      data-error={toast.error || undefined}
    >
      {!toast.error && (
        <span className="toast-check" aria-hidden>
          ✓
        </span>
      )}
      <span className="toast-text">{toast.text}</span>
      {toast.undo && (
        <button className="toast-undo" onClick={() => runCommand('undo')}>
          Undo <Kbd keys="z" />
        </button>
      )}
    </div>
  )
}
