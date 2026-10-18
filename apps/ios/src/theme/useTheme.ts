import { useColorScheme } from 'react-native'
import { themes, type Theme } from './theme'

/** Dark is the default (design §5.1); the system scheme decides, so no context is needed. */
export function useTheme(): Theme {
  return useColorScheme() === 'light' ? themes.light : themes.dark
}
