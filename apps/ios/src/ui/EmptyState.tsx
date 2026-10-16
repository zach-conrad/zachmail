import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme/useTheme'

/** Calm zero state (design §3.8): large serif line, quiet subline. */
export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  const t = useTheme()
  return (
    <View style={styles.wrap}>
      <Text style={[t.type.display, { fontFamily: t.font.display, color: t.colors.text }]}>
        {title}
      </Text>
      {subtitle && <Text style={[t.type.body, { color: t.colors.textMuted }]}>{subtitle}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({ wrap: { paddingHorizontal: 24, paddingTop: 96, gap: 8 } })
