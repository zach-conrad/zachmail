import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import { fullTime } from '../../src/mail/format'
import { snoozeOptions } from '../../src/mail/snooze'
import { mail } from '../../src/mail/useMail'
import { useTheme } from '../../src/theme/useTheme'

/** Half-height snooze picker (design §3.6, §6.3); each option shows its resolved time. */
export default function SnoozePicker() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>()
  const t = useTheme()
  const router = useRouter()
  const c = t.colors
  const [now] = useState(Date.now)
  const pick = (until: number | null) => {
    mail.run({ kind: 'snooze', threadId: id, until })
    // From a thread, the snoozed thread leaves too: close the sheet and the reader together.
    router.dismiss(from === 'thread' ? 2 : 1)
  }
  return (
    <ScrollView style={{ backgroundColor: c.surface }} contentContainerStyle={styles.content}>
      <Text style={[t.type.section, styles.section, { color: c.textMuted }]}>REMIND ME</Text>
      {snoozeOptions(now).map((o) => (
        <Pressable
          key={o.id}
          onPress={() => pick(o.until)}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.rowHover }]}
          accessibilityRole="button"
        >
          <Text style={[t.type.body, styles.flex, { color: c.text }]}>{o.label}</Text>
          <Text style={[t.type.meta, { color: c.textFaint }]}>
            {o.until ? fullTime(o.until) : ''}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingVertical: 24 },
  section: { paddingHorizontal: 20, paddingBottom: 6, letterSpacing: 0.8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, minHeight: 52 },
  flex: { flex: 1 },
})
