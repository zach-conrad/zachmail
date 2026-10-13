import type { AccountRow, ThreadRow as Thread } from '@zachmail/core'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View, type PressableProps } from 'react-native'
import { displayName, rowTime } from '../mail/format'
import type { Theme } from '../theme/theme'
import { AccountDot } from './AccountDot'
import { Icon } from './Icon'

export interface ThreadRowProps extends Omit<PressableProps, 'style' | 'children'> {
  thread: Thread
  account: AccountRow | undefined
  myEmails: Set<string>
  now: number
  theme: Theme
  /** Shown instead of the time, e.g. a reminder's due date. */
  meta?: string
}

/** Sender shown on a row: the latest participant who isn't Zach, else "me". */
function sender(t: Thread, me: Set<string>): string {
  const other = [...t.participants].reverse().find((p) => !me.has(p.email.toLowerCase()))
  return other ? displayName(other) : 'me'
}

/**
 * 72pt two-line row (design §6.3): dot · sender · time / subject — snippet. Solid, never glass.
 * Pressable props pass through so `<Link asChild>` can drive navigation and the context menu.
 */
export const ThreadRow = memo(function ThreadRow({
  thread: t,
  account,
  myEmails,
  now,
  theme,
  meta,
  ...pressable
}: ThreadRowProps) {
  const c = theme.colors
  const name = sender(t, myEmails)
  const time = meta ?? rowTime(t.lastMessageAt, now)
  return (
    <Pressable
      {...pressable}
      style={({ pressed }) => [
        styles.row,
        { height: theme.rowHeight, backgroundColor: pressed ? c.rowHover : c.bg },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${t.unread ? 'Unread. ' : ''}${name}. ${t.subject}. ${time}.${account?.shortName ? ` ${account.shortName} account.` : ''}`}
    >
      <View style={styles.dot}>{account && <AccountDot color={account.color} />}</View>
      <View style={styles.body}>
        <View style={styles.line}>
          <Text
            numberOfLines={1}
            style={[
              theme.type.row,
              styles.flex,
              { color: c.text, fontWeight: t.unread ? '600' : '400' },
            ]}
          >
            {name}
            {t.messageCount > 1 && (
              <Text style={{ color: c.textFaint, fontWeight: '400' }}>{`  ${t.messageCount}`}</Text>
            )}
          </Text>
          {t.hasAttachments && <Icon name="paperclip" size={12} color={c.textFaint} />}
          {t.starred && <Icon name="star.fill" size={12} color={c.warning} />}
          <Text
            style={[
              theme.type.meta,
              { color: t.unread ? c.accent : c.textFaint, fontVariant: ['tabular-nums'] },
            ]}
          >
            {time}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          style={[theme.type.row, { color: c.text, fontWeight: t.unread ? '500' : '400' }]}
        >
          {t.subject}
          <Text style={{ color: c.textMuted, fontWeight: '400' }}>{`  ${t.snippet}`}</Text>
        </Text>
      </View>
    </Pressable>
  )
})

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  dot: { width: 16, alignItems: 'flex-start', alignSelf: 'flex-start', paddingTop: 20 },
  body: { flex: 1, gap: 4 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flex: { flex: 1 },
})
