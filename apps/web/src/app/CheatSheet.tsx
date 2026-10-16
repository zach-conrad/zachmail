import { keymap, type CommandGroup, type CommandId } from '@zachhub/core'
import { Kbd } from './Kbd'

const GROUPS: { id: CommandGroup; label: string }[] = [
  { id: 'hub', label: 'ZachHub' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'triage', label: 'Triage' },
  { id: 'compose', label: 'Compose' },
  { id: 'selection', label: 'Selection' },
  { id: 'app', label: 'App' },
]

/**
 * `?` overlay listing every shortcut, straight from the keymap so it never drifts. Commands
 * nothing on screen handles yet are dimmed.
 */
export function CheatSheet({
  available,
  onClose,
}: {
  available: readonly CommandId[]
  onClose: () => void
}) {
  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="cheatsheet"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        {GROUPS.map((g) => (
          <section key={g.id}>
            <h2 className="section-label">{g.label}</h2>
            <dl>
              {keymap
                .filter(
                  (b) =>
                    b.group === g.id &&
                    b.keys.length > 0 &&
                    (!('platforms' in b) || (b.platforms as readonly string[]).includes('web')),
                )
                .map((b) => (
                  <div
                    key={b.id}
                    className="cheatsheet-row"
                    data-off={!available.includes(b.id) || undefined}
                  >
                    <dt>{b.label}</dt>
                    <dd>
                      <Kbd keys={b.keys[0]!} />
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  )
}
