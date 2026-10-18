import { useEffect, useState } from 'react'

/** Wall clock for relative times, refreshed each minute (row times are minute-granular). */
export function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}
