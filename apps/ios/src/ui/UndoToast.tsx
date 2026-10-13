import { Pressable, StyleSheet, Text } from 'react-native'
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { mail, useMail } from '../mail/useMail'
import { useTheme } from '../theme/useTheme'
import { GlassSurface } from './GlassSurface'

/** Bottom glass capsule with Undo (design §3.1, §5.6). Sits above the tab bar. */
export function UndoToast() {
  const { toast } = useMail()
  const t = useTheme()
  const insets = useSafeAreaInsets()
  if (!toast) return null
  return (
    <Animated.View
      key={toast.id}
      entering={FadeInDown.duration(t.motion.base)}
      exiting={FadeOutDown.duration(t.motion.fast)}
      style={[styles.wrap, { bottom: insets.bottom + 96 }]}
      pointerEvents="box-none"
    >
      <GlassSurface style={styles.capsule} accessibilityLiveRegion="polite">
        <Text style={[t.type.row, { color: t.colors.text }]}>{toast.label}</Text>
        {toast.undo && (
          <Pressable
            onPress={() => mail.undoToast()}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Undo"
          >
            <Text style={[t.type.row, { color: t.colors.accent, fontWeight: '600' }]}>Undo</Text>
          </Pressable>
        )}
      </GlassSurface>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
})
