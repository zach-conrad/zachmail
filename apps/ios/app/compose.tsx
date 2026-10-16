import type { Address } from '@zachhub/core'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { displayName } from '../src/mail/format'
import type { Draft } from '../src/mail/store'
import { mail, useMail } from '../src/mail/useMail'
import { useTheme } from '../src/theme/useTheme'
import { AccountDot } from '../src/ui/AccountDot'

type Mode = 'new' | 'reply' | 'replyAll' | 'forward'

const fmt = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email)

/** Prefill per design §3.4: From = the account that received the thread, else the current scope's. */
function initialDraft(
  mode: Mode,
  threadId: string | undefined,
  restore: string | undefined,
): Draft {
  if (restore) return JSON.parse(restore) as Draft
  const s = mail.getState()
  const detail = threadId ? mail.thread(s, threadId) : null
  const thread = detail?.thread
  const fallback = s.scope !== 'all' ? s.scope : mail.accounts(s)[0]!.id
  if (!thread || mode === 'new')
    return { accountId: fallback, to: '', cc: '', subject: '', body: '' }
  const acc = mail.account(thread.accountId)!
  const msgs = detail.messages
  const last = [...msgs].reverse().find((m) => m.from?.email !== acc.email) ?? msgs.at(-1)
  const base = thread.subject.replace(/^(re|fwd?):\s*/i, '')
  if (mode === 'forward')
    return {
      accountId: acc.id,
      to: '',
      cc: '',
      subject: `Fwd: ${base}`,
      body: `\n\n---------- Forwarded message ----------\nFrom: ${last?.from ? fmt(last.from) : ''}\n\n${last?.snippet ?? ''}`,
      threadId: thread.id,
    }
  const to = last?.from && last.from.email !== acc.email ? [last.from] : (last?.to ?? [])
  const others =
    mode === 'replyAll'
      ? thread.participants.filter(
          (p) => p.email !== acc.email && !to.some((x) => x.email === p.email),
        )
      : []
  return {
    accountId: acc.id,
    to: to.map(fmt).join(', '),
    cc: others.map(fmt).join(', '),
    subject: `Re: ${base}`,
    body: '',
    threadId: thread.id,
  }
}

/** Compose sheet (design §3.4, §6.3). Send goes through the 10 s undo window, never the network. */
export default function Compose() {
  const params = useLocalSearchParams<{ mode?: Mode; threadId?: string; restore?: string }>()
  const t = useTheme()
  const s = useMail()
  const router = useRouter()
  const [initial] = useState(() =>
    initialDraft(params.mode ?? 'new', params.threadId, params.restore),
  )
  const [draft, setDraft] = useState(initial)
  const [showCc, setShowCc] = useState(draft.cc !== '')
  const accounts = mail.accounts(s)
  const from = accounts.find((a) => a.id === draft.accountId)
  const c = t.colors
  const field = [t.type.body, styles.input, { color: c.text }]
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const canSend = draft.to.trim() !== ''
  const dirty =
    params.restore !== undefined ||
    draft.to !== initial.to ||
    draft.cc !== initial.cc ||
    draft.subject !== initial.subject ||
    draft.body !== initial.body

  // Tapping From cycles accounts; each shows its color (design §3.4).
  const cycleFrom = () => {
    const i = accounts.findIndex((a) => a.id === draft.accountId)
    set({ accountId: accounts[(i + 1) % accounts.length]!.id })
  }

  const send = () => {
    mail.send(draft, (d) =>
      router.push({ pathname: '/compose', params: { restore: JSON.stringify(d) } }),
    )
    router.back()
  }

  const cancel = () => {
    if (!dirty) return router.back()
    Alert.alert('Discard this draft?', undefined, [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ])
  }

  return (
    <View style={[styles.flex, { backgroundColor: c.surface }]}>
      <Stack.Screen
        options={{
          title: draft.subject || 'New message',
          unstable_headerLeftItems: () => [
            {
              type: 'button',
              label: 'Cancel',
              icon: { type: 'sfSymbol', name: 'xmark' },
              onPress: cancel,
            },
          ],
          unstable_headerRightItems: () => [
            {
              type: 'button',
              label: 'Send',
              icon: { type: 'sfSymbol', name: 'arrow.up' },
              variant: 'prominent',
              tintColor: c.accent,
              disabled: !canSend,
              onPress: send,
            },
          ],
        }}
      />
      <ScrollView
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
      >
        <Pressable
          style={[styles.row, { borderBottomColor: c.border }]}
          onPress={cycleFrom}
          accessibilityRole="button"
          accessibilityLabel={`From ${from?.email}. Change account`}
        >
          <Text style={[t.type.body, styles.label, { color: c.textFaint }]}>From</Text>
          {from && <AccountDot color={from.color} />}
          <Text style={[t.type.body, { color: c.text }]}>
            {from
              ? `${displayName({ name: from.shortName ?? undefined, email: from.email })} · ${from.email}`
              : ''}
          </Text>
        </Pressable>
        <View style={[styles.row, { borderBottomColor: c.border }]}>
          <Text style={[t.type.body, styles.label, { color: c.textFaint }]}>To</Text>
          <TextInput
            style={field}
            value={draft.to}
            onChangeText={(to) => set({ to })}
            autoFocus={!draft.to}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
          />
          {!showCc && (
            <Pressable onPress={() => setShowCc(true)} hitSlop={8}>
              <Text style={[t.type.meta, { color: c.textMuted }]}>Cc</Text>
            </Pressable>
          )}
        </View>
        {showCc && (
          <View style={[styles.row, { borderBottomColor: c.border }]}>
            <Text style={[t.type.body, styles.label, { color: c.textFaint }]}>Cc</Text>
            <TextInput
              style={field}
              value={draft.cc}
              onChangeText={(cc) => set({ cc })}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
          </View>
        )}
        <View style={[styles.row, { borderBottomColor: c.border }]}>
          <Text style={[t.type.body, styles.label, { color: c.textFaint }]}>Subject</Text>
          <TextInput
            style={field}
            value={draft.subject}
            onChangeText={(subject) => set({ subject })}
          />
        </View>
        <TextInput
          style={[t.type.body, styles.body, { color: c.text }]}
          value={draft.body}
          onChangeText={(body) => set({ body })}
          autoFocus={!!draft.to}
          multiline
          scrollEnabled={false}
          placeholder="Write your message"
          placeholderTextColor={c.textFaint}
        />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    minHeight: 48,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: { width: 64 },
  input: { flex: 1, paddingVertical: 12 },
  body: { minHeight: 320, paddingHorizontal: 16, paddingTop: 16, textAlignVertical: 'top' },
})
