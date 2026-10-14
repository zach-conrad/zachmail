import {
  BUILT_IN_SPLIT_LABELS,
  SPLIT_FIELDS,
  SPLIT_IDS,
  SPLIT_RULE_LIMITS,
  sortSplitRules,
  type AccountRow,
  type FolderRow,
  type SplitCondition,
  type SplitField,
  type SplitRuleRow,
} from '@zachmail/core'
import { useState } from 'react'
import { useCommands } from '../lib/useCommands'

const FIELD_LABELS: Record<SplitField, string> = {
  from: 'Sender contains',
  domain: 'Sender domain is',
  to: 'Recipient contains',
  subject: 'Subject contains',
  account: 'Account is',
  label: 'Label is',
}

const PLACEHOLDERS: Partial<Record<SplitField, string>> = {
  from: 'ana@ or @stripe.com',
  domain: 'stripe.com',
  to: 'zach@work.com',
  subject: 'invoice',
}

const blankCondition = (): SplitCondition => ({ field: 'from', value: '' })

export function newRule(position: number, conditions?: SplitCondition[]): SplitRuleRow {
  return {
    id: crypto.randomUUID(),
    name: '',
    target: 'custom',
    match: 'all',
    conditions: conditions ?? [blankCondition()],
    position,
  }
}

const isValid = (r: SplitRuleRow) =>
  r.name.trim().length > 0 &&
  r.name.length <= SPLIT_RULE_LIMITS.name &&
  r.conditions.length > 0 &&
  r.conditions.every((c) => c.value.trim().length > 0)

/**
 * Settings → Splits & filters (design §6.4). Rules run top to bottom before the built-in
 * splits; the first match wins. Saving applies to the local replica at once and syncs after.
 */
export function SplitRulesEditor({
  rules,
  accounts,
  folders,
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  rules: readonly SplitRuleRow[]
  accounts: readonly AccountRow[]
  folders: readonly FolderRow[]
  /** A draft to open with (e.g. "split by this sender"). */
  initial?: SplitRuleRow
  onSave: (rule: SplitRuleRow) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  const sorted = sortSplitRules(rules)
  const [draft, setDraft] = useState<SplitRuleRow | null>(() => initial ?? sorted[0] ?? newRule(1))
  const isNew = !!draft && !rules.some((r) => r.id === draft.id)
  const saved = draft && rules.find((r) => r.id === draft.id)
  const dirty = !!draft && (isNew || JSON.stringify(saved) !== JSON.stringify(draft))
  const nextPosition = (sorted.at(-1)?.position ?? 0) + 1

  useCommands({ 'nav.back': onClose })

  const edit = (patch: Partial<SplitRuleRow>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  const editCondition = (i: number, patch: Partial<SplitCondition>) =>
    setDraft((d) =>
      d ? { ...d, conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) } : d,
    )

  const select = (r: SplitRuleRow) => setDraft(r)

  const move = (r: SplitRuleRow, dir: -1 | 1) => {
    const i = sorted.findIndex((x) => x.id === r.id)
    const other = sorted[i + dir]
    if (!other) return
    // Swap positions; equal positions (rare) get pushed apart.
    const a = other.position === r.position ? r.position + dir : other.position
    onSave({ ...r, position: a })
    onSave({ ...other, position: r.position })
    if (draft?.id === r.id) edit({ position: a })
  }

  const save = () => {
    if (!draft || !isValid(draft)) return
    const clean = {
      ...draft,
      name: draft.name.trim(),
      conditions: draft.conditions.map((c) => ({ ...c, value: c.value.trim() })),
    }
    onSave(clean)
    setDraft(clean)
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="rules-editor"
        role="dialog"
        aria-label="Splits and rules"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="rules-list">
          <h2 className="section-label">Rules</h2>
          <p className="rules-hint muted">Top to bottom, first match wins.</p>
          <ol>
            {sorted.map((r, i) => (
              <li key={r.id} aria-current={draft?.id === r.id ? 'true' : undefined}>
                <button className="rules-item" onClick={() => select(r)}>
                  <span>{r.name}</span>
                  <span className="muted">
                    {r.target === 'custom' ? 'Own split' : BUILT_IN_SPLIT_LABELS[r.target]}
                  </span>
                </button>
                <span className="rules-move">
                  <button
                    aria-label={`Move ${r.name} up`}
                    disabled={i === 0}
                    onClick={() => move(r, -1)}
                  >
                    ↑
                  </button>
                  <button
                    aria-label={`Move ${r.name} down`}
                    disabled={i === sorted.length - 1}
                    onClick={() => move(r, 1)}
                  >
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <button className="btn" onClick={() => setDraft(newRule(nextPosition))}>
            New rule
          </button>
        </aside>

        {draft ? (
          <form
            className="rules-form"
            onSubmit={(e) => {
              e.preventDefault()
              save()
            }}
          >
            <label className="field">
              <span>Name</span>
              <input
                autoFocus
                value={draft.name}
                maxLength={SPLIT_RULE_LIMITS.name}
                placeholder="Receipts"
                onChange={(e) => edit({ name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Send matching mail to</span>
              <select
                value={draft.target}
                onChange={(e) => edit({ target: e.target.value as SplitRuleRow['target'] })}
              >
                <option value="custom">Its own split tab</option>
                {SPLIT_IDS.map((id) => (
                  <option key={id} value={id}>
                    {BUILT_IN_SPLIT_LABELS[id]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Match</span>
              <select
                value={draft.match}
                onChange={(e) => edit({ match: e.target.value as SplitRuleRow['match'] })}
              >
                <option value="all">All conditions</option>
                <option value="any">Any condition</option>
              </select>
            </label>

            <fieldset className="conditions">
              <legend className="section-label">Conditions</legend>
              {draft.conditions.map((c, i) => (
                <div className="condition" key={i}>
                  <select
                    aria-label="Field"
                    value={c.field}
                    onChange={(e) =>
                      editCondition(i, { field: e.target.value as SplitField, value: '' })
                    }
                  >
                    {SPLIT_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {FIELD_LABELS[f]}
                      </option>
                    ))}
                  </select>
                  {c.field === 'account' || c.field === 'label' ? (
                    <select
                      aria-label="Value"
                      value={c.value}
                      onChange={(e) => editCondition(i, { value: e.target.value })}
                    >
                      <option value="">Choose…</option>
                      {c.field === 'account'
                        ? accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.shortName ?? a.email}
                            </option>
                          ))
                        : folders
                            .filter((f) => f.kind === 'custom')
                            .map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.name}
                              </option>
                            ))}
                    </select>
                  ) : (
                    <input
                      aria-label="Value"
                      value={c.value}
                      maxLength={SPLIT_RULE_LIMITS.value}
                      placeholder={PLACEHOLDERS[c.field]}
                      onChange={(e) => editCondition(i, { value: e.target.value })}
                    />
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Remove condition"
                    disabled={draft.conditions.length === 1}
                    onClick={() => edit({ conditions: draft.conditions.filter((_, j) => j !== i) })}
                  >
                    ×
                  </button>
                </div>
              ))}
              {draft.conditions.length < SPLIT_RULE_LIMITS.conditions && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => edit({ conditions: [...draft.conditions, blankCondition()] })}
                >
                  Add condition
                </button>
              )}
            </fieldset>

            <div className="rules-actions">
              {!isNew && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    onDelete(draft.id)
                    setDraft(sorted.find((r) => r.id !== draft.id) ?? null)
                  }}
                >
                  Delete
                </button>
              )}
              <span className="spacer" />
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!dirty || !isValid(draft)}
              >
                {isNew ? 'Create' : 'Save'}
              </button>
            </div>
          </form>
        ) : (
          <div className="rules-form rules-empty muted">
            No rules yet. Create one to route mail into a split or give it a tab of its own.
          </div>
        )}
      </div>
    </div>
  )
}
