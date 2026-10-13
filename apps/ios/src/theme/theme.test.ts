import { describe, expect, it } from 'vitest'
import { tokens } from '@zachmail/tokens'
import { accountColor, themes, toWeight } from './theme'

describe('theme', () => {
  it('maps every color token for both schemes', () => {
    expect(Object.keys(themes.dark.colors)).toHaveLength(Object.keys(tokens.color).length)
    expect(themes.dark.colors.bg).toBe(tokens.color.bg.dark)
    expect(themes.light.colors.textMuted).toBe(tokens.color['text-muted'].light)
    expect(themes.light.colors.accentContrast).toBe(tokens.color['accent-contrast'].light)
  })

  it('uses the iOS row height and type scale', () => {
    expect(themes.dark.rowHeight).toBe(72)
    expect(themes.dark.type.subject).toEqual({ fontSize: 22, lineHeight: 28, fontWeight: '600' })
  })

  it('rounds design weights to iOS weights, halves down', () => {
    expect(toWeight(450)).toBe('400')
    expect(toWeight(600)).toBe('600')
    expect(toWeight(1000)).toBe('900')
  })

  it('wraps account colors', () => {
    expect(accountColor(themes.dark, tokens.account.length)).toBe(tokens.account[0])
  })
})
