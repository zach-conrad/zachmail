/**
 * Fuzzy score of `query` against `text`, or -1 when it doesn't match. Every query character
 * must appear in order; prefix and word-start hits and runs of adjacent hits score higher.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return 0
  const t = text.toLowerCase()
  if (t.startsWith(q)) return 1000 - t.length
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    if (ch === ' ') continue
    const i = t.indexOf(ch, ti)
    if (i < 0) return -1
    const wordStart = i === 0 || /[\s./-]/.test(t[i - 1]!)
    score += (wordStart ? 10 : 1) + (i === prev + 1 ? 5 : 0)
    prev = i
    ti = i + 1
  }
  return score - t.length / 100
}
