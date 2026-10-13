import * as Haptics from 'expo-haptics'
import { useEffect, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { isLong, LONG, SHORT, swipeAction, type SwipeAction } from '../mail/swipe'
import type { Theme } from '../theme/theme'
import { Icon } from './Icon'

const tick = () => void Haptics.selectionAsync()

/**
 * Swipe triage (design §3.1, §6.3). The gesture and the row's movement run on the UI thread, so a
 * swipe never waits on JS; only the final verb crosses over. Haptic tick at the long threshold.
 */
export function SwipeableRow({
  id,
  theme,
  onAction,
  children,
}: {
  id: string
  theme: Theme
  onAction: (id: string, a: SwipeAction) => void
  children: ReactNode
}) {
  const x = useSharedValue(0)
  const width = useSharedValue(1)
  const long = useSharedValue(false)
  const c = theme.colors
  const exitMs = theme.motion.base

  // FlashList recycles cells: a recycled cell must not inherit a swiped-away offset.
  useEffect(() => {
    x.set(0)
  }, [id, x])

  const commit = (a: SwipeAction) => {
    onAction(id, a)
    // The row has left the list by now; park the offset for when it comes back (undo, recycling).
    if (a === 'done' || a === 'trash') setTimeout(() => x.set(0), exitMs * 2)
  }

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      x.set(e.translationX)
      const l = isLong(e.translationX, width.get())
      if (l !== long.get()) {
        long.set(l)
        scheduleOnRN(tick)
      }
    })
    .onEnd(() => {
      const a = swipeAction(x.get(), width.get())
      long.set(false)
      if (a === 'done' || a === 'trash') {
        x.set(
          withTiming(width.get() * Math.sign(x.get()), { duration: exitMs }, (done) => {
            if (done) scheduleOnRN(commit, a)
          }),
        )
      } else {
        x.set(withSpring(0, { damping: 30, stiffness: 400 }))
        if (a) scheduleOnRN(commit, a)
      }
    })

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }))
  // One background per side; color and icon follow the verb the release would trigger.
  const rightBg = useAnimatedStyle(() => {
    const f = x.get() / width.get()
    return {
      opacity: f > 0 ? 1 : 0,
      backgroundColor: f >= LONG ? c.danger : f >= SHORT ? c.success : c.rowHover,
    }
  })
  const leftBg = useAnimatedStyle(() => {
    const f = x.get() / width.get()
    return {
      opacity: f < 0 ? 1 : 0,
      backgroundColor: f <= -LONG ? c.accent : f <= -SHORT ? c.warning : c.rowHover,
    }
  })
  const doneIcon = useAnimatedStyle(() => ({ opacity: x.get() / width.get() < LONG ? 1 : 0 }))
  const trashIcon = useAnimatedStyle(() => ({ opacity: x.get() / width.get() >= LONG ? 1 : 0 }))
  const snoozeIcon = useAnimatedStyle(() => ({ opacity: x.get() / width.get() > -LONG ? 1 : 0 }))
  const readIcon = useAnimatedStyle(() => ({ opacity: x.get() / width.get() <= -LONG ? 1 : 0 }))

  return (
    <View onLayout={(e) => width.set(Math.max(1, e.nativeEvent.layout.width))}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.bg, styles.start, rightBg]}>
        <View style={styles.icon}>
          <Animated.View style={[styles.layer, doneIcon]}>
            <Icon name="checkmark" size={22} color={theme.onColor} weight="semibold" />
          </Animated.View>
          <Animated.View style={[styles.layer, trashIcon]}>
            <Icon name="trash" size={22} color={theme.onColor} weight="semibold" />
          </Animated.View>
        </View>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, styles.bg, styles.end, leftBg]}>
        <View style={styles.icon}>
          <Animated.View style={[styles.layer, snoozeIcon]}>
            <Icon name="clock" size={22} color={theme.onColor} weight="semibold" />
          </Animated.View>
          <Animated.View style={[styles.layer, readIcon]}>
            <Icon name="envelope.badge" size={22} color={theme.onColor} weight="semibold" />
          </Animated.View>
        </View>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={rowStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  )
}

const styles = StyleSheet.create({
  bg: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24 },
  start: { justifyContent: 'flex-start' },
  end: { justifyContent: 'flex-end' },
  icon: { width: 28, height: 28 },
  layer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
