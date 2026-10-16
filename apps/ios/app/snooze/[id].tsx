import { parseSnoozeTime, snoozeOptions } from '@zachhub/core'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { fullTime } from '../../src/mail/format'
import { mail } from '../../src/mail/useMail'
import { useTheme } from '../../src/theme/useTheme'

/**
 * Half-height snooze picker (design §3.6, §6.3): the shared presets with their resolved times,
 * plus a natural-language field ("in 3 days", "oct 20 2pm") parsed by the same code as web.
 */
export default function SnoozePicker() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>()
  const t = useTheme()
  const router = useRouter()
  const c = t.colors
  const [now] = useState(() => new Date())
  const [text, setText] = useState('')
  const parsed = text.trim() ? parseSnoozeTime(text, now) : null
  const pick = (until: number) => {
    mail.run({ kind: 'snooze', threadId: id, until })
    // From a thread, the snoozed thread leaves too: close the sheet and the reader together.
    router.dismiss(from === 'thread' ? 2 : 1)
  }
  return (
    <ScrollView
      style={{ backgroundColor: c.surface }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[t.type.section, styles.section, { color: c.textMuted }]}>REMIND ME</Text>
      {snoozeOptions(now).map((o) => (
        <Pressable
          key={o.id}
          onPress={() => pick(o.at)}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.rowHover }]}
          accessibilityRole="button"
        >
          <Text style={[t.type.body, styles.flex, { color: c.text }]}>{o.label}</Text>
          <Text style={[t.type.meta, { color: c.textFaint }]}>{fullTime(o.at)}</Text>
        </Pressable>
      ))}
      <View style={[styles.row, styles.custom, { borderTopColor: c.border }]}>
        <TextInput
          style={[t.type.body, styles.flex, { color: c.text }]}
          value={text}
          onChangeText={setText}
          placeholder="In 3 days, Oct 20 2pm…"
          placeholderTextColor={c.textFaint}
          returnKeyType="done"
          onSubmitEditing={() => parsed && pick(parsed)}
          autoCorrect={false}
        />
        {text.trim() !== '' && (
          <Pressable
            disabled={!parsed}
            onPress={() => parsed && pick(parsed)}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={[t.type.meta, { color: parsed ? c.accent : c.textFaint }]}>
              {parsed ? fullTime(parsed) : 'Not a time'}
            </Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingVertical: 24 },
  section: { paddingHorizontal: 20, paddingBottom: 6, letterSpacing: 0.8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    minHeight: 52,
  },
  custom: { marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  flex: { flex: 1 },
})
