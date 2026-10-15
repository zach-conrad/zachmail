import { Stack } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { fullTime } from '../../../src/mail/format'
import { mail, useMail } from '../../../src/mail/useMail'
import { EmptyState } from '../../../src/ui/EmptyState'
import { ThreadList } from '../../../src/ui/ThreadList'

export default function Reminders() {
  const s = useMail()
  const insets = useSafeAreaInsets()
  const rows = mail.reminders(s)
  const due = new Map(rows.map((r) => [r.thread.id, r.until]))
  return (
    <>
      <Stack.Screen
        options={{ title: 'Reminders', headerLargeTitleEnabled: true, headerTransparent: true }}
      />
      <ThreadList
        threads={rows.map((r) => r.thread)}
        metaFor={(t) => {
          const until = due.get(t.id)
          return until ? fullTime(until) : undefined
        }}
        empty={
          <EmptyState
            title="Nothing snoozed."
            subtitle="Swipe left on a thread to bring it back later."
          />
        }
        bottomInset={insets.bottom + 80}
      />
    </>
  )
}
