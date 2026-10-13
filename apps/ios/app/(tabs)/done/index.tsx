import { Stack } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { doneThreads } from '../../../src/mail/store'
import { useMail } from '../../../src/mail/useMail'
import { EmptyState } from '../../../src/ui/EmptyState'
import { ThreadList } from '../../../src/ui/ThreadList'

export default function Done() {
  const s = useMail()
  const insets = useSafeAreaInsets()
  return (
    <>
      <Stack.Screen
        options={{ title: 'Done', headerLargeTitleEnabled: true, headerTransparent: true }}
      />
      <ThreadList
        threads={doneThreads(s)}
        empty={<EmptyState title="Nothing here yet." />}
        bottomInset={insets.bottom + 80}
      />
    </>
  )
}
