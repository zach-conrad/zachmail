import { FlashList, type FlashListRef } from '@shopify/flash-list'
import type { ThreadListItem as Thread } from '@zachmail/local-store'
import * as Haptics from 'expo-haptics'
import { Link, useRouter } from 'expo-router'
import { useRef, type ReactElement } from 'react'
import { LayoutAnimation } from 'react-native'
import { useReducedMotion } from 'react-native-reanimated'
import type { Command } from '../mail/store'
import type { SwipeAction } from '../mail/swipe'
import { mail, useMail } from '../mail/useMail'
import { useTheme } from '../theme/useTheme'
import { SwipeableRow } from './SwipeableRow'
import { ThreadRow } from './ThreadRow'
import { useNow } from './useNow'

export interface ThreadListProps {
  threads: Thread[]
  /** Replaces the row's time, e.g. a reminder's due date. */
  metaFor?: (t: Thread) => string | undefined
  header?: ReactElement
  empty?: ReactElement
  /** Extra bottom padding so the last row clears floating glass (compose button, tab bar). */
  bottomInset?: number
}

/**
 * Virtualized thread list (FlashList) shared by Inbox, Reminders, Done and Search. Swipe triage and
 * the long-press menu both run the same local commands as the keyboard on web.
 */
export function ThreadList({ threads, metaFor, header, empty, bottomInset = 0 }: ThreadListProps) {
  const theme = useTheme()
  const s = useMail()
  const router = useRouter()
  const now = useNow()
  const reduceMotion = useReducedMotion()
  const listRef = useRef<FlashListRef<Thread>>(null)
  const all = mail.accounts(s)
  const myEmails = new Set(all.map((a) => a.email.toLowerCase()))
  const accounts = new Map(all.map((a) => [a.id, a]))

  const run = (cmd: Command) => {
    if (cmd.kind === 'done' || cmd.kind === 'trash' || cmd.kind === 'snooze') {
      listRef.current?.prepareForLayoutAnimationRender()
      if (!reduceMotion)
        LayoutAnimation.configureNext(
          LayoutAnimation.create(theme.motion.base, 'easeInEaseOut', 'opacity'),
        )
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    }
    mail.run(cmd)
  }

  const onSwipe = (id: string, a: SwipeAction) => {
    if (a === 'snooze') router.push({ pathname: '/snooze/[id]', params: { id } })
    else run({ kind: a, threadId: id })
  }

  return (
    <FlashList
      ref={listRef}
      data={threads}
      keyExtractor={(t) => t.id}
      extraData={now}
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.colors.bg }}
      contentContainerStyle={{ paddingBottom: bottomInset }}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      renderItem={({ item }) => (
        <SwipeableRow id={item.id} theme={theme} onAction={onSwipe}>
          <Link href={{ pathname: '/thread/[id]', params: { id: item.id } }} asChild>
            <Link.Trigger>
              <ThreadRow
                thread={item}
                account={accounts.get(item.accountId)}
                myEmails={myEmails}
                now={now}
                theme={theme}
                meta={metaFor?.(item)}
              />
            </Link.Trigger>
            <Link.Preview />
            <Link.Menu>
              <Link.MenuAction
                title="Done"
                icon="checkmark"
                onPress={() => run({ kind: 'done', threadId: item.id })}
              />
              <Link.MenuAction
                title="Remind me"
                icon="clock"
                onPress={() => onSwipe(item.id, 'snooze')}
              />
              <Link.MenuAction
                title={item.unread ? 'Mark read' : 'Mark unread'}
                icon={item.unread ? 'envelope.open' : 'envelope.badge'}
                onPress={() => run({ kind: 'toggleRead', threadId: item.id })}
              />
              <Link.MenuAction
                title={item.starred ? 'Unstar' : 'Star'}
                icon={item.starred ? 'star.slash' : 'star'}
                onPress={() => run({ kind: 'star', threadId: item.id })}
              />
              <Link.MenuAction
                title="Trash"
                icon="trash"
                destructive
                onPress={() => run({ kind: 'trash', threadId: item.id })}
              />
            </Link.Menu>
          </Link>
        </SwipeableRow>
      )}
    />
  )
}
