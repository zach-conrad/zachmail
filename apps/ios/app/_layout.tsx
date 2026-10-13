import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { AppState } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { mail } from '../src/mail/useMail'
import { useTheme } from '../src/theme/useTheme'
import { UndoToast } from '../src/ui/UndoToast'

/** Bring due reminders back on foreground and every minute while open (design §3.6). */
function useReminderWake() {
  useEffect(() => {
    const wake = () => mail.wake(Date.now())
    const id = setInterval(wake, 60_000)
    const sub = AppState.addEventListener('change', (s) => s === 'active' && wake())
    return () => {
      clearInterval(id)
      sub.remove()
    }
  }, [])
}

export default function RootLayout() {
  const t = useTheme()
  useReminderWake()
  const base = t.scheme === 'dark' ? DarkTheme : DefaultTheme
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: t.colors.accent,
      background: t.colors.bg,
      card: t.colors.surface,
      text: t.colors.text,
      border: t.colors.border,
    },
  }
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <ThemeProvider value={navTheme}>
        <Stack
          screenOptions={{
            contentStyle: { backgroundColor: t.colors.bg },
            headerBackButtonDisplayMode: 'minimal',
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="thread/[id]" options={{ headerTransparent: true, title: '' }} />
          <Stack.Screen name="compose" options={{ presentation: 'modal', title: 'New message' }} />
          <Stack.Screen
            name="splits"
            options={{
              presentation: 'formSheet',
              sheetAllowedDetents: [0.55, 1],
              sheetGrabberVisible: true,
              headerShown: false,
            }}
          />
          <Stack.Screen
            name="snooze/[id]"
            options={{
              presentation: 'formSheet',
              sheetAllowedDetents: [0.5],
              sheetGrabberVisible: true,
              headerShown: false,
            }}
          />
        </Stack>
        <UndoToast />
        <StatusBar style="auto" />
      </ThemeProvider>
    </GestureHandlerRootView>
  )
}
