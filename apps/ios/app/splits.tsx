import { useRouter } from 'expo-router'
import type { ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { splits, type SplitId } from '../src/mail/splits'
import { splitCounts, type Scope } from '../src/mail/store'
import { mail, useMail } from '../src/mail/useMail'
import type { Theme } from '../src/theme/theme'
import { useTheme } from '../src/theme/useTheme'
import { AccountDot } from '../src/ui/AccountDot'
import { Icon } from '../src/ui/Icon'

interface RowProps {
  theme: Theme
  label: string
  selected: boolean
  onPress: () => void
  leading?: ReactNode
  trailing?: string | undefined
}

function Row({ theme: t, label, selected, onPress, leading, trailing }: RowProps) {
  const c = t.colors
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.rowHover }]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      {leading}
      <Text
        style={[t.type.body, styles.flex, { color: c.text, fontWeight: selected ? '600' : '400' }]}
      >
        {label}
      </Text>
      {trailing && (
        <Text style={[t.type.meta, { color: c.textFaint, fontVariant: ['tabular-nums'] }]}>
          {trailing}
        </Text>
      )}
      <View style={styles.check}>
        {selected && <Icon name="checkmark" size={16} color={c.accent} weight="semibold" />}
      </View>
    </Pressable>
  )
}

/** Split switcher sheet (design §6.3), with the account scope beneath (design §2). */
export default function SplitSwitcher() {
  const t = useTheme()
  const s = useMail()
  const router = useRouter()
  const counts = splitCounts(s)
  const c = t.colors

  const pickSplit = (id: SplitId) => {
    mail.setSplit(id)
    router.back()
  }
  const pickScope = (scope: Scope) => {
    mail.setScope(scope)
    router.back()
  }

  return (
    <ScrollView style={{ backgroundColor: c.surface }} contentContainerStyle={styles.content}>
      <Text style={[t.type.section, styles.section, { color: c.textMuted }]}>SPLITS</Text>
      {splits.map((x) => (
        <Row
          theme={t}
          key={x.id}
          label={x.label}
          selected={s.split === x.id}
          onPress={() => pickSplit(x.id)}
          trailing={counts[x.id] ? String(counts[x.id]) : undefined}
        />
      ))}
      <Text style={[t.type.section, styles.section, { color: c.textMuted }]}>ACCOUNTS</Text>
      <Row
        theme={t}
        label="All accounts"
        selected={s.scope === 'all'}
        onPress={() => pickScope('all')}
        leading={<Icon name="tray.2" size={16} color={c.textMuted} />}
      />
      {s.accounts.map((a) => (
        <Row
          theme={t}
          key={a.id}
          label={a.shortName ?? a.email}
          selected={s.scope === a.id}
          onPress={() => pickScope(a.id)}
          leading={
            <View style={styles.dot}>
              <AccountDot color={a.color} size={10} />
            </View>
          }
          trailing={a.email}
        />
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingVertical: 24 },
  section: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 6, letterSpacing: 0.8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    minHeight: 48,
  },
  flex: { flex: 1 },
  check: { width: 18, alignItems: 'center' },
  dot: { width: 16, alignItems: 'center' },
})
