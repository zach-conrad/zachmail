import tokens from '../tokens.json'

export type Tokens = typeof tokens
export type ColorToken = keyof Tokens['color']

export { tokens }

/** Stable color for the Nth connected account. */
export function accountColor(index: number): string {
  return tokens.account[index % tokens.account.length]!
}
