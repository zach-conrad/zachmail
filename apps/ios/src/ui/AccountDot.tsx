import { View } from 'react-native'
import { accountColor } from '../theme/theme'
import { useTheme } from '../theme/useTheme'

export function AccountDot({ color, size = 8 }: { color: number; size?: number }) {
  const t = useTheme()
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: accountColor(t, color),
      }}
    />
  )
}
