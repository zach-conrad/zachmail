import { Stack, useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { splits } from '../../../src/mail/splits'
import { mail, useMail } from '../../../src/mail/useMail'
import { useTheme } from '../../../src/theme/useTheme'
import { AccountDot } from '../../../src/ui/AccountDot'
import { ComposeButton } from '../../../src/ui/ComposeButton'
import { EmptyState } from '../../../src/ui/EmptyState'
import { Icon } from '../../../src/ui/Icon'
import { ThreadList } from '../../../src/ui/ThreadList'

/** Inbox (design §6.3): the large title is the current split and opens the split switcher. */
export default function Inbox() {
  const t = useTheme()
  const s = useMail()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const threads = mail.inbox(s)
  const split = splits.find((x) => x.id === s.split)!
  const scoped = s.scope === 'all' ? undefined : mail.account(s.scope)

  const header = (
    <Pressable
      style={styles.header}
      onPress={() => router.push('/splits')}
      accessibilityRole="button"
      accessibilityLabel={`${split.label} split. Switch split or account`}
    >
      <View style={styles.titleRow}>
        <Text style={[t.type.display, styles.title, { color: t.colors.text }]}>{split.label}</Text>
        <Icon name="chevron.down" size={16} color={t.colors.textMuted} weight="semibold" />
      </View>
      <View
        style={[
          styles.chip,
          { backgroundColor: t.colors.surfaceRaised, borderColor: t.colors.border },
        ]}
      >
        {scoped && <AccountDot color={scoped.color} />}
        <Text style={[t.type.meta, { color: t.colors.textMuted }]}>
          {scoped ? (scoped.shortName ?? scoped.email) : 'All accounts'}
        </Text>
      </View>
    </Pressable>
  )

  return (
    <View style={styles.flex}>
      <Stack.Screen
        options={{
          headerTransparent: true,
          title: '',
          // Glass bar button (design §6.3): the palette, the phone's ⌘K.
          unstable_headerRightItems: () => [
            {
              type: 'button',
              label: 'Commands',
              icon: { type: 'sfSymbol', name: 'command' },
              onPress: () => router.push('/palette'),
            },
          ],
        }}
      />
      <ThreadList
        threads={threads}
        header={header}
        empty={
          <EmptyState
            title="You're all done."
            subtitle={new Date().toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
          />
        }
        bottomInset={insets.bottom + 140}
      />
      <ComposeButton />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 8, gap: 8, alignItems: 'flex-start' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontWeight: '700' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 9999,
    borderWidth: StyleSheet.hairlineWidth,
  },
})
