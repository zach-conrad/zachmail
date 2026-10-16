import { keymap } from '@zachhub/core'
import { useRouter, type Href } from 'expo-router'
import type { SFSymbol } from 'expo-symbols'
import { useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { fuzzyFilter } from '../src/mail/fuzzy'
import { splits } from '../src/mail/splits'
import { mail, useMail } from '../src/mail/useMail'
import { useTheme } from '../src/theme/useTheme'
import { AccountDot } from '../src/ui/AccountDot'
import { Icon } from '../src/ui/Icon'

interface Entry {
  key: string
  label: string
  hint?: string
  icon?: SFSymbol
  color?: number
  run: () => void
}

const label = (id: string) => keymap.find((k) => k.id === id)?.label ?? id
// Last five commands, shown when the input is empty (design §3.3). Per launch is enough on a phone.
const recents: string[] = []

/** Command palette as a glass sheet (design §3.3, §5.6): commands, splits, accounts, then mail. */
export default function Palette() {
  const t = useTheme()
  const s = useMail()
  const router = useRouter()
  const [q, setQ] = useState('')
  const c = t.colors

  const go = (href: Href) => {
    router.back()
    router.navigate(href)
  }
  const commands: Entry[] = [
    {
      key: 'compose.new',
      label: label('compose.new'),
      icon: 'square.and.pencil',
      run: () => go('/compose'),
    },
    { key: 'go.inbox', label: label('go.inbox'), icon: 'tray', run: () => go('/inbox') },
    {
      key: 'go.reminders',
      label: label('go.reminders'),
      icon: 'clock',
      run: () => go('/reminders'),
    },
    { key: 'go.done', label: label('go.done'), icon: 'checkmark.circle', run: () => go('/done') },
    {
      key: 'nav.search',
      label: label('nav.search'),
      icon: 'magnifyingglass',
      run: () => go('/search'),
    },
    ...splits.map((x) => ({
      key: `split.${x.id}`,
      label: `Go to ${x.label}`,
      hint: 'Split',
      icon: 'line.3.horizontal.decrease' as SFSymbol,
      run: () => {
        mail.setSplit(x.id)
        go('/inbox')
      },
    })),
    {
      key: 'scope.all',
      label: label('scope.all'),
      icon: 'tray.2',
      run: () => (mail.setScope('all'), go('/inbox')),
    },
    ...mail.accounts(s).map((a) => ({
      key: `scope.${a.id}`,
      label: `Switch to ${a.shortName ?? a.email}`,
      hint: a.email,
      color: a.color,
      run: () => (mail.setScope(a.id), go('/inbox')),
    })),
  ]

  const matches = q.trim()
    ? fuzzyFilter(commands, q, (e) => `${e.label} ${e.hint ?? ''}`)
    : recents
        .flatMap((k) => commands.filter((e) => e.key === k))
        .concat(commands.filter((e) => !recents.includes(e.key)))
  // Free text falls through to mail search, like ⌘K on web.
  const threads: Entry[] = q.trim()
    ? mail.search(s, q, 5).map((th) => ({
        key: `thread.${th.id}`,
        label: th.subject,
        hint: th.participants[0]?.name ?? th.participants[0]?.email,
        icon: 'envelope' as SFSymbol,
        run: () => go({ pathname: '/thread/[id]', params: { id: th.id } }),
      }))
    : []
  const entries = [...matches, ...threads]

  const pick = (e: Entry) => {
    if (!e.key.startsWith('thread.')) {
      const i = recents.indexOf(e.key)
      if (i >= 0) recents.splice(i, 1)
      recents.unshift(e.key)
      recents.length = Math.min(recents.length, 5)
    }
    e.run()
  }

  return (
    <View style={[styles.flex, { backgroundColor: c.surfaceRaised }]}>
      <View style={[styles.inputRow, { borderBottomColor: c.border }]}>
        <Icon name="command" size={18} color={c.textMuted} />
        <TextInput
          style={[t.type.body, styles.flex, { color: c.text }]}
          value={q}
          onChangeText={setQ}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          placeholder="Type a command or search"
          placeholderTextColor={c.textFaint}
          returnKeyType="go"
          onSubmitEditing={() => entries[0] && pick(entries[0])}
        />
      </View>
      <FlatList
        data={entries}
        keyExtractor={(e) => e.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item: e, index }) => (
          <Pressable
            onPress={() => pick(e)}
            style={({ pressed }) => [
              styles.row,
              (pressed || (index === 0 && q !== '')) && { backgroundColor: c.rowFocus },
            ]}
            accessibilityRole="button"
          >
            <View style={styles.icon}>
              {e.color !== undefined ? (
                <AccountDot color={e.color} size={10} />
              ) : (
                e.icon && <Icon name={e.icon} size={16} color={c.textMuted} />
              )}
            </View>
            <Text numberOfLines={1} style={[t.type.body, styles.flex, { color: c.text }]}>
              {e.label}
            </Text>
            {e.hint && (
              <Text numberOfLines={1} style={[t.type.meta, styles.hint, { color: c.textFaint }]}>
                {e.hint}
              </Text>
            )}
          </Pressable>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    minHeight: 48,
  },
  icon: { width: 18, alignItems: 'center' },
  hint: { maxWidth: '45%' },
})
