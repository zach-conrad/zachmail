import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import { useEffect, useState } from 'react'
import {
  AccessibilityInfo,
  View,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native'
import { useTheme } from '../theme/useTheme'

const glass = isLiquidGlassAvailable()

function useReduceTransparency(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    void AccessibilityInfo.isReduceTransparencyEnabled().then(setReduce)
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduce)
    return () => sub.remove()
  }, [])
  return reduce
}

export interface GlassSurfaceProps extends ViewProps {
  /** `prominent` is accent-tinted; only the primary action uses it (design §5.6). */
  variant?: 'regular' | 'prominent'
  shape?: 'capsule' | 'rounded'
  interactive?: boolean
  style?: StyleProp<ViewStyle>
}

/**
 * The one glass primitive (design §5.6), mirroring the web `<Glass>` props. Only for controls that
 * float above mail; never rows or bodies. Falls back to a solid raised surface under Reduce Transparency.
 */
export function GlassSurface({
  variant = 'regular',
  shape = 'capsule',
  interactive = false,
  style,
  children,
  ...rest
}: GlassSurfaceProps) {
  const t = useTheme()
  const reduce = useReduceTransparency()
  const radius = shape === 'capsule' ? t.radius.full : t.radius.lg
  const base: ViewStyle = { borderRadius: radius, overflow: 'hidden' }
  if (!glass || reduce) {
    const bg = variant === 'prominent' ? t.colors.accent : t.colors.surfaceRaised
    return (
      <View
        style={[
          base,
          {
            backgroundColor: bg,
            borderWidth: 1,
            borderColor: t.colors.border,
            boxShadow: t.shadowFloat,
          },
          style,
        ]}
        {...rest}
      >
        {children}
      </View>
    )
  }
  return (
    <GlassView
      glassEffectStyle="regular"
      isInteractive={interactive}
      {...(variant === 'prominent' ? { tintColor: t.colors.accent } : {})}
      style={[base, style]}
      {...rest}
    >
      {children}
    </GlassView>
  )
}
