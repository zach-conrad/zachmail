import { NativeTabs } from 'expo-router/unstable-native-tabs'
import { useTheme } from '../../src/theme/useTheme'

/**
 * Real UITabBar so it renders as Liquid Glass and minimizes on scroll (design §6.3): Inbox,
 * Reminders, Done, plus the separate iOS 26 search tab. Splits live in the inbox title, not tabs.
 */
export default function TabsLayout() {
  const t = useTheme()
  return (
    <NativeTabs tintColor={t.colors.accent} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="inbox">
        <NativeTabs.Trigger.Icon sf={{ default: 'tray', selected: 'tray.fill' }} />
        <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="reminders">
        <NativeTabs.Trigger.Icon sf={{ default: 'clock', selected: 'clock.fill' }} />
        <NativeTabs.Trigger.Label>Reminders</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="done">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'checkmark.circle', selected: 'checkmark.circle.fill' }}
        />
        <NativeTabs.Trigger.Label>Done</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
