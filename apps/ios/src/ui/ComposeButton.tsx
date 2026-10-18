import { useRouter } from 'expo-router'
import { Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme/useTheme'
import { GlassSurface } from './GlassSurface'
import { Icon } from './Icon'

/** Floating 56pt compose button, the one accent-tinted glass control (design §5.6, §6.3). */
export function ComposeButton() {
  const t = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  return (
    <GlassSurface
      variant="prominent"
      interactive
      style={[styles.fab, { bottom: insets.bottom + 64 }]}
    >
      <Pressable
        style={styles.hit}
        onPress={() => router.push('/compose')}
        accessibilityRole="button"
        accessibilityLabel="Compose"
      >
        <Icon name="square.and.pencil" size={22} color={t.onColor} weight="semibold" />
      </Pressable>
    </GlassSurface>
  )
}

const styles = StyleSheet.create({
  fab: { position: 'absolute', right: 20, width: 56, height: 56 },
  hit: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})
