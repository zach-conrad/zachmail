/**
 * Palette matcher: every query character must appear in order. Scores favour word starts and
 * runs of consecutive characters, so "gd" finds "Go to Done" before "Go to Drafts" ranks by order.
 * Returns -1 for no match; higher is better.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const s = text.toLowerCase()
  let score = 0
  let qi = 0
  let prev = -2
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue
    const wordStart = i === 0 || /[\s\-/·]/.test(s[i - 1]!)
    score += 1 + (wordStart ? 3 : 0) + (prev === i - 1 ? 2 : 0)
    prev = i
    qi++
  }
  if (qi < q.length) return -1
  return score - s.length * 0.01
}

/** Items matching `query`, best first; stable for ties. */
export function fuzzyFilter<T>(items: readonly T[], query: string, text: (t: T) => string): T[] {
  if (!query.trim()) return [...items]
  return items
    .map((item, i) => ({ item, i, score: fuzzyScore(query, text(item)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.item)
}
