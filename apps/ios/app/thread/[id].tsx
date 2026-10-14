import type { MessageBody, MessageRow } from '@zachmail/core'
import * as Haptics from 'expo-haptics'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayName, fullTime, messageTime } from '../../src/mail/format'
import type { Command } from '../../src/mail/store'
import { fetchBodies, mail, useMail } from '../../src/mail/useMail'
import type { Theme } from '../../src/theme/theme'
import { useTheme } from '../../src/theme/useTheme'
import { AccountDot } from '../../src/ui/AccountDot'
import { BodyView } from '../../src/ui/BodyView'
import { GlassSurface } from '../../src/ui/GlassSurface'
import { Icon } from '../../src/ui/Icon'

/** Read messages collapse to one line; the latest and any unread stay open (design §3.2). */
function MessageCard({
  m,
  body,
  open,
  onToggle,
  theme: t,
}: {
  m: MessageRow
  body: MessageBody | undefined
  open: boolean
  onToggle: () => void
  theme: Theme
}) {
  const c = t.colors
  return (
    <View style={[styles.card, { borderBottomColor: c.border }]}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.cardTap}
      >
        <View style={styles.cardHead}>
          <Text
            numberOfLines={1}
            style={[
              t.type.row,
              styles.flex,
              { color: c.text, fontWeight: m.unread ? '600' : '500' },
            ]}
          >
            {displayName(m.from)}
          </Text>
          <Text style={[t.type.meta, { color: c.textFaint, fontVariant: ['tabular-nums'] }]}>
            {open ? fullTime(m.date) : messageTime(m.date)}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          style={
            open ? [t.type.meta, { color: c.textFaint }] : [t.type.row, { color: c.textMuted }]
          }
        >
          {open ? `to ${m.to.map((a) => displayName(a)).join(', ')}` : m.snippet}
        </Text>
      </Pressable>
      {open &&
        (body ? (
          <BodyView body={body} theme={t} baseUrl={process.env.EXPO_PUBLIC_API_URL} />
        ) : (
          // Not prefetched yet: the snippet now, the body as soon as it arrives.
          <Text selectable style={[t.type.body, styles.body, { color: c.textMuted }]}>
            {m.snippet}
          </Text>
        ))}
    </View>
  )
}

/** Thread (design §6.3): solid message stack scrolling under a floating glass action capsule. */
export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const t = useTheme()
  const s = useMail()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const detail = mail.thread(s, id)
  const thread = detail?.thread
  const messages = detail?.messages ?? []
  const account = thread && mail.account(thread.accountId)
  const [expanded, setExpanded] = useState<Set<string>>(
    () =>
      new Set(messages.filter((m, i) => m.unread || i === messages.length - 1).map((m) => m.id)),
  )

  // Opening marks read locally, the same frame; the outbox syncs it later.
  useEffect(() => {
    if (thread?.unread) mail.run({ kind: 'markRead', threadId: id })
  }, [id, thread?.unread])
  useEffect(() => fetchBodies([id]), [id])

  if (!thread) return null

  /** Done/Trash auto-advance to the next inbox thread (design §3.1), else back to the list. */
  const triage = (kind: Extract<Command['kind'], 'done' | 'trash'>) => {
    const next = mail.nextInInbox(s, id)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    mail.run({ kind, threadId: id })
    if (next) router.replace({ pathname: '/thread/[id]', params: { id: next } })
    else router.back()
  }

  const toggle = (mid: string) =>
    setExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(mid)) n.delete(mid)
      else n.add(mid)
      return n
    })

  const actions: {
    icon: Parameters<typeof Icon>[0]['name']
    label: string
    onPress: () => void
  }[] = [
    { icon: 'checkmark', label: 'Done', onPress: () => triage('done') },
    {
      icon: 'clock',
      label: 'Remind me',
      onPress: () => router.push({ pathname: '/snooze/[id]', params: { id, from: 'thread' } }),
    },
    {
      icon: 'arrowshape.turn.up.left',
      label: 'Reply',
      onPress: () => router.push({ pathname: '/compose', params: { threadId: id, mode: 'reply' } }),
    },
  ]

  return (
    <View style={[styles.flex, { backgroundColor: t.colors.surface }]}>
      <Stack.Screen
        options={{
          unstable_headerRightItems: () => [
            {
              type: 'menu',
              label: 'More',
              icon: { type: 'sfSymbol', name: 'ellipsis' },
              menu: {
                items: [
                  {
                    type: 'action',
                    label: 'Reply all',
                    icon: { type: 'sfSymbol', name: 'arrowshape.turn.up.left.2' },
                    onPress: () =>
                      router.push({
                        pathname: '/compose',
                        params: { threadId: id, mode: 'replyAll' },
                      }),
                  },
                  {
                    type: 'action',
                    label: 'Forward',
                    icon: { type: 'sfSymbol', name: 'arrowshape.turn.up.right' },
                    onPress: () =>
                      router.push({
                        pathname: '/compose',
                        params: { threadId: id, mode: 'forward' },
                      }),
                  },
                  {
                    type: 'action',
                    label: thread.starred ? 'Unstar' : 'Star',
                    icon: { type: 'sfSymbol', name: thread.starred ? 'star.slash' : 'star' },
                    onPress: () => mail.run({ kind: 'star', threadId: id }),
                  },
                  {
                    type: 'action',
                    label: 'Mark unread',
                    icon: { type: 'sfSymbol', name: 'envelope.badge' },
                    onPress: () => {
                      mail.run({ kind: 'toggleRead', threadId: id })
                      router.back()
                    },
                  },
                  {
                    type: 'action',
                    label: 'Trash',
                    icon: { type: 'sfSymbol', name: 'trash' },
                    destructive: true,
                    onPress: () => triage('trash'),
                  },
                ],
              },
            },
          ],
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
      >
        <View style={styles.head}>
          <Text selectable style={[t.type.subject, { color: t.colors.text }]}>
            {thread.subject}
          </Text>
          <View style={styles.meta}>
            {account && <AccountDot color={account.color} />}
            <Text style={[t.type.meta, { color: t.colors.textMuted }]}>
              {account?.shortName ?? account?.email} · {thread.messageCount}{' '}
              {thread.messageCount === 1 ? 'message' : 'messages'}
            </Text>
          </View>
        </View>
        {messages.map((m) => (
          <MessageCard
            key={m.id}
            m={m}
            body={detail?.bodies[m.id]}
            open={expanded.has(m.id)}
            onToggle={() => toggle(m.id)}
            theme={t}
          />
        ))}
      </ScrollView>
      <View style={[styles.barWrap, { bottom: insets.bottom + 8 }]} pointerEvents="box-none">
        <GlassSurface interactive style={styles.bar}>
          {actions.map((a) => (
            <Pressable
              key={a.label}
              onPress={a.onPress}
              style={styles.barButton}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              hitSlop={4}
            >
              <Icon name={a.icon} size={22} color={t.colors.text} />
            </Pressable>
          ))}
        </GlassSurface>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 8 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  card: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cardTap: { gap: 4 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  body: { marginTop: 8 },
  barWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  bar: { flexDirection: 'row', paddingHorizontal: 8, height: 56, alignItems: 'center' },
  barButton: { width: 64, height: 48, alignItems: 'center', justifyContent: 'center' },
})
