/**
 * The iOS theme, generated at startup from hub/tokens/tokens.json (the same source as the web
 * CSS variables), so web, macOS and iOS never drift. Pure: no React Native imports, so it's testable.
 */
import { tokens } from '@zachhub/tokens'

export type Scheme = 'light' | 'dark'
type ColorName = keyof typeof tokens.color
type CamelCase<S extends string> = S extends `${infer H}-${infer T}`
  ? `${H}${Capitalize<CamelCase<T>>}`
  : S
export type Colors = { [K in ColorName as CamelCase<K>]: string }
type Weight = '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900'

export interface TextStyleToken {
  fontSize: number
  lineHeight: number
  fontWeight: Weight
}

export interface Theme {
  scheme: Scheme
  colors: Colors
  /** Account dot colors, indexed by AccountRow.color. */
  account: readonly string[]
  /** Apple platform fonts (design §5.3): SF Pro for UI is the system default, New York for display. */
  font: { ui: undefined; display: string; mono: string }
  type: Record<keyof typeof tokens.type, TextStyleToken>
  space: readonly number[]
  radius: typeof tokens.radius
  rowHeight: number
  motion: { fast: number; base: number; slow: number }
  shadowFloat: string
  /** Icons and text on saturated fills (swipe backgrounds, tinted glass): white in both schemes. */
  onColor: string
}

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** iOS only has 100-step weights; design weights like 450 round down so meta text stays light. */
export const toWeight = (w: number): Weight =>
  String(Math.min(900, Math.max(100, Math.ceil(w / 100 - 0.5) * 100))) as Weight

export function buildTheme(scheme: Scheme): Theme {
  const colors = Object.fromEntries(
    Object.entries(tokens.color).map(([name, v]) => [camel(name), v[scheme]]),
  ) as Colors
  const type = Object.fromEntries(
    Object.entries(tokens.type).map(([name, t]) => [
      name,
      { fontSize: t.size, lineHeight: t.line, fontWeight: toWeight(t.weight) },
    ]),
  ) as Theme['type']
  return {
    scheme,
    colors,
    account: tokens.account,
    font: { ui: undefined, display: 'ui-serif', mono: 'ui-monospace' },
    type,
    space: tokens.space,
    radius: tokens.radius,
    rowHeight: tokens.row.ios,
    motion: { fast: tokens.motion.fast, base: tokens.motion.base, slow: tokens.motion.slow },
    shadowFloat: tokens.shadow.float[scheme],
    onColor: tokens.color['accent-contrast'].light,
  }
}

export const themes = { light: buildTheme('light'), dark: buildTheme('dark') } as const

export function accountColor(theme: Theme, color: number): string {
  return theme.account[color % theme.account.length]!
}
