import { Stack } from 'expo-router'
import { useState } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { searchThreads } from '../../../src/mail/store'
import { useMail } from '../../../src/mail/useMail'
import { EmptyState } from '../../../src/ui/EmptyState'
import { ThreadList } from '../../../src/ui/ThreadList'

/** Local search as you type (design §3.5); operators arrive with the SQLite FTS replica. */
export default function Search() {
  const s = useMail()
  const insets = useSafeAreaInsets()
  const [q, setQ] = useState('')
  return (
    <>
      <Stack.Screen
        options={{
          title: 'Search',
          headerLargeTitleEnabled: true,
          headerTransparent: true,
          headerSearchBarOptions: {
            placeholder: 'Mail, people, subjects',
            autoCapitalize: 'none',
            onChangeText: (e) => setQ(e.nativeEvent.text),
          },
        }}
      />
      <ThreadList
        threads={searchThreads(s, q)}
        empty={q ? <EmptyState title="No matches." /> : undefined}
        bottomInset={insets.bottom + 80}
      />
    </>
  )
}
